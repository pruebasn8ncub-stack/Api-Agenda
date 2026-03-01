import { NextResponse } from 'next/server';
import { PatientsService } from '@/services/patients.service';
import { ApiResponseBuilder } from '@/lib/api-response';
import { handleError } from '@/lib/error-handler';
import { z } from 'zod';

const createPatientSchema = z.object({
    full_name: z.string().min(2, 'Full name is required'),
    email: z.string().email('Invalid email').optional().or(z.literal('')),
    phone: z.string().min(6, 'Phone is required'),
    notes: z.string().optional()
});

export async function GET() {
    try {
        const patients = await PatientsService.getAllPatients();

        return NextResponse.json(
            ApiResponseBuilder.success(patients, { total: patients.length })
        );
    } catch (error) {
        return handleError(error);
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const validatedData = createPatientSchema.parse(body);

        const newPatient = await PatientsService.createPatient(validatedData);

        return NextResponse.json(
            ApiResponseBuilder.success(newPatient),
            { status: 201 }
        );
    } catch (error) {
        return handleError(error);
    }
}
