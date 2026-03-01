import { NextResponse } from 'next/server';
import { AvailabilityService } from '@/services/availability.service';
import { ApiResponseBuilder } from '@/lib/api-response';
import { handleError } from '@/lib/error-handler';

/**
 * GET /api/v1/availability?service_id=xxx&date=2025-03-10
 *
 * Returns available time slots for a given service on a given date.
 * The frontend uses this to enable/disable time pickers in the scheduling calendar.
 */
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const serviceId = searchParams.get('service_id');
        const date = searchParams.get('date');

        if (!serviceId) {
            return NextResponse.json(
                ApiResponseBuilder.error('service_id is required', 'MISSING_PARAM', 400),
                { status: 400 }
            );
        }
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return NextResponse.json(
                ApiResponseBuilder.error('date is required in YYYY-MM-DD format', 'MISSING_PARAM', 400),
                { status: 400 }
            );
        }

        const smartSlots = await AvailabilityService.getSmartAvailability(serviceId, date);

        return NextResponse.json(
            ApiResponseBuilder.success(smartSlots.raw_slots, {
                total: smartSlots.raw_slots.length,
                date,
                service_id: serviceId,
                ai_hint: smartSlots.ai_hint,
                smart_search: {
                    requested_date: smartSlots.requested_date,
                    actual_date_searched: smartSlots.actual_date_searched,
                    grouped_slots: smartSlots.slots,
                    continuous_blocks: smartSlots.continuous_blocks
                }
            })
        );
    } catch (error) {
        return handleError(error);
    }
}
