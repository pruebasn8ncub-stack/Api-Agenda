import { createClient } from '@/lib/supabase/server';
import { Patient } from '@/types';
import { AppError } from '@/lib/errors';

export class PatientsService {
    /**
     * Fetch all active patients
     */
    static async getAllPatients(): Promise<Patient[]> {
        const supabase = createClient();

        // RLS will automatically ensure the user can read patients
        const { data, error } = await supabase
            .from('patients')
            .select('*')
            .is('deleted_at', null)
            .order('full_name', { ascending: true });

        if (error) {
            throw new AppError(error.message, 500, 'DB_FETCH_ERROR');
        }

        return data;
    }

    /**
     * Fetch a single patient by ID
     */
    static async getPatientById(id: string): Promise<Patient> {
        const supabase = createClient();

        const { data, error } = await supabase
            .from('patients')
            .select('*')
            .eq('id', id)
            .is('deleted_at', null)
            .single();

        if (error) {
            throw new AppError('Patient not found', 404, 'PATIENT_NOT_FOUND');
        }

        return data;
    }

    /**
     * Create a new patient
     */
    static async createPatient(payload: any): Promise<Patient> {
        const supabase = createClient();

        const { data, error } = await supabase
            .from('patients')
            .insert([{
                full_name: payload.full_name,
                email: payload.email,
                phone: payload.phone,
                notes: payload.notes
            }])
            .select()
            .single();

        if (error) {
            throw new AppError(error.message, 500, 'DB_INSERT_ERROR');
        }

        return data;
    }
}
