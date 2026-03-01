import { NextResponse } from 'next/server';
import { AvailabilityService } from '@/services/availability.service';
import { ApiResponseBuilder } from '@/lib/api-response';

/**
 * GET /api/v1/availability/check?service_id=xxx&starts_at=2026-03-05T15:30:00Z
 *
 * Checks if a SPECIFIC time slot is available for a given service.
 * Specially designed for AI Agents (n8n). Unlinke general endpoints, 
 * this won't throw 409 errors (which would break AI conversational flow), 
 * but instead returns a graceful 200 OK with `available: false` and an `ai_hint`.
 */
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const serviceId = searchParams.get('service_id');
        const startsAt = searchParams.get('starts_at'); // Must be ISO 8601 string

        if (!serviceId) {
            return NextResponse.json(
                ApiResponseBuilder.error('service_id is required', 'MISSING_PARAM', 400),
                { status: 400 }
            );
        }
        if (!startsAt || !Date.parse(startsAt)) {
            return NextResponse.json(
                ApiResponseBuilder.error('starts_at is required and must be a valid ISO timestamp', 'MISSING_PARAM', 400),
                { status: 400 }
            );
        }

        const slotStart = new Date(startsAt);

        try {
            // Dry run: Attempts to allocate resources without saving to DB.
            // If it passes without throwing, the exact slot is mathematically available.
            await AvailabilityService.allocateResourcesForService(serviceId, slotStart);

            return NextResponse.json(
                ApiResponseBuilder.success(
                    { available: true },
                    {
                        service_id: serviceId,
                        requested_time: startsAt,
                        ai_hint: "Sí, el horario solicitado está perfectamente disponible para agendar la cita."
                    }
                )
            );

        } catch (engineError: any) {
            // The engine bounced the slot. We won't throw a HTTP 4xx/5xx to the AI,
            // we will gently translate the error so the AI can communicate it to the patient.

            let aiHint = "Lamentablemente, no tenemos disponibilidad en este horario exacto.";

            switch (engineError.code) {
                case 'CLINIC_BLOCKED':
                    aiHint = "No, la clínica se encuentra cerrada o bloqueada en ese horario.";
                    break;
                case 'RESOURCE_BUSY':
                    aiHint = "No, lamentablemente no tenemos disponibilidad de espacio físico (Boxes o Cámaras) a esa hora exacta.";
                    break;
                case 'PROFESSIONAL_BUSY':
                    aiHint = "No, en ese horario específico nuestros profesionales ya están al límite de su capacidad.";
                    break;
                case 'OUT_OF_SCHEDULE':
                    aiHint = "No, ese horario se encuentra fuera de nuestros turnos de atención habituales.";
                    break;
            }

            return NextResponse.json(
                ApiResponseBuilder.success(
                    {
                        available: false,
                        reason: engineError.code || 'UNKNOWN_CONFLICT',
                        technical_detail: engineError.message
                    },
                    {
                        service_id: serviceId,
                        requested_time: startsAt,
                        ai_hint: aiHint
                    }
                )
            );
        }

    } catch (error: any) {
        // Only return 500 for actual unhandled server crashes
        console.error('Check Endpoint Error:', error);
        return NextResponse.json(
            ApiResponseBuilder.error('Internal server error during availability check', 'INTERNAL_ERROR', 500),
            { status: 500 }
        );
    }
}
