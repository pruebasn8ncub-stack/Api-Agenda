import { createAdminClient as createClient } from '@/lib/supabase/admin';
import { CreateAppointmentRequestDTO, Appointment } from '@/types';
import { AppError } from '@/lib/errors';
import { parseISO, isBefore } from 'date-fns';
import { AvailabilityService } from './availability.service';

/**
 * Appointment lifecycle:
 *
 *   create  → status: 'scheduled'
 *   reschedule → new starts_at/ends_at + new allocations (atomic)
 *   change service → new service_id + recalculated allocations (atomic)
 *   cancel → status: 'cancelled' (resources freed immediately)
 *   complete → status: 'completed'
 *   no_show → status: 'no_show'
 *   update notes/status → simple field update (no reallocation)
 */
export class AppointmentsService {

    /**
     * Fetch all appointments, optionally filtered by professional and date range.
     * Includes patient info, service info, and all phase allocations.
     */
    static async getAppointments(
        professionalId?: string,
        startDate?: string,
        endDate?: string
    ): Promise<Appointment[]> {
        const supabase = createClient();

        let query = supabase
            .from('appointments')
            .select(`
                *, 
                patients(*), 
                services(*),
                appointment_allocations(
                    id,
                    service_phase_id,
                    professional_id, 
                    physical_resource_id,
                    starts_at,
                    ends_at,
                    profiles:professional_id(full_name),
                    physical_resources:physical_resource_id(name, type),
                    service_phases:service_phase_id(phase_order, duration_minutes, requires_resource_type, label, sub_services:services!service_phases_sub_service_id_fkey(name, color))
                )
            `)
            .order('starts_at', { ascending: true });

        if (professionalId) {
            query = query.eq('appointment_allocations.professional_id', professionalId);
        }
        if (startDate) {
            query = query.gte('starts_at', startDate);
        }
        if (endDate) {
            query = query.lte('starts_at', endDate);
        }

        const { data, error } = await query;

        if (error) {
            throw new AppError(error.message, 500, 'DB_FETCH_ERROR');
        }

        return data;
    }

    /**
     * Create a new appointment using the Multiphase Concurrent Capacity Engine.
     *
     * Flow:
     * 1. Validate the start time is not in the past
     * 2. Call the engine to allocate resources for ALL phases
     * 3. Insert the appointment record
     * 4. Insert all phase allocations (one per phase)
     * 5. Return the full appointment with allocations
     */
    static async createAppointment(payload: CreateAppointmentRequestDTO): Promise<Appointment> {
        const start = parseISO(payload.starts_at);
        const now = new Date();

        if (isBefore(start, now)) {
            throw new AppError('No se puede agendar en el pasado', 400, 'INVALID_TIME_RANGE');
        }

        // 1. Engine: allocate resources for ALL phases
        const { allocations, ends_at } = await AvailabilityService.allocateResourcesForService(
            payload.service_id,
            start
        );

        const supabase = createClient();

        // 2. Insert the appointment
        const { data: appointment, error: apptError } = await supabase
            .from('appointments')
            .insert([{
                patient_id: payload.patient_id,
                service_id: payload.service_id,
                starts_at: start.toISOString(),
                ends_at: ends_at.toISOString(),
                status: 'scheduled',
                notes: payload.notes,
            }])
            .select()
            .single();

        if (apptError) {
            throw new AppError(apptError.message, 500, 'DB_INSERT_ERROR');
        }

        // 3. Insert all phase allocations
        const allocationRows = allocations.map(alloc => ({
            appointment_id: appointment.id,
            service_phase_id: alloc.service_phase_id,
            professional_id: alloc.professional_id,
            physical_resource_id: alloc.physical_resource_id,
            starts_at: alloc.starts_at,
            ends_at: alloc.ends_at,
        }));

        const { error: allocError } = await supabase
            .from('appointment_allocations')
            .insert(allocationRows);

        if (allocError) {
            // Rollback: delete the appointment if allocations fail
            await supabase.from('appointments').delete().eq('id', appointment.id);
            throw new AppError(
                'Error al bloquear los recursos. Intenta de nuevo.',
                500,
                'ALLOCATION_ERROR'
            );
        }

        return { ...appointment, allocations };
    }

    /**
     * Reschedule an appointment to a new time, or change its service.
     *
     * This is an ATOMIC operation with rollback:
     *   1. Load the existing appointment and snapshot its data
     *   2. Temporarily cancel it (so the engine doesn't see it as "occupied")
     *   3. Run the allocation engine for the new time/service
     *   4. Delete old allocations
     *   5. Insert new allocations
     *   6. Update the appointment record with new times
     *   7. If ANYTHING fails → restore original data (rollback)
     *
     * @param id - Appointment UUID
     * @param payload - Must include at least `starts_at` and/or `service_id`
     */
    static async rescheduleAppointment(
        id: string,
        payload: { starts_at?: string; service_id?: string; notes?: string }
    ): Promise<Appointment> {
        const supabase = createClient();

        // ── 1. Load existing appointment ──────────────────────────────
        const { data: existing, error: loadErr } = await supabase
            .from('appointments')
            .select('*')
            .eq('id', id)
            .single();

        if (loadErr || !existing) {
            throw new AppError('Cita no encontrada', 404, 'APPOINTMENT_NOT_FOUND');
        }

        if (existing.status === 'cancelled') {
            throw new AppError('No se puede reagendar una cita cancelada', 409, 'APPOINTMENT_CANCELLED');
        }

        if (existing.status === 'completed') {
            throw new AppError('No se puede reagendar una cita completada', 409, 'APPOINTMENT_COMPLETED');
        }

        // Determine what's changing
        const newServiceId = payload.service_id || existing.service_id;
        const newStartsAt = payload.starts_at || existing.starts_at;
        const newStart = parseISO(newStartsAt);

        if (isBefore(newStart, new Date())) {
            throw new AppError('No se puede reagendar al pasado', 400, 'INVALID_TIME_RANGE');
        }

        // Snapshot original data for rollback
        const originalData = {
            service_id: existing.service_id,
            starts_at: existing.starts_at,
            ends_at: existing.ends_at,
            status: existing.status,
        };

        // ── 2. Load existing allocations (snapshot for rollback) ──────
        const { data: oldAllocations } = await supabase
            .from('appointment_allocations')
            .select('*')
            .eq('appointment_id', id);

        // ── 3. Temporarily mark as cancelled so engine ignores it ─────
        const { error: tempCancelErr } = await supabase
            .from('appointments')
            .update({ status: 'cancelled' })
            .eq('id', id);

        if (tempCancelErr) {
            throw new AppError('Error interno al preparar reagendamiento', 500, 'RESCHEDULE_PREP_ERROR');
        }

        try {
            // ── 4. Run allocation engine for the new time/service ─────
            const { allocations, ends_at } = await AvailabilityService.allocateResourcesForService(
                newServiceId,
                newStart
            );

            // ── 5. Delete old allocations ────────────────────────────
            const { error: deleteAllocErr } = await supabase
                .from('appointment_allocations')
                .delete()
                .eq('appointment_id', id);

            if (deleteAllocErr) {
                throw new Error('Error eliminando allocations anteriores');
            }

            // ── 6. Insert new allocations ────────────────────────────
            const newAllocationRows = allocations.map(alloc => ({
                appointment_id: id,
                service_phase_id: alloc.service_phase_id,
                professional_id: alloc.professional_id,
                physical_resource_id: alloc.physical_resource_id,
                starts_at: alloc.starts_at,
                ends_at: alloc.ends_at,
            }));

            const { error: insertAllocErr } = await supabase
                .from('appointment_allocations')
                .insert(newAllocationRows);

            if (insertAllocErr) {
                throw new Error('Error insertando nuevas allocations');
            }

            // ── 7. Update appointment record ─────────────────────────
            const updateFields: Record<string, any> = {
                service_id: newServiceId,
                starts_at: newStart.toISOString(),
                ends_at: ends_at.toISOString(),
                status: 'scheduled', // Re-activate with 'scheduled' status
            };

            if (payload.notes !== undefined) {
                updateFields.notes = payload.notes;
            }

            const { data: updated, error: updateErr } = await supabase
                .from('appointments')
                .update(updateFields)
                .eq('id', id)
                .select()
                .single();

            if (updateErr) {
                throw new Error('Error actualizando la cita');
            }

            return { ...updated, allocations };

        } catch (engineError: any) {
            // ══════════════════════════════════════════════════════════
            //  ROLLBACK: Restore original state
            // ══════════════════════════════════════════════════════════

            // Restore appointment to original state
            await supabase
                .from('appointments')
                .update(originalData)
                .eq('id', id);

            // Restore original allocations (if they were deleted)
            if (oldAllocations && oldAllocations.length > 0) {
                // Check if allocations still exist
                const { data: currentAllocs } = await supabase
                    .from('appointment_allocations')
                    .select('id')
                    .eq('appointment_id', id);

                if (!currentAllocs || currentAllocs.length === 0) {
                    // Re-insert original allocations (without the id — let DB generate new ones)
                    const restoreRows = oldAllocations.map(a => ({
                        appointment_id: a.appointment_id,
                        service_phase_id: a.service_phase_id,
                        professional_id: a.professional_id,
                        physical_resource_id: a.physical_resource_id,
                        starts_at: a.starts_at,
                        ends_at: a.ends_at,
                    }));
                    await supabase.from('appointment_allocations').insert(restoreRows);
                }
            }

            // Re-throw with a user-friendly message
            if (engineError instanceof AppError) {
                throw engineError;
            }

            throw new AppError(
                `No se pudo reagendar: ${engineError.message}. La cita original se mantuvo sin cambios.`,
                409,
                'RESCHEDULE_FAILED'
            );
        }
    }

    /**
     * Update appointment fields that do NOT require reallocation.
     * For status changes, notes, etc.
     *
     * If `starts_at` or `service_id` are included, this method
     * automatically delegates to rescheduleAppointment.
     *
     * Business rules for status transitions:
     *   - Cannot mark as 'completed' or 'no_show' if starts_at is in the future
     *   - Cannot transition from 'cancelled' to any other status
     *   - Cannot transition from 'completed' to 'scheduled'
     */
    static async updateAppointment(id: string, payload: any): Promise<Appointment> {
        // If the update touches scheduling fields, delegate to reschedule
        if (payload.starts_at || payload.service_id) {
            return this.rescheduleAppointment(id, payload);
        }

        const supabase = createClient();

        // If status is being changed, validate the transition
        if (payload.status) {
            const { data: existing, error: loadErr } = await supabase
                .from('appointments')
                .select('id, status, starts_at, ends_at')
                .eq('id', id)
                .single();

            if (loadErr || !existing) {
                throw new AppError('Cita no encontrada', 404, 'APPOINTMENT_NOT_FOUND');
            }

            const now = new Date();
            const appointmentStart = new Date(existing.starts_at);

            // Rule: Cannot mark as 'completed' or 'no_show' if the appointment hasn't started yet
            if (
                (payload.status === 'completed' || payload.status === 'no_show') &&
                isBefore(now, appointmentStart)
            ) {
                throw new AppError(
                    `No se puede marcar como "${payload.status === 'completed' ? 'completada' : 'no asistió'}" una cita que aún no ha comenzado`,
                    422,
                    'INVALID_STATUS_TRANSITION'
                );
            }

            // Rule: Cannot transition out of 'cancelled'
            if (existing.status === 'cancelled' && payload.status !== 'cancelled') {
                throw new AppError(
                    'No se puede cambiar el estado de una cita cancelada. Crea una nueva cita.',
                    409,
                    'APPOINTMENT_CANCELLED'
                );
            }

            // Rule: Cannot go back to 'scheduled' from 'completed'
            if (existing.status === 'completed' && payload.status === 'scheduled') {
                throw new AppError(
                    'No se puede revertir una cita completada a agendada',
                    409,
                    'INVALID_STATUS_TRANSITION'
                );
            }
        }

        // Simple field update (status, notes, etc.)
        const { data, error } = await supabase
            .from('appointments')
            .update({ ...payload, updated_at: new Date().toISOString() })
            .eq('id', id)
            .select()
            .single();

        if (error) {
            throw new AppError(error.message, 500, 'DB_UPDATE_ERROR');
        }

        return data;
    }

    /**
     * Cancel an appointment (soft cancel — marks as 'cancelled').
     * Resources are released because the engine ignores cancelled appointments.
     */
    static async deleteAppointment(id: string): Promise<void> {
        const supabase = createClient();

        // Verify the appointment exists
        const { data: existing, error: loadErr } = await supabase
            .from('appointments')
            .select('id, status')
            .eq('id', id)
            .single();

        if (loadErr || !existing) {
            throw new AppError('Cita no encontrada', 404, 'APPOINTMENT_NOT_FOUND');
        }

        if (existing.status === 'cancelled') {
            throw new AppError('La cita ya está cancelada', 409, 'ALREADY_CANCELLED');
        }

        const { error } = await supabase
            .from('appointments')
            .update({ status: 'cancelled' })
            .eq('id', id);

        if (error) {
            throw new AppError(error.message, 500, 'DB_DELETE_ERROR');
        }
    }
}
