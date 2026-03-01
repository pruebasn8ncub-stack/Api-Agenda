# API Agenda - Clínica

API REST independiente para el sistema de agendamiento de la clínica.

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/v1/appointments` | Listar citas (filtros: `professional_id`, `start_date`, `end_date`) |
| `POST` | `/api/v1/appointments` | Crear cita |
| `PATCH` | `/api/v1/appointments/:id` | Actualizar/reagendar cita |
| `DELETE` | `/api/v1/appointments/:id` | Cancelar cita |
| `GET` | `/api/v1/availability?service_id=X&date=YYYY-MM-DD` | Disponibilidad con bloques continuos |
| `GET` | `/api/v1/availability/check?service_id=X&starts_at=ISO` | Verificar slot específico (AI-friendly) |
| `POST` | `/api/v1/auth/login` | Login |
| `POST` | `/api/v1/auth/logout` | Logout |
| `POST` | `/api/v1/create-professional` | Crear profesional (admin only) |
| `GET` | `/api/v1/patients` | Listar pacientes |
| `POST` | `/api/v1/patients` | Crear paciente |
| `GET` | `/api/v1/patients/:id` | Obtener paciente |

## Variables de Entorno

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
PORT=3000
```

## Desarrollo Local

```bash
npm install
npm run dev
```

## Producción (Docker)

```bash
docker build -t api-agenda .
docker run -p 3000:3000 --env-file .env api-agenda
```

## Tecnologías

- **Runtime**: Next.js 14 (API Routes only)
- **Base de Datos**: Supabase (PostgreSQL)
- **Validación**: Zod
- **Despliegue**: Docker / EasyPanel
