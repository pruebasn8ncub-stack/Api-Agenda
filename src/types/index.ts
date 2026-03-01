// Data Models mapping directly to Supabase Schema

export interface Profile {
    id: string; // Auth User ID
    full_name: string;
    role: 'admin' | 'professional' | 'receptionist';
    created_at: string;
}

export interface Patient {
    id: string;
    full_name: string;
    email?: string;
    phone: string;
    notes?: string;
    created_at: string;
    updated_at: string;
    deleted_at?: string;
}

export interface PhysicalResource {
    id: string;
    name: string; // e.g. "Chamber 1", "Box Main"
    type: 'chamber' | 'box';
    is_active: boolean;
    created_at: string;
}

export interface Service {
    id: string;
    name: string;
    description: string | null;
    color: string; // Hex color for visual identification in the agenda
    is_active: boolean;
    is_composite: boolean;
    duration_minutes: number;
    required_professionals: number;
    required_resource_type: 'chamber' | 'box' | null;
    created_at: string;
}

// NEW: Services are now broken down into phases
export interface ServicePhase {
    id: string;
    service_id: string;
    phase_order: number;
    duration_minutes: number;
    requires_professional_fraction: number;
    requires_resource_type: 'chamber' | 'box' | null;
    sub_service_id: string | null;
    label: string | null;
    created_at: string;
}

export interface Appointment {
    id: string;
    patient_id: string;
    service_id: string;
    starts_at: string; // ISO DB String
    ends_at: string; // DB String: Calculated by adding up all phase durations
    status: 'scheduled' | 'cancelled' | 'completed' | 'no_show';
    notes?: string;
    created_at: string;
    updated_at: string;
}

// NEW: Allocations are now tied to a specific phase of the appointment in time
export interface AppointmentAllocation {
    id: string;
    appointment_id: string;
    service_phase_id: string | null;
    professional_id: string;
    physical_resource_id: string | null;
    starts_at: string; // Specific start time of this phase
    ends_at: string;   // Specific end time of this phase
    created_at: string;
}

export interface ScheduleException {
    id: string;
    professional_id: string | null;
    physical_resource_id: string | null;
    starts_at: string;
    ends_at: string;
    reason?: string;
}

// Request DTOs
export interface CreateAppointmentRequestDTO {
    patient_id: string;
    service_id: string;
    starts_at: string; // Client gives requested start time
    notes?: string;
}
