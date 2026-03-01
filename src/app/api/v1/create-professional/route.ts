import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ApiResponseBuilder } from '@/lib/api-response';
import { handleError } from '@/lib/error-handler';
import { AppError } from '@/lib/errors';
import { z } from 'zod';

const createProfessionalSchema = z.object({
    email: z.string().email('Correo inválido'),
    password: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres'),
    full_name: z.string().min(1, 'El nombre es obligatorio'),
    role: z.enum(['professional', 'admin', 'receptionist']),
});

export async function POST(request: Request) {
    try {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!serviceRoleKey) {
            throw new AppError(
                'SUPABASE_SERVICE_ROLE_KEY no configurada',
                500,
                'SERVER_CONFIG_ERROR'
            );
        }

        // Verify the requester is an authenticated admin via Authorization header
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new AppError('No autenticado', 401, 'UNAUTHORIZED');
        }

        const token = authHeader.replace('Bearer ', '');

        // Verify the token and get user info using the service role client
        const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
            auth: { autoRefreshToken: false, persistSession: false },
        });

        const { data: { user: requester }, error: userError } = await supabaseAdmin.auth.getUser(token);

        if (userError || !requester) {
            throw new AppError('Token inválido o expirado', 401, 'UNAUTHORIZED');
        }

        // Check the requester's role
        const { data: requesterProfile } = await supabaseAdmin
            .from('profiles')
            .select('role')
            .eq('id', requester.id)
            .single();

        if (!requesterProfile || requesterProfile.role !== 'admin') {
            throw new AppError('Solo los administradores pueden crear profesionales', 403, 'FORBIDDEN');
        }

        // Parse and validate request body
        const body = await request.json();
        const { email, password, full_name, role } = createProfessionalSchema.parse(body);

        // 1. Create auth user
        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
        });

        if (authError) {
            throw new AppError(authError.message, 400, 'AUTH_ERROR');
        }

        // 2. Create profile
        const { error: profileError } = await supabaseAdmin
            .from('profiles')
            .insert([{
                id: authData.user.id,
                full_name,
                role,
            }]);

        if (profileError) {
            // Cleanup: delete the auth user if profile creation fails
            await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
            throw new AppError(profileError.message, 400, 'PROFILE_ERROR');
        }

        return NextResponse.json(
            ApiResponseBuilder.success({
                id: authData.user.id,
                email: authData.user.email,
                full_name,
                role,
            }),
            { status: 201 }
        );
    } catch (error) {
        return handleError(error);
    }
}
