-- ============================================================
-- Migration: 20260813000000_google_calendar_integration
-- Agente WhatsApp — adds Google Calendar as an integration provider
-- (service-account auth, no OAuth redirect flow) and seeds the two
-- new agent tools: check_availability_google, schedule_google_calendar.
-- ============================================================

-- New provider value. Must be a standalone statement (not inside a DO block)
-- and cannot be referenced by other statements in this same migration file.
ALTER TYPE integration_provider ADD VALUE IF NOT EXISTS 'google_calendar';

INSERT INTO public.tools (key, name, description, schema, sensitivity) VALUES
  ('check_availability_google', 'Consultar disponibilidad (Google Calendar)',
   'Checks real free time slots on the connected Google Calendar for a date range',
   '{"type":"object","properties":{"date_from":{"type":"string"},"date_to":{"type":"string"},"duration_minutes":{"type":"number"}},"required":["date_from","date_to"]}',
   'read')
ON CONFLICT (key) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      schema = EXCLUDED.schema,
      sensitivity = EXCLUDED.sensitivity;

INSERT INTO public.tools (key, name, description, schema, sensitivity) VALUES
  ('schedule_google_calendar', 'Agendar en Google Calendar',
   'Creates an event directly on the connected Google Calendar',
   '{"type":"object","properties":{"datetime_iso":{"type":"string"},"duration_minutes":{"type":"number"},"contact_name":{"type":"string"},"contact_phone":{"type":"string"},"contact_email":{"type":"string"}},"required":["datetime_iso"]}',
   'write')
ON CONFLICT (key) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      schema = EXCLUDED.schema,
      sensitivity = EXCLUDED.sensitivity;

-- ============================================================
-- End of migration: 20260813000000_google_calendar_integration
-- ============================================================
