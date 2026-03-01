import { NextResponse } from 'next/server';
import { AvailabilityService } from '@/services/availability.service';
import { ApiResponseBuilder } from '@/lib/api-response';
import { handleError } from '@/lib/error-handler';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * GET /api/v1/availability?service=Evaluacion&date=2026-03-03&time=15:00
 *
 * Verifica si un servicio cabe en el horario solicitado.
 *
 * RECIBE:
 *   - service: Nombre del servicio tal como está en Supabase (ej: "Evaluacion", "Masaje")
 *   - date: Fecha en formato YYYY-MM-DD
 *   - time: Hora deseada en formato HH:MM (ej: "15:00") — OPCIONAL
 *
 * ENTREGA:
 *   Si se pasa time y CABE:
 *     { "resultado": "operacion_exitosa", "message": "..." }
 *
 *   Si se pasa time y NO CABE:
 *     { "resultado": "operacion_fallida", "message": "...", "bloques_disponibles": [...] }
 *
 *   Si NO se pasa time (solo consulta de disponibilidad):
 *     { "resultado": "consulta", "ai_hint": "...", "bloques_disponibles": [...] }
 */
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const serviceName = searchParams.get('service');
        const date = searchParams.get('date');
        const time = searchParams.get('time'); // Opcional: HH:MM

        // Validaciones
        if (!serviceName) {
            return NextResponse.json(
                ApiResponseBuilder.error('El parámetro "service" es requerido (nombre del servicio)', 'MISSING_PARAM', 400),
                { status: 400 }
            );
        }
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return NextResponse.json(
                ApiResponseBuilder.error('El parámetro "date" es requerido en formato YYYY-MM-DD', 'MISSING_PARAM', 400),
                { status: 400 }
            );
        }

        // Buscar servicio por nombre (case-insensitive)
        const supabase = createAdminClient();
        const { data: service, error: sErr } = await supabase
            .from('services')
            .select('id, name, duration_minutes, is_active')
            .ilike('name', serviceName)
            .single();

        if (sErr || !service) {
            return NextResponse.json(
                ApiResponseBuilder.error(
                    `Servicio "${serviceName}" no encontrado. Servicios disponibles: Evaluacion, Masaje, Sesion kinesiologica, Sesion Camara Hipervarica, Sesion Recovery`,
                    'SERVICE_NOT_FOUND',
                    404
                ),
                { status: 404 }
            );
        }

        if (!service.is_active) {
            return NextResponse.json(
                ApiResponseBuilder.error(`El servicio "${service.name}" no está disponible actualmente`, 'SERVICE_INACTIVE', 409),
                { status: 409 }
            );
        }

        // Si se pasa time → verificar si cabe en ese horario exacto
        if (time) {
            if (!/^\d{2}:\d{2}$/.test(time)) {
                return NextResponse.json(
                    ApiResponseBuilder.error('El parámetro "time" debe estar en formato HH:MM (ej: "15:00")', 'INVALID_TIME', 400),
                    { status: 400 }
                );
            }

            const requestedStart = new Date(`${date}T${time}:00-03:00`);

            try {
                // Intentar asignar recursos (dry-run lógico)
                await AvailabilityService.allocateResourcesForService(service.id, requestedStart);

                // ✅ CABE — operación exitosa
                return NextResponse.json(
                    ApiResponseBuilder.success({
                        resultado: 'operacion_exitosa',
                        message: `El servicio "${service.name}" (${service.duration_minutes} min) está disponible el ${date} a las ${time}. Puedes agendar la cita.`,
                        servicio: service.name,
                        fecha: date,
                        hora: time,
                        duracion_minutos: service.duration_minutes,
                    })
                );

            } catch (engineError: any) {
                // ❌ NO CABE — buscar alternativas
                const smart = await AvailabilityService.getSmartAvailability(service.id, date);

                return NextResponse.json(
                    ApiResponseBuilder.success({
                        resultado: 'operacion_fallida',
                        message: `El servicio "${service.name}" (${service.duration_minutes} min) NO cabe el ${date} a las ${time}. Razón: ${engineError.message}`,
                        razon: engineError.code || 'CONFLICT',
                        servicio: service.name,
                        fecha: date,
                        hora_solicitada: time,
                        ai_hint: smart.ai_hint,
                        bloques_disponibles: smart.continuous_blocks,
                    })
                );
            }
        }

        // Si NO se pasa time → solo consulta general de disponibilidad
        const smart = await AvailabilityService.getSmartAvailability(service.id, date);

        return NextResponse.json(
            ApiResponseBuilder.success({
                resultado: 'consulta',
                servicio: service.name,
                fecha: date,
                duracion_minutos: service.duration_minutes,
                ai_hint: smart.ai_hint,
                bloques_disponibles: smart.continuous_blocks,
            })
        );

    } catch (error) {
        return handleError(error);
    }
}
