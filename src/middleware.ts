import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * API Key Authentication Middleware
 * 
 * Protects all /api/v1/* routes with a Bearer token.
 * The token must match the API_SECRET_KEY environment variable.
 * 
 * Excluded routes:
 *   - /api/v1/health (public health check)
 *   - OPTIONS requests (CORS preflight)
 */
export function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl;

    // Allow CORS preflight requests
    if (request.method === 'OPTIONS') {
        return NextResponse.next();
    }

    // Allow health check without authentication
    if (pathname.startsWith('/api/v1/health')) {
        return NextResponse.next();
    }

    // Validate API Key
    const authHeader = request.headers.get('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return NextResponse.json(
            {
                success: false,
                error: {
                    code: 'UNAUTHORIZED',
                    message: 'API Key requerida. Envía el header: Authorization: Bearer <tu_api_key>',
                    statusCode: 401,
                },
            },
            { status: 401 }
        );
    }

    const apiKey = authHeader.replace('Bearer ', '');
    const validKey = process.env.API_SECRET_KEY;

    if (!validKey) {
        console.error('[CRITICAL] API_SECRET_KEY environment variable is not set');
        return NextResponse.json(
            {
                success: false,
                error: {
                    code: 'SERVER_CONFIG_ERROR',
                    message: 'Error de configuración del servidor. Contacta al administrador.',
                    statusCode: 500,
                },
            },
            { status: 500 }
        );
    }

    if (apiKey !== validKey) {
        return NextResponse.json(
            {
                success: false,
                error: {
                    code: 'FORBIDDEN',
                    message: 'API Key inválida',
                    statusCode: 403,
                },
            },
            { status: 403 }
        );
    }

    return NextResponse.next();
}

// Only run middleware on API routes
export const config = {
    matcher: '/api/v1/:path*',
};
