import { NextResponse } from 'next/server';
import { AppointmentsService } from '@/services/appointments.service';
import { ApiResponseBuilder } from '@/lib/api-response';
import { handleError } from '@/lib/error-handler';
import { z } from 'zod';

const createAppointmentSchema = z.object({
    patient_id: z.string().uuid('Invalid patient ID'),
    service_id: z.string().uuid('Invalid service ID'), // NEW: Service driven instead of professional driven
    starts_at: z.string().datetime('starts_at must be an ISO datetime string'),
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

        const newAppointment = await AppointmentsService.createAppointment(validatedData);

        return NextResponse.json(
            ApiResponseBuilder.success(newAppointment),
            { status: 201 }
        );
    } catch (error) {
        return handleError(error);
    }
}
