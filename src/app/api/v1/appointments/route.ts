import { NextResponse } from 'next/server';
import { AppointmentsService } from '@/services/appointments.service';
import { AvailabilityService } from '@/services/availability.service';
import { ApiResponseBuilder } from '@/lib/api-response';
import { handleError } from '@/lib/error-handler';
import { AppError } from '@/lib/errors';
import { createAdminClient } from '@/lib/supabase/admin';
import { z } from 'zod';

const createAppointmentSchema = z.object({
    patient_id: z.string().uuid().optional(),
    patient_phone: z.string().min(6).optional(),
    patient_name: z.string().min(2).optional(),

    service_id: z.string().uuid().optional(),
    service_name: z.string().min(1).optional(),

    starts_at: z.string().datetime({ offset: true, message: 'starts_at must be an ISO datetime string' }),
    notes: z.string().optional()
});

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const professionalId = searchParams.get('professional_id') || undefined;
        const startDate = searchParams.get('start_date') || undefined;
        const endDate = searchParams.get('end_date') || undefined;

        const appointments = await AppointmentsService.getAppointments(professionalId, startDate, endDate);

        return NextResponse.json(
            ApiResponseBuilder.success(appointments, { total: appointments.length })
        );
    } catch (error) {
        // Safe standard error handling
        return handleError(error);
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const validatedData = createAppointmentSchema.parse(body);

        const supabase = createAdminClient();
        let patientId = validatedData.patient_id;
        let finalPatientName = validatedData.patient_name || '';

        // 1. Resolve Patient
        if (!patientId) {
            if (!validatedData.patient_phone && !validatedData.patient_name) {
                throw new AppError('Debes enviar patient_id, patient_phone o patient_name', 400, 'MISSING_PATIENT_IDENTIFIER');
            }

            let patientQuery = supabase.from('patients').select('id, full_name').is('deleted_at', null);

            if (validatedData.patient_phone) {
                patientQuery = patientQuery.eq('phone', validatedData.patient_phone);
            } else if (validatedData.patient_name) {
                patientQuery = patientQuery.ilike('full_name', `%${validatedData.patient_name}%`);
            }

            const { data: patients, error: patientError } = await patientQuery;

            if (patientError || !patients || patients.length === 0) {
                throw new AppError('Paciente no encontrado con esos datos. ¿Está registrado?', 404, 'PATIENT_NOT_FOUND');
            }

            if (patients.length > 1) {
                const names = patients.map(p => p.full_name).join(', ');
                throw new AppError(`Se encontraron ${patients.length} pacientes: ${names}. Usa el teléfono o UUID para ser específico.`, 409, 'MULTIPLE_PATIENTS_FOUND');
            }

            patientId = patients[0].id;
            finalPatientName = patients[0].full_name;
        } else {
            const { data: pt } = await supabase.from('patients').select('full_name').eq('id', patientId).single();
            if (pt) finalPatientName = pt.full_name;
        }

        // 2. Resolve Service
        let serviceId = validatedData.service_id;
        let finalServiceName = validatedData.service_name || '';

        if (!serviceId) {
            if (!validatedData.service_name) {
                throw new AppError('Debes enviar service_id o service_name', 400, 'MISSING_SERVICE_IDENTIFIER');
            }

            const { data: service, error: svcError } = await supabase
                .from('services')
                .select('id, name')
                .ilike('name', validatedData.service_name)
                .single();

            if (svcError || !service) {
                throw new AppError(`Servicio "${validatedData.service_name}" no encontrado`, 404, 'SERVICE_NOT_FOUND');
            }
            serviceId = service.id;
            finalServiceName = service.name;
        } else {
            const { data: svc } = await supabase.from('services').select('name').eq('id', serviceId).single();
            if (svc) finalServiceName = svc.name;
        }

        // 3. Create Appointment with Engine Validation Capture
        let newAppointment;
        try {
            newAppointment = await AppointmentsService.createAppointment({
                patient_id: patientId as string,
                service_id: serviceId as string,
                starts_at: validatedData.starts_at,
                notes: validatedData.notes
            });
        } catch (error: any) {
            if (error instanceof AppError && ['CLINIC_BLOCKED', 'RESOURCE_BUSY', 'PROFESSIONAL_BUSY', 'SERVICE_INACTIVE'].includes(error.code)) {
                const requestedTime = new Date(validatedData.starts_at);
                let reason = 'El horario solicitado no está disponible.';

                switch (error.code) {
                    case 'CLINIC_BLOCKED': reason = 'La clínica está cerrada o bloqueada en ese horario.'; break;
                    case 'RESOURCE_BUSY': reason = 'No hay boxes/cámaras disponibles a esa hora.'; break;
                    case 'PROFESSIONAL_BUSY': reason = 'Nuestros profesionales están al límite de su capacidad en ese horario.'; break;
                    case 'SERVICE_INACTIVE': reason = 'Este servicio no está disponible actualmente.'; break;
                }

                let suggestion = '';
                try {
                    const requestedDate = requestedTime.toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
                    const smartAvail = await AvailabilityService.getSmartAvailability(serviceId as string, requestedDate);
                    if (smartAvail && smartAvail.ai_hint) suggestion = ` ${smartAvail.ai_hint}`;
                } catch { /* ignore */ }

                throw new AppError(`${reason}${suggestion}`, 409, 'SLOT_NOT_AVAILABLE');
            }
            throw error; // Re-throw unhandled errors
        }

        // 4. Build AI Friendly Response
        const startsAt = new Date(newAppointment.starts_at);
        const dateStr = startsAt.toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        const timeStr = startsAt.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false });

        // Grab the professional from allocations
        let professional = 'por asignar';
        if ((newAppointment as any).allocations && (newAppointment as any).allocations.length > 0) {
            const { data: profData } = await supabase.from('profiles')
                .select('full_name')
                .eq('id', (newAppointment as any).allocations[0].professional_id)
                .single();
            if (profData) professional = profData.full_name;
        }

        const aiSummary = `Cita creada exitosamente para ${finalPatientName}. Servicio: ${finalServiceName} el ${dateStr} a las ${timeStr} hrs con ${professional}.`;

        return NextResponse.json(
            ApiResponseBuilder.success({
                ai_summary: aiSummary,
                paciente: finalPatientName,
                servicio: finalServiceName,
                profesional: professional,
                fecha: dateStr,
                hora: timeStr,
                estado: newAppointment.status,
                notas: newAppointment.notes || null,
                appointment_id: newAppointment.id,
                ...newAppointment
            }),
            { status: 201 }
        );
    } catch (error) {
        return handleError(error);
    }
}
