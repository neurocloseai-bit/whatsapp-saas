import { createClient as createSbClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";

const schema = z.object({
  datetime_iso: z
    .string()
    .describe(
      "Inicio de la cita en ISO 8601 con zona horaria, ej: 2026-06-12T10:00:00-06:00",
    ),
  duration_minutes: z
    .number()
    .optional()
    .describe("Duración en minutos (por defecto 30)"),
  contact_name: z
    .string()
    .optional()
    .describe("Nombre del contacto para la cita"),
  contact_phone: z
    .string()
    .optional()
    .describe(
      "Teléfono del contacto en E.164 (ej: +5215512345678). Úsalo cuando el contacto no venga del chat (p. ej. en el playground de prueba).",
    ),
  contact_email: z
    .string()
    .optional()
    .describe("Email del contacto, para invitarlo al evento"),
});

type Args = z.infer<typeof schema>;

interface ContactRow {
  phone: string;
  name: string | null;
  email: string | null;
}

async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const { getGCalConfig, createEvent } = await import(
    "../../inbox/services/google-calendar-client"
  );

  const cfg = await getGCalConfig(ctx.workspaceId);
  if (!cfg) {
    return {
      ok: false,
      output: null,
      error: "Google Calendar no está conectado para este workspace",
    };
  }

  let name = args.contact_name ?? null;
  let email = args.contact_email ?? null;

  if ((!name || !email) && ctx.contactId) {
    const supabase = createSbClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    const { data: contact } = await supabase
      .from("contacts")
      .select("phone, name, email")
      .eq("id", ctx.contactId)
      .single();
    const row = contact as ContactRow | null;
    if (row) {
      name = name ?? row.name;
      email = email ?? row.email;
    }
  }

  try {
    const result = await createEvent(cfg, {
      summary: `Cita${name ? ` — ${name}` : ""}`,
      description: args.contact_phone ? `Tel: ${args.contact_phone}` : undefined,
      startISO: args.datetime_iso,
      durationMinutes: args.duration_minutes ?? 30,
      attendeeEmail: email,
    });

    return {
      ok: true,
      output: {
        event_id: result.id,
        datetime: args.datetime_iso,
        link: result.htmlLink,
      },
    };
  } catch (err) {
    return {
      ok: false,
      output: null,
      error:
        err instanceof Error
          ? err.message
          : "Error al agendar en Google Calendar",
    };
  }
}

export const scheduleGoogleCalendarTool: Tool<Args> = {
  name: "schedule_google_calendar",
  description:
    "Reserva una cita directamente en el Google Calendar conectado. Úsalo cuando el cliente confirme una fecha y hora específicas. Llama primero a check_availability_google para ofrecer horarios reales.",
  sensitivity: "write",
  schema,
  enabledFor: () => true,
  run,
};
