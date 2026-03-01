import { createAdminClient as createClient } from '@/lib/supabase/admin';
import { AppError } from '@/lib/errors';
import { addMinutes } from 'date-fns';

/**
 * MOTOR DE AGENDAMIENTO v2 — Capacidad Concurrente + Multifase
 *
 * Soporta tanto servicios simples como compuestos (multifase).
 *
 * Para servicios SIMPLES (is_composite=false):
 *   - Se crea una fase virtual a partir del servicio directamente
 *   - Se busca 1 profesional + 1 recurso (si aplica)
 *
 * Para servicios COMPUESTOS (is_composite=true):
 *   - Se cargan las fases desde service_phases
 *   - Cada fase se procesa secuencialmente (una tras otra)
 *   - Cada fase tiene su propia asignación de profesional + recurso
 *   - El profesional puede cambiar entre fases si no hay disponibilidad continua
 *
 * Validaciones por cada fase:
 *   1. La clínica no esté bloqueada (schedule_exceptions globales)
 *   2. Hay recurso físico disponible del tipo requerido
 *   3. El recurso no está bloqueado por excepción
 *   4. Hay un profesional que:
 *      a. Trabaja ese día (professional_schedules)
 *      b. Su horario cubre la fase completa
 *      c. No tiene excepción/ausencia activa
 *      d. Su carga fraccional + la del nuevo servicio <= 1.0
 */

interface PhaseAllocation {
    service_phase_id: string | null;
    professional_id: string;
    physical_resource_id: string | null;
    starts_at: string;
    ends_at: string;
}

interface ServicePhase {
    id: string;
    phase_order: number;
    duration_minutes: number;
    requires_professional_fraction: number;
    requires_resource_type: string | null;
}

export class AvailabilityService {

    /**
     * Allocates professionals + physical resources for ALL phases of a service.
     * Returns an array of allocations (one per phase) and the overall end time.
     */
    static async allocateResourcesForService(
        serviceId: string,
        requestedStartTime: Date
    ): Promise<{ allocations: PhaseAllocation[]; ends_at: Date }> {
        const supabase = createClient();

        // ── 1. Load service ─────────────────────────────────────────────
        const { data: service, error: sErr } = await supabase
            .from('services')
            .select('id, name, duration_minutes, required_resource_type, required_professionals, is_active, is_composite')
            .eq('id', serviceId)
            .single();

        if (sErr || !service) throw new AppError('Servicio no encontrado', 404, 'SERVICE_NOT_FOUND');
        if (!service.is_active) throw new AppError('Este servicio no está disponible actualmente', 409, 'SERVICE_INACTIVE');

        // ── 2. Load phases ──────────────────────────────────────────────
        let phases: ServicePhase[];

        if (service.is_composite) {
            const { data: dbPhases, error: phErr } = await supabase
                .from('service_phases')
                .select('id, phase_order, duration_minutes, requires_professional_fraction, requires_resource_type')
                .eq('service_id', serviceId)
                .order('phase_order', { ascending: true });

            if (phErr || !dbPhases || dbPhases.length === 0) {
                throw new AppError('El servicio compuesto no tiene fases configuradas', 500, 'NO_PHASES');
            }
            phases = dbPhases;
        } else {
            // Simple service → create a virtual single phase
            // Check if there's a phase in DB already (for simple services with explicit phase)
            const { data: existingPhases } = await supabase
                .from('service_phases')
                .select('id, phase_order, duration_minutes, requires_professional_fraction, requires_resource_type')
                .eq('service_id', serviceId)
                .order('phase_order', { ascending: true });

            if (existingPhases && existingPhases.length > 0) {
                phases = existingPhases;
            } else {
                // Virtual phase from service-level fields
                phases = [{
                    id: '__virtual__',
                    phase_order: 1,
                    duration_minutes: service.duration_minutes,
                    requires_professional_fraction: parseFloat(service.required_professionals.toString()),
                    requires_resource_type: service.required_resource_type,
                }];
            }
        }

        // ── 3. Allocate each phase sequentially ─────────────────────────
        const allocations: PhaseAllocation[] = [];
        let currentStart = new Date(requestedStartTime);

        for (const phase of phases) {
            const phaseEnd = addMinutes(currentStart, phase.duration_minutes);
            const startIso = currentStart.toISOString();
            const endIso = phaseEnd.toISOString();
            const requiredProfFraction = parseFloat(phase.requires_professional_fraction.toString());

            // 3a. Check global clinic blocks
            const { data: globalBlocks } = await supabase
                .from('schedule_exceptions')
                .select('id')
                .is('professional_id', null)
                .is('physical_resource_id', null)
                .lt('starts_at', endIso)
                .gt('ends_at', startIso);

            if (globalBlocks && globalBlocks.length > 0) {
                throw new AppError(
                    `La clínica está cerrada/bloqueada durante la fase ${phase.phase_order}`,
                    409,
                    'CLINIC_BLOCKED'
                );
            }

            // 3b. Allocate physical resource (if needed)
            let allocatedResourceId: string | null = null;

            if (phase.requires_resource_type) {
                const { data: allResources } = await supabase
                    .from('physical_resources')
                    .select('id, name, type')
                    .eq('is_active', true)
                    .eq('type', phase.requires_resource_type);

                if (!allResources || allResources.length === 0) {
                    throw new AppError(
                        `No hay recursos de tipo "${phase.requires_resource_type}" activos`,
                        500,
                        'NO_RESOURCES'
                    );
                }

                const allResourceIds = allResources.map(r => r.id);

                // Resources already booked by other appointments
                const { data: bookedAllocations } = await supabase
                    .from('appointment_allocations')
                    .select('physical_resource_id, appointments!inner(status)')
                    .in('physical_resource_id', allResourceIds)
                    .lt('starts_at', endIso)
                    .gt('ends_at', startIso)
                    .neq('appointments.status', 'cancelled');

                // Resources blocked by exceptions
                const { data: blockedByException } = await supabase
                    .from('schedule_exceptions')
                    .select('physical_resource_id')
                    .in('physical_resource_id', allResourceIds)
                    .lt('starts_at', endIso)
                    .gt('ends_at', startIso);

                const occupiedIds = new Set<string>([
                    ...(bookedAllocations?.map((b: any) => b.physical_resource_id).filter(Boolean) || []),
                    ...(blockedByException?.map((e: any) => e.physical_resource_id).filter(Boolean) || []),
                ]);

                // Also exclude resources already allocated in earlier phases of this same appointment
                allocations.forEach(a => {
                    if (a.physical_resource_id) occupiedIds.add(a.physical_resource_id);
                });

                const freeResource = allResources.find(r => !occupiedIds.has(r.id));

                if (!freeResource) {
                    throw new AppError(
                        `Todos los recursos de tipo "${phase.requires_resource_type}" están ocupados durante la fase ${phase.phase_order}. Intenta otro horario.`,
                        409,
                        'RESOURCE_BUSY'
                    );
                }

                allocatedResourceId = freeResource.id;
            }

            // 3c. Allocate professional (if needed — fraction > 0)
            let assignedProfessionalId: string | null = null;

            if (requiredProfFraction > 0) {
                const { data: allProfessionals } = await supabase
                    .from('profiles')
                    .select('id, full_name')
                    .eq('role', 'professional');

                if (!allProfessionals || allProfessionals.length === 0) {
                    throw new AppError('No hay profesionales configurados', 500, 'NO_PROFESSIONALS');
                }

                const startParts = getTimeParts(currentStart);
                const endParts = getTimeParts(phaseEnd);

                for (const prof of allProfessionals) {
                    // Does the professional work on this day?
                    const { data: schedule } = await supabase
                        .from('professional_schedules')
                        .select('start_time, end_time')
                        .eq('professional_id', prof.id)
                        .eq('day_of_week', startParts.dayIndex)
                        .single();

                    if (!schedule) continue;

                    // Does the phase fall within their working hours?
                    if (startParts.time < schedule.start_time || endParts.time > schedule.end_time) continue;

                    // Is the professional not on exception/absence?
                    const { data: profExceptions } = await supabase
                        .from('schedule_exceptions')
                        .select('id')
                        .eq('professional_id', prof.id)
                        .lt('starts_at', endIso)
                        .gt('ends_at', startIso);

                    if (profExceptions && profExceptions.length > 0) continue;

                    // Capacity check: load from existing appointments
                    // Query includes the fraction data from service_phases or services
                    const { data: activeAllocations } = await supabase
                        .from('appointment_allocations')
                        .select(`
                            starts_at, 
                            ends_at, 
                            service_phase_id,
                            appointments!inner(status, service_id, services(required_professionals)),
                            service_phases(requires_professional_fraction)
                        `)
                        .eq('professional_id', prof.id)
                        .lt('starts_at', endIso)
                        .gt('ends_at', startIso)
                        .neq('appointments.status', 'cancelled');

                    // Also account for allocations from earlier phases of THIS appointment
                    const priorPhaseAllocations = allocations.filter(a => a.professional_id === prof.id);

                    let hasCapacity = true;
                    const startMs = currentStart.getTime();
                    const endMs = phaseEnd.getTime();

                    for (let t = startMs; t < endMs; t += 60_000) {
                        let loadAtMinute = 0;

                        // Load from existing DB allocations
                        activeAllocations?.forEach((alloc: any) => {
                            const allocStart = new Date(alloc.starts_at).getTime();
                            const allocEnd = new Date(alloc.ends_at).getTime();
                            if (t >= allocStart && t < allocEnd) {
                                // Get the actual professional fraction
                                const fraction = alloc.service_phases?.requires_professional_fraction
                                    ?? alloc.appointments?.services?.required_professionals
                                    ?? 1;
                                loadAtMinute += parseFloat(fraction.toString());
                            }
                        });

                        // Load from earlier phases of this same appointment
                        priorPhaseAllocations.forEach(a => {
                            const aStart = new Date(a.starts_at).getTime();
                            const aEnd = new Date(a.ends_at).getTime();
                            if (t >= aStart && t < aEnd) {
                                // This phase of the same appointment also uses this professional
                                // Find the fraction for that phase
                                const priorPhase = phases.find(p => {
                                    const pStart = new Date(requestedStartTime);
                                    let offset = 0;
                                    for (const pp of phases) {
                                        if (pp.id === p.id) break;
                                        offset += pp.duration_minutes;
                                    }
                                    const phaseStart = addMinutes(pStart, offset).getTime();
                                    const phaseEnd = addMinutes(pStart, offset + p.duration_minutes).getTime();
                                    return t >= phaseStart && t < phaseEnd;
                                });
                                loadAtMinute += priorPhase
                                    ? parseFloat(priorPhase.requires_professional_fraction.toString())
                                    : 1;
                            }
                        });

                        if (loadAtMinute + requiredProfFraction > 1.0) {
                            hasCapacity = false;
                            break;
                        }
                    }

                    if (!hasCapacity) continue;

                    assignedProfessionalId = prof.id;
                    break;
                }

                if (!assignedProfessionalId) {
                    throw new AppError(
                        `No hay profesionales disponibles durante la fase ${phase.phase_order}. Todos al máximo de capacidad o fuera de turno.`,
                        409,
                        'PROFESSIONAL_BUSY'
                    );
                }
            } else {
                // Phase doesn't require a professional (fraction = 0)
                // Still needs someone supervising — pick the first available
                // For now, use a dummy approach: reuse last phase's professional or first available
                assignedProfessionalId = allocations.length > 0
                    ? allocations[allocations.length - 1].professional_id
                    : (await getFirstAvailableProfessional(supabase)) || '';
            }

            allocations.push({
                service_phase_id: phase.id === '__virtual__' ? null : phase.id,
                professional_id: assignedProfessionalId,
                physical_resource_id: allocatedResourceId,
                starts_at: startIso,
                ends_at: endIso,
            });

            // Move start to the end of this phase for the next one
            currentStart = phaseEnd;
        }

        return {
            allocations,
            ends_at: currentStart,
        };
    }

    /**
     * Returns available time slots for a given service on a given date.
     * Works for both simple and composite services.
     */
    static async getAvailableSlots(serviceId: string, date: string): Promise<string[]> {
        const supabase = createClient();

        // 1. Fetch Service Context
        const { data: service } = await supabase
            .from('services')
            .select('*')
            .eq('id', serviceId)
            .single();

        if (!service || !service.is_active) return [];

        let phases: ServicePhase[] = [];
        if (service.is_composite) {
            const { data: dbPhases } = await supabase
                .from('service_phases')
                .select('*')
                .eq('service_id', serviceId)
                .order('phase_order', { ascending: true });
            phases = dbPhases || [];
        } else {
            const { data: existingPhases } = await supabase
                .from('service_phases')
                .select('*')
                .eq('service_id', serviceId)
                .order('phase_order', { ascending: true });
            if (existingPhases && existingPhases.length > 0) {
                phases = existingPhases;
            } else {
                phases = [{
                    id: '__virtual__',
                    phase_order: 1,
                    duration_minutes: service.duration_minutes,
                    requires_professional_fraction: parseFloat(service.required_professionals.toString()),
                    requires_resource_type: service.required_resource_type,
                } as any];
            }
        }

        // 2. Pre-fetch Daily Data explicitly using local timezone reference
        const dayStartIso = new Date(`${date}T00:00:00-03:00`).toISOString();
        const dayEndIso = new Date(`${date}T23:59:59-03:00`).toISOString();
        const searchDateObj = new Date(`${date}T12:00:00-03:00`);
        const targetDayIndex = getTimeParts(searchDateObj).dayIndex;

        // Fetch everything concurrently
        const [
            { data: rawGlobalBlocks },
            { data: allResources },
            { data: rawAllocations },
            { data: rawExceptions },
            { data: allProfessionals },
            { data: allSchedules }
        ] = await Promise.all([
            supabase.from('schedule_exceptions').select('id, starts_at, ends_at').is('professional_id', null).is('physical_resource_id', null).lt('starts_at', dayEndIso).gt('ends_at', dayStartIso),
            supabase.from('physical_resources').select('id, name, type').eq('is_active', true),
            supabase.from('appointment_allocations').select('physical_resource_id, professional_id, starts_at, ends_at, service_phase_id, appointments!inner(status, services(required_professionals)), service_phases(requires_professional_fraction)').lt('starts_at', dayEndIso).gt('ends_at', dayStartIso).neq('appointments.status', 'cancelled'),
            supabase.from('schedule_exceptions').select('id, professional_id, physical_resource_id, starts_at, ends_at').lt('starts_at', dayEndIso).gt('ends_at', dayStartIso),
            supabase.from('profiles').select('id, full_name').eq('role', 'professional'),
            supabase.from('professional_schedules').select('professional_id, start_time, end_time').eq('day_of_week', targetDayIndex)
        ]);

        const globalBlocks = rawGlobalBlocks || [];
        const resources = allResources || [];
        const allocations = rawAllocations || [];
        const exceptions = rawExceptions || [];
        const professionals = allProfessionals || [];
        const schedules = allSchedules || [];

        const isOverlap = (s1o: string, e1o: string, s2o: string, e2o: string) => {
            return new Date(s1o).getTime() < new Date(e2o).getTime() && new Date(s2o).getTime() < new Date(e1o).getTime();
        };

        const slots: string[] = [];

        // 3. Evaluate slots purely in memory
        for (let h = 8; h < 20; h++) {
            for (let m = 0; m < 60; m += 15) {
                const slotStartTime = new Date(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-03:00`);
                let isValidSlot = true;
                let currentPhaseStart = new Date(slotStartTime.getTime());
                const trialAllocations: any[] = [];

                for (const phase of phases) {
                    const currentPhaseEnd = addMinutes(currentPhaseStart, phase.duration_minutes);
                    const phaseStartIso = currentPhaseStart.toISOString();
                    const phaseEndIso = currentPhaseEnd.toISOString();
                    const reqFraction = phase.requires_professional_fraction ? parseFloat(phase.requires_professional_fraction.toString()) : 0;

                    // 1. Clinic blocked?
                    if (globalBlocks.some(b => isOverlap(b.starts_at, b.ends_at, phaseStartIso, phaseEndIso))) {
                        isValidSlot = false; break;
                    }

                    // 2. Resource Available?
                    let allocatedResId = null;
                    if (phase.requires_resource_type) {
                        const freeResource = resources.filter(r => r.type === phase.requires_resource_type).find(r => {
                            if (exceptions.some(e => e.physical_resource_id === r.id && isOverlap(e.starts_at, e.ends_at, phaseStartIso, phaseEndIso))) return false;
                            if (allocations.some(a => a.physical_resource_id === r.id && isOverlap(a.starts_at, a.ends_at, phaseStartIso, phaseEndIso))) return false;
                            if (trialAllocations.some(ta => ta.physical_resource_id === r.id && isOverlap(ta.starts_at, ta.ends_at, phaseStartIso, phaseEndIso))) return false;
                            return true;
                        });

                        if (!freeResource) { isValidSlot = false; break; }
                        allocatedResId = freeResource.id;
                    }

                    // 3. Professional Available?
                    let allocatedProfId = null;
                    if (reqFraction > 0) {
                        const sParts = getTimeParts(currentPhaseStart);
                        const eParts = getTimeParts(currentPhaseEnd);
                        const sTimeStr = sParts.time;
                        const eTimeStr = eParts.time;

                        const freeProf = professionals.find(p => {
                            const sched = schedules.find(s => s.professional_id === p.id);
                            if (!sched) return false;
                            if (sTimeStr < sched.start_time || eTimeStr > sched.end_time) return false;
                            if (exceptions.some(e => e.professional_id === p.id && isOverlap(e.starts_at, e.ends_at, phaseStartIso, phaseEndIso))) return false;

                            const pAllocations = allocations.filter(a => a.professional_id === p.id && isOverlap(a.starts_at, a.ends_at, phaseStartIso, phaseEndIso));
                            const pTrials = trialAllocations.filter(a => a.professional_id === p.id && isOverlap(a.starts_at, a.ends_at, phaseStartIso, phaseEndIso));

                            for (let t = currentPhaseStart.getTime(); t < currentPhaseEnd.getTime(); t += 60000) {
                                let minLoad = 0;
                                pAllocations.forEach(a => {
                                    if (t >= new Date(a.starts_at).getTime() && t < new Date(a.ends_at).getTime()) {
                                        const allocAny = a as any;
                                        minLoad += parseFloat((allocAny.service_phases?.requires_professional_fraction ?? allocAny.appointments?.services?.required_professionals ?? 1).toString());
                                    }
                                });
                                pTrials.forEach(a => {
                                    if (t >= new Date(a.starts_at).getTime() && t < new Date(a.ends_at).getTime()) {
                                        minLoad += a.fraction;
                                    }
                                });
                                if (minLoad + reqFraction > 1.0) return false;
                            }
                            return true;
                        });

                        if (!freeProf) { isValidSlot = false; break; }
                        allocatedProfId = freeProf.id;
                    }

                    trialAllocations.push({
                        starts_at: phaseStartIso,
                        ends_at: phaseEndIso,
                        physical_resource_id: allocatedResId,
                        professional_id: allocatedProfId,
                        fraction: reqFraction
                    });

                    currentPhaseStart = currentPhaseEnd;
                }

                if (isValidSlot && currentPhaseStart.getHours() < 21) {
                    slots.push(slotStartTime.toISOString());
                }
            }
        }

        return slots;
    }

    /**
     * Devuelve la disponibilidad formateada para Inteligencia Artificial.
     * Si el día solicitado tiene muy pocos cupos, busca proactivamente en los siguientes días.
     */
    static async getSmartAvailability(serviceId: string, requestedDate: string): Promise<{
        requested_date: string;
        actual_date_searched: string;
        slots: { morning: string[], afternoon: string[], evening: string[] };
        continuous_blocks: { start_time: string, end_time: string }[];
        ai_hint: string;
        raw_slots: string[];
    }> {
        const MAX_DAYS_LOOKAHEAD = 3;
        let currentDateStr = requestedDate;
        let foundSlots: string[] = [];
        let lookaheadCount = 0;

        // Búsqueda proactiva
        while (lookaheadCount < MAX_DAYS_LOOKAHEAD) {
            foundSlots = await this.getAvailableSlots(serviceId, currentDateStr);
            if (foundSlots.length >= 3) {
                break; // Encontramos un día decente
            }
            // Avanzar 1 día
            const nextDate = new Date(`${currentDateStr}T12:00:00Z`);
            nextDate.setUTCDate(nextDate.getUTCDate() + 1);
            currentDateStr = nextDate.toISOString().split('T')[0];
            lookaheadCount++;
        }

        // Obtener duración del servicio para calcular el final del bloque
        const supabase = createClient();
        const { data: service } = await supabase
            .from('services')
            .select('duration_minutes')
            .eq('id', serviceId)
            .single();
        const durationMinutes = service?.duration_minutes || 60;

        // Procesar bloques continuos
        const continuous_blocks: { start_time: string, end_time: string }[] = [];
        if (foundSlots.length > 0) {
            let currentBlockStart = new Date(foundSlots[0]);
            let currentBlockEnd = addMinutes(currentBlockStart, durationMinutes);

            const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

            for (let i = 1; i < foundSlots.length; i++) {
                const slotTime = new Date(foundSlots[i]);
                const expectedNextSlot = addMinutes(new Date(foundSlots[i - 1]), 15);

                if (slotTime.getTime() === expectedNextSlot.getTime()) {
                    // Contiguo, extender fin
                    currentBlockEnd = addMinutes(slotTime, durationMinutes);
                } else {
                    // Se rompió la continuidad, guardar bloque anterior
                    continuous_blocks.push({
                        start_time: formatter.format(currentBlockStart),
                        end_time: formatter.format(currentBlockEnd)
                    });

                    // Iniciar nuevo bloque
                    currentBlockStart = slotTime;
                    currentBlockEnd = addMinutes(slotTime, durationMinutes);
                }
            }
            // Guardar último bloque
            continuous_blocks.push({
                start_time: formatter.format(currentBlockStart),
                end_time: formatter.format(currentBlockEnd)
            });
        }

        // Agrupar los slots del día que devolvió resultados
        const slots = { morning: [] as string[], afternoon: [] as string[], evening: [] as string[] };
        for (const slotIso of foundSlots) {
            const dateObj = new Date(slotIso);
            const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', hour: 'numeric', hourCycle: 'h23' });
            const hour = parseInt(formatter.format(dateObj), 10);

            if (hour < 12) slots.morning.push(slotIso);
            else if (hour < 18) slots.afternoon.push(slotIso);
            else slots.evening.push(slotIso);
        }

        // Construir Frase Natural (ai_hint)
        let ai_hint = '';
        const reqStr = requestedDate;
        const actStr = currentDateStr;

        if (continuous_blocks.length === 0) {
            ai_hint = `No encontré ninguna disponibilidad para el ${reqStr} ni para los ${MAX_DAYS_LOOKAHEAD - 1} días siguientes.`;
        } else {
            const dayWarning = (reqStr !== actStr) ? `No tengo cupos para el ${reqStr}. Sin embargo, busqué para el ${actStr} y ` : `Para el ${actStr} `;

            const blockPhrases = continuous_blocks.map(b => `de ${b.start_time} a ${b.end_time}`);
            let blocksStr = '';

            if (blockPhrases.length === 1) {
                blocksStr = `tengo disponibilidad continua ${blockPhrases[0]}`;
            } else if (blockPhrases.length === 2) {
                blocksStr = `tengo disponibilidad ${blockPhrases[0]} y ${blockPhrases[1]}`;
            } else {
                const last = blockPhrases.pop();
                blocksStr = `tengo disponibilidad ${blockPhrases.join(', ')} y ${last}`;
            }

            ai_hint = `${dayWarning}${blocksStr}.`;
        }

        return {
            requested_date: requestedDate,
            actual_date_searched: currentDateStr,
            slots,
            continuous_blocks,
            ai_hint,
            raw_slots: foundSlots
        };
    }
}

// ── Helper functions ────────────────────────────────────────────────────

/**
 * Converts a Date to Santiago timezone time parts for schedule comparison
 */
function getTimeParts(date: Date): { time: string; dayIndex: number } {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Santiago',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    });

    const parts = formatter.formatToParts(date);
    const get = (type: string) => parts.find(p => p.type === type)?.value || '00';

    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

    return {
        time: `${get('hour')}:${get('minute')}:${get('second')}`,
        dayIndex: dayMap[get('weekday')] ?? -1,
    };
}

/**
 * Gets the first available professional (fallback for phases with 0 professional fraction)
 */
async function getFirstAvailableProfessional(supabase: any): Promise<string | null> {
    const { data } = await supabase
        .from('profiles')
        .select('id')
        .eq('role', 'professional')
        .limit(1)
        .single();
    return data?.id || null;
}
