import { NextResponse } from 'next/server';
import { PatientsService } from '@/services/patients.service';
import { ApiResponseBuilder } from '@/lib/api-response';
import { handleError } from '@/lib/error-handler';

export async function GET(
    request: Request,
    { params }: { params: { id: string } }
) {
    try {
        const patient = await PatientsService.getPatientById(params.id);

        return NextResponse.json(
            ApiResponseBuilder.success(patient)
        );
    } catch (error) {
        return handleError(error);
    }
}
