import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { ApiResponseBuilder } from '@/lib/api-response';
import { handleError } from '@/lib/error-handler';
import { AppError } from '@/lib/errors';

export async function POST(request: Request) {
    try {
        const supabase = createClient();

        // Auth logout via Supabase
        const { error } = await supabase.auth.signOut();

        if (error) {
            throw new AppError(error.message, 500, 'SIGNOUT_FAILED');
        }

        return NextResponse.json(
            ApiResponseBuilder.success({ message: 'Successfully logged out' })
        );
    } catch (error) {
        return handleError(error);
    }
}
