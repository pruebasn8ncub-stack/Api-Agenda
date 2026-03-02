import { NextResponse } from 'next/server';
import { ApiResponseBuilder } from './api-response';
import { AppError } from './errors';
import { ZodError } from 'zod';

/**
 * Standard centralized error handler for API routes
 * Used to catch and format all exceptions thrown during request processing.
 */
export function handleError(error: unknown) {
    // 1. Zod Validation Errors (duck-typing for production build safety)
    const isZodError = error instanceof ZodError || (error !== null && typeof error === 'object' && (error as any).name === 'ZodError' && Array.isArray((error as any).issues));
    if (isZodError) {
        const zodErrors = (error as any).errors || [];
        const formattedErrors = zodErrors.map((e: any) => ({
            field: e.path?.join('.') || 'unknown',
            message: e.message || 'Invalid',
        }));

        return NextResponse.json(
            ApiResponseBuilder.error('Validation failed', 'VALIDATION_ERROR', 400, formattedErrors),
            { status: 400 }
        );
    }

    // 2. Operational App Errors (Expected)
    if (error instanceof AppError || (error !== null && typeof error === 'object' && (error as any).name === 'AppError')) {
        const appError = error as AppError;
        return NextResponse.json(
            ApiResponseBuilder.error(appError.message, appError.code, appError.statusCode, appError.details),
            { status: appError.statusCode || 500 }
        );
    }

    // 3. Programmer Errors / Unexpected system failures
    console.error('[Unhandled Exception]:', error);

    const message = error instanceof Error ? error.message : 'An unexpected error occurred on the server.';
    return NextResponse.json(
        ApiResponseBuilder.error(message, 'INTERNAL_SERVER_ERROR', 500),
        { status: 500 }
    );
}
