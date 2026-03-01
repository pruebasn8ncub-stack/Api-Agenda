/**
 * Standardized API Response structure
 * Enforces consistency across all endpoints as mandated by architecture rules.
 */

export interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    meta?: {
        page?: number;
        total?: number;
        [key: string]: any;
    };
    error?: {
        code: string;
        message: string;
        statusCode: number;
        details?: any;
    } | null;
}

export class ApiResponseBuilder {
    static success<T>(data: T, meta?: ApiResponse['meta']): ApiResponse<T> {
        return {
            success: true,
            data,
            ...(meta ? { meta } : {}),
            error: null,
        };
    }

    static error(
        message: string,
        code: string = 'INTERNAL_ERROR',
        statusCode: number = 500,
        details?: any
    ): ApiResponse<null> {
        return {
            success: false,
            error: {
                code,
                message,
                statusCode,
                details,
            },
        };
    }
}
