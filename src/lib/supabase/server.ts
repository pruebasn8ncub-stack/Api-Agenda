import { createClient as createSupabaseClient } from '@supabase/supabase-js';

/**
 * Creates a Supabase server client for API-only mode.
 * Since this is a standalone API (no SSR cookies), we use the standard client
 * with anon key for RLS-based queries.
 */
export function createClient() {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

    return createSupabaseClient(supabaseUrl, supabaseAnonKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    });
}
