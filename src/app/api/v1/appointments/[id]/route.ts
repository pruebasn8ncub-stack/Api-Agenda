import { NextResponse } from 'next/server';
import { AppointmentsService } from '@/services/appointments.service';
import { ApiResponseBuilder } from '@/lib/api-response';
import { handleError } from '@/lib/error-handler';
import { z } from 'zod';

const updateAppointmentSchema = z.object({
    // Scheduling fields (trigger reallocation if changed)
    starts_at: z.string().datetime('starts_at must be an ISO datetime string').optional(),
    service_id: z.string().uuid('Invalid service ID').optional(),

    // Simple fields (no reallocation needed)
    status: z.enum(['scheduled', 'confirmed', 'cancelled', 'completed', 'no_show']).optional(),
    notes: z.string().optional(),
});

/**
 * PATCH /api/v1/appointments/:id
 *
 * Smart update:
 * - If `starts_at` or `service_id` change → triggers atomic reschedule with rollback
 * - If only `status`, `notes` change → simple field update
 * - Cancelling via status='cancelled' releases all resources automatically
 */
export async function PATCH(
    request: Request,
    { params }: { params: { id: string } }
) {
    try {
        const id = params.id;
        const body = await request.json();
        const validatedData = updateAppointmentSchema.parse(body);

        const updated = await AppointmentsService.updateAppointment(id, validatedData);

        return NextResponse.json(
            ApiResponseBuilder.success(updated)
        );
    } catch (error) {
        return handleError(error);
    }
}

/**
 * DELETE /api/v1/appointments/:id
 *
 * Soft-cancels the appointment (status → 'cancelled').
 * Resources are freed immediately (engine ignores cancelled appointments).
 */
export async function DELETE(
    request: Request,
    { params }: { params: { id: string } }
) {
    try {
        await AppointmentsService.deleteAppointment(params.id);

        return NextResponse.json(
            ApiResponseBuilder.success({ message: 'Cita cancelada exitosamente' })
        );
    } catch (error) {
        return handleError(error);
    }
}
