import { NextResponse } from 'next/server';
import { AppointmentsService } from '@/services/appointments.service';
import { AvailabilityService } from '@/services/availability.service';
import { ApiResponseBuilder } from '@/lib/api-response';
import { handleError } from '@/lib/error-handler';
import { AppError } from '@/lib/errors';
import { createAdminClient } from '@/lib/supabase/admin';
import { z } from 'zod';

const rescheduleSchema = z.object({
    // Identificar al paciente (al menos uno obligatorio)
    patient_phone: z.string().min(6).optional(),
    patient_name: z.string().min(2).optional(),

    // Nuevos datos de la cita (al menos uno obligatorio)
    starts_at: z.string().datetime({ offset: true, message: 'starts_at must be an ISO datetime string (e.g. 2026-03-03T10:00:00-03:00 or 2026-03-03T13:00:00Z)' }).optional(),
    service_name: z.string().min(1).optional(),
    notes: z.string().optional(),
    status: z.enum(['scheduled', 'confirmed', 'cancelled', 'completed', 'no_show']).optional(),
});

/**
 * PATCH /api/v1/appointments/reschedule
 *
 * Reagenda o actualiza la cita programada de un paciente.
 * Identifica la cita por teléfono o nombre del paciente (cada paciente solo tiene 1 cita scheduled).
 *
 * Entrada:
 *   - patient_phone o patient_name (para identificar al paciente)
 *   - starts_at (nueva hora, activa reagendamiento atómico)
 *   - service_name (nuevo servicio, activa reagendamiento atómico)
 *   - notes (actualizar notas)
 *   - status (cambiar estado: cancelled, completed, no_show, etc.)
 *
 * Status posibles: scheduled, confirmed, cancelled, completed, no_show
 */
export async function PATCH(request: Request) {
    try {
        const body = await request.json();
        const validatedData = rescheduleSchema.parse(body);

        const { patient_phone, patient_name, service_name, ...updateFields } = validatedData;

        // 1. Validate: at least one patient identifier
        if (!patient_phone && !patient_name) {
            throw new AppError(
                'Debes enviar patient_phone o patient_name para identificar al paciente',
                400,
                'MISSING_PATIENT_IDENTIFIER'
            );
        }

        const supabase = createAdminClient();

        // 2. Find the patient
        let patientQuery = supabase.from('patients').select('id, full_name').is('deleted_at', null);

        if (patient_phone) {
            patientQuery = patientQuery.eq('phone', patient_phone);
        } else if (patient_name) {
            patientQuery = patientQuery.ilike('full_name', `%${patient_name}%`);
        }

        const { data: patients, error: patientError } = await patientQuery;

        if (patientError || !patients || patients.length === 0) {
            throw new AppError(
                `Paciente no encontrado${patient_phone ? ` con teléfono ${patient_phone}` : ` con nombre "${patient_name}"`}`,
                404,
                'PATIENT_NOT_FOUND'
            );
        }

        if (patients.length > 1) {
            const names = patients.map(p => p.full_name).join(', ');
            throw new AppError(
                `Se encontraron ${patients.length} pacientes: ${names}. Usa el teléfono para ser más específico.`,
                409,
                'MULTIPLE_PATIENTS_FOUND'
            );
        }

        const patient = patients[0];

        // 3. Find their next scheduled appointment (nearest upcoming)
        const { data: appointments, error: apptError } = await supabase
            .from('appointments')
            .select('id, status, starts_at, service_id, services(name)')
            .eq('patient_id', patient.id)
            .eq('status', 'scheduled')
            .gte('starts_at', new Date().toISOString())
            .order('starts_at', { ascending: true })
            .limit(1);

        const appointment = appointments?.[0];

        if (apptError || !appointment) {
            throw new AppError(
                `${patient.full_name} no tiene citas programadas`,
                404,
                'NO_SCHEDULED_APPOINTMENT'
            );
        }

        // 4. Resolve service_name to service_id if provided
        let serviceId: string | undefined;
        if (service_name) {
            const { data: service, error: svcError } = await supabase
                .from('services')
                .select('id')
                .ilike('name', service_name)
                .single();

            if (svcError || !service) {
                throw new AppError(
                    `Servicio "${service_name}" no encontrado`,
                    404,
                    'SERVICE_NOT_FOUND'
                );
            }
            serviceId = service.id;
        }

        // 5. Build update payload
        const targetServiceId = serviceId || (appointment as any).service_id;
        const updatePayload = {
            ...updateFields,
            ...(serviceId ? { service_id: serviceId } : {}),
        };

        // 6. Update the appointment (Atomic reschedule handles engine allocation internally)
        let updated;
        try {
            updated = await AppointmentsService.updateAppointment(appointment.id, updatePayload);
        } catch (error: any) {
            // Translate engine errors to AI-friendly messages if they came from AvailabilityService
            if (validatedData.starts_at && targetServiceId && error instanceof AppError) {
                const engineCode = error.code;
                if (['CLINIC_BLOCKED', 'RESOURCE_BUSY', 'PROFESSIONAL_BUSY', 'SERVICE_INACTIVE'].includes(engineCode)) {
                    const requestedTime = new Date(validatedData.starts_at);
                    let reason = 'El horario solicitado no está disponible.';

                    switch (engineCode) {
                        case 'CLINIC_BLOCKED':
                            reason = 'La clínica está cerrada o bloqueada en ese horario.';
                            break;
                        case 'RESOURCE_BUSY':
                            reason = 'No hay disponibilidad de espacio físico (boxes o cámaras) a esa hora.';
                            break;
                        case 'PROFESSIONAL_BUSY':
                            reason = 'Nuestros profesionales ya están al límite de su capacidad en ese horario. La cita no cabe completa antes de que termine el turno.';
                            break;
                        case 'SERVICE_INACTIVE':
                            reason = 'Este servicio no está disponible actualmente.';
                            break;
                    }

                    // Suggest alternatives
                    const requestedDate = requestedTime.toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
                    let suggestion = '';
                    try {
                        const smartAvail = await AvailabilityService.getSmartAvailability(targetServiceId, requestedDate);
                        if (smartAvail && smartAvail.ai_hint) {
                            suggestion = ` ${smartAvail.ai_hint}`;
                        }
                    } catch { /* ignore if smart avail also fails */ }

                    throw new AppError(
                        `${reason}${suggestion}`,
                        409,
                        'SLOT_NOT_AVAILABLE'
                    );
                }
            }
            throw error; // Re-throw if it wasn't an engine availability error
        }

        // 7. Fetch full appointment data for the AI-friendly response
        const { data: fullAppt } = await supabase
            .from('appointments')
            .select('id, status, starts_at, ends_at, notes, patients(full_name, phone), services(name), appointment_allocations(profiles:professional_id(full_name))')
            .eq('id', appointment.id)
            .single();

        const appt = fullAppt || updated;
        const patientFullName = (appt as any).patients?.full_name || patient.full_name;
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
            })
        );
    } catch (error) {
        return handleError(error);
    }
}
