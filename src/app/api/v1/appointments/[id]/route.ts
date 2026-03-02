import { NextResponse } from 'next/server';
import { AppointmentsService } from '@/services/appointments.service';
import { AvailabilityService } from '@/services/availability.service';
import { ApiResponseBuilder } from '@/lib/api-response';
import { handleError } from '@/lib/error-handler';
import { AppError } from '@/lib/errors';
import { createAdminClient } from '@/lib/supabase/admin';
import { z } from 'zod';

const updateAppointmentSchema = z.object({
    // Scheduling fields (trigger reallocation if changed)
    starts_at: z.string().datetime({ offset: true, message: 'starts_at must be an ISO datetime string' }).optional(),
    service_name: z.string().min(1, 'Service name is required').optional(),

    // Simple fields (no reallocation needed)
    status: z.enum(['scheduled', 'confirmed', 'cancelled', 'completed', 'no_show']).optional(),
    notes: z.string().optional(),
});

/**
 * PATCH /api/v1/appointments/:id
 *
 * Smart update:
 * - If `starts_at` or `service_name` change → triggers atomic reschedule with rollback
 * - If only `status`, `notes` change → simple field update
 * - Cancelling via status='cancelled' releases all resources automatically
 *
 * Status posibles: scheduled, confirmed, cancelled, completed, no_show
 */
export async function PATCH(
    request: Request,
    { params }: { params: { id: string } }
) {
    try {
        const id = params.id;
        const body = await request.json();
        const validatedData = updateAppointmentSchema.parse(body);

        const supabase = createAdminClient();

        // If service_name is provided, resolve it to service_id
        let serviceId: string | undefined;
        let finalServiceName = validatedData.service_name || undefined;

        if (validatedData.service_name) {
            const { data: service, error } = await supabase
                .from('services')
                .select('id, name')
                .ilike('name', validatedData.service_name)
                .single();

            if (error || !service) {
                throw new AppError(
                    `Servicio "${validatedData.service_name}" no encontrado`,
                    404,
                    'SERVICE_NOT_FOUND'
                );
            }
            serviceId = service.id;
            finalServiceName = service.name;
        }

        // Build the payload for the service (using service_id, not service_name)
        const { service_name, ...rest } = validatedData;
        const updatePayload = {
            ...rest,
            ...(serviceId ? { service_id: serviceId } : {}),
        };

        let updated;
        try {
            updated = await AppointmentsService.updateAppointment(id, updatePayload);
        } catch (error: any) {
            // Translate engine errors to AI-friendly messages if they came from AvailabilityService
            if (error instanceof AppError && ['CLINIC_BLOCKED', 'RESOURCE_BUSY', 'PROFESSIONAL_BUSY', 'SERVICE_INACTIVE'].includes(error.code)) {
                // Determine target service for hints
                let targetServiceId = serviceId;
                let targetServiceStartsAtStr = validatedData.starts_at;

                // Fallback to original appointment to provide hints
                const { data: origApp } = await supabase.from('appointments').select('service_id, starts_at').eq('id', id).single();
                if (!targetServiceId && origApp) targetServiceId = origApp.service_id;
                if (!targetServiceStartsAtStr && origApp) targetServiceStartsAtStr = origApp.starts_at;

                if (targetServiceStartsAtStr && targetServiceId) {
                    const requestedTime = new Date(targetServiceStartsAtStr);
                    let reason = 'El horario solicitado no está disponible.';
                    switch (error.code) {
                        case 'CLINIC_BLOCKED': reason = 'La clínica está cerrada o bloqueada en ese horario.'; break;
                        case 'RESOURCE_BUSY': reason = 'No hay disponibilidad de espacio físico (boxes o cámaras) a esa hora.'; break;
                        case 'PROFESSIONAL_BUSY': reason = 'Nuestros profesionales ya están al límite de su capacidad en ese horario.'; break;
                        case 'SERVICE_INACTIVE': reason = 'Este servicio no está disponible actualmente.'; break;
                    }

                    let suggestion = '';
                    try {
                        const requestedDate = requestedTime.toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
                        const smartAvail = await AvailabilityService.getSmartAvailability(targetServiceId, requestedDate);
                        if (smartAvail && smartAvail.ai_hint) suggestion = ` ${smartAvail.ai_hint}`;
                    } catch { /* ignore */ }

                    throw new AppError(`${reason}${suggestion}`, 409, 'SLOT_NOT_AVAILABLE');
                }
            }
            throw error;
        }

        // Fetch full appointment data for the AI-friendly response
        const { data: fullAppt } = await supabase
            .from('appointments')
            .select('id, status, starts_at, ends_at, notes, patients(full_name, phone), services(name), appointment_allocations(profiles:professional_id(full_name))')
            .eq('id', updated.id)
            .single();

        const appt = fullAppt || updated;
        const patientFullName = (appt as any).patients?.full_name || 'Paciente';
        const serviceName = (appt as any).services?.name || 'desconocido';
        const professional = (appt as any).appointment_allocations?.[0]?.profiles?.full_name || 'por asignar';
        const startsAt = new Date(appt.starts_at);
        const dateStr = startsAt.toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        const timeStr = startsAt.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false });
        const statusLabels: Record<string, string> = {
            scheduled: 'agendada',
            confirmed: 'confirmada',
            cancelled: 'cancelada',
            completed: 'completada',
            no_show: 'no asistió',
        };
        const statusLabel = statusLabels[appt.status] || appt.status;

        // Build AI summary based on what changed
        let aiSummary = '';
        if (validatedData.status === 'cancelled') {
            aiSummary = `La cita de ${patientFullName} para ${serviceName} ha sido cancelada exitosamente.`;
        } else if (validatedData.starts_at || validatedData.service_name) {
            aiSummary = `La cita de ${patientFullName} ha sido reagendada exitosamente. Nueva cita: ${serviceName} el ${dateStr} a las ${timeStr} hrs con ${professional}.`;
        } else {
            aiSummary = `La cita de ${patientFullName} ha sido actualizada. Cita actual: ${serviceName} el ${dateStr} a las ${timeStr} hrs, estado: ${statusLabel}.`;
        }

        return NextResponse.json(
            ApiResponseBuilder.success({
                ai_summary: aiSummary,
                paciente: patientFullName,
                servicio: serviceName,
                profesional: professional,
                fecha: dateStr,
                hora: timeStr,
                estado: statusLabel,
                notas: appt.notes || null,
                appointment_id: appt.id,
                ...updated
            })
        );
    } catch (error) {
        return handleError(error);
    }
}
