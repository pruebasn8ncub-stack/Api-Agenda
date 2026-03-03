import { NextResponse } from 'next/server';

/**
 * GET /api/v1/health
 * 
 * Public health check endpoint (no auth required).
 * Used by Easypanel, load balancers, and monitoring to verify the API is alive.
 */
export async function GET() {
    return NextResponse.json({
        status: 'ok',
        service: 'api-agenda',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
    });
}
