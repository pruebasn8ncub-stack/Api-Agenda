import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * GET /api/health
 * 
 * Health check endpoint for monitoring and load balancers.
 * Verifies both the API server and the Supabase database connection.
 */
export async function GET() {
    const timestamp = new Date().toISOString();
    let dbStatus: 'connected' | 'disconnected' = 'disconnected';
    let dbLatencyMs: number | null = null;

    try {
        const supabase = createAdminClient();
        const start = Date.now();
        const { error } = await supabase.from('services').select('id').limit(1);
        dbLatencyMs = Date.now() - start;
        dbStatus = error ? 'disconnected' : 'connected';
    } catch {
        dbStatus = 'disconnected';
    }

    const status = dbStatus === 'connected' ? 'ok' : 'degraded';

    return NextResponse.json({
        status,
        service: 'api-agenda',
        version: '1.0.0',
        timestamp,
        database: {
            status: dbStatus,
            latency_ms: dbLatencyMs,
        },
    }, { status: status === 'ok' ? 200 : 503 });
}
