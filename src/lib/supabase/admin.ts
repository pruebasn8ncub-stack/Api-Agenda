import { createClient as createSupabaseClient } from '@supabase/supabase-js';

/**
 * Creates a Supabase admin client using the service_role_key.
 * Use this in API routes and server-side services
 * where we need to bypass RLS for internal operations.
 * 
 * NEVER expose this client or its key to the frontend.
 */
export function createAdminClient() {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
        throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
    }

    return createSupabaseClient(supabaseUrl, serviceRoleKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    });
}
