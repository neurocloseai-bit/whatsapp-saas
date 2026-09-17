/**
 * google-calendar-client.ts — Google Calendar API client via a Service Account.
 *
 * Auth: Service Account JSON key (no OAuth redirect flow, no refresh-token
 * dance). The workspace stores the account's client_email + private_key in
 * integrations.credentials.google_client_email / google_private_key, and the
 * target calendar id + business-hours config in integrations.config.
 *
 * Prerequisite (done once by the workspace owner in Google Cloud Console):
 *   1. Create/select a project, enable the "Google Calendar API".
 *   2. Create a Service Account, generate a JSON key.
 *   3. Share the target Google Calendar with the service account's email
 *      (Google Calendar → Settings and sharing → Share with specific people
 *      → grant "Make changes to events").
 *
 * Docs: https://developers.google.com/calendar/api/v3/reference
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import { createSign } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL_BASE = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface GCalConfig {
  clientEmail: string;
  privateKey: string;
  calendarId: string;
  timezone: string;
  businessStartHour: number; // 0-23, local to `timezone`
  businessEndHour: number; // 0-23, local to `timezone`
}

/**
 * Loads the workspace's Google Calendar service-account credentials + config.
 * Returns null when Google Calendar is not connected/enabled.
 */
export async function getGCalConfig(
  workspaceId: string,
): Promise<GCalConfig | null> {
  const supabase = svc();
  const { data, error } = await supabase
    .from("integrations")
    .select("credentials, config, enabled")
    .eq("workspace_id", workspaceId)
    .eq("provider", "google_calendar")
    .eq("enabled", true)
    .maybeSingle();

  if (error || !data) return null;

  const creds = (data.credentials as Record<string, unknown> | null) ?? {};
  const config = (data.config as Record<string, unknown> | null) ?? {};

  const clientEmail = creds.google_client_email;
  // Stored with literal "\n" escapes (as pasted straight from the JSON key
  // file) — normalize back to real newlines so the PEM parses.
  const privateKeyRaw = creds.google_private_key;

  if (typeof clientEmail !== "string" || clientEmail.length === 0) return null;
  if (typeof privateKeyRaw !== "string" || privateKeyRaw.length === 0)
    return null;

  const calendarId =
    typeof config.calendar_id === "string" && config.calendar_id.length > 0
      ? config.calendar_id
      : "primary";
  const timezone =
    typeof config.timezone === "string" && config.timezone.length > 0
      ? config.timezone
      : "America/Mexico_City";
  const businessStartHour =
    typeof config.business_start_hour === "number"
      ? config.business_start_hour
      : 9;
  const businessEndHour =
    typeof config.business_end_hour === "number"
      ? config.business_end_hour
      : 18;

  return {
    clientEmail,
    privateKey: privateKeyRaw.replace(/\\n/g, "\n"),
    calendarId,
    timezone,
    businessStartHour,
    businessEndHour,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Auth — sign a JWT with the service-account private key, exchange it for an
// access token via Google's OAuth2 token endpoint (RFC 7523 JWT bearer flow).
// No external SDK needed — built on Node's crypto + fetch.
// ──────────────────────────────────────────────────────────────────────────────

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function getAccessToken(cfg: GCalConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: cfg.clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = base64url(signer.sign(cfg.privateKey));
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google auth error: ${res.status} ${err.slice(0, 200)}`);
  }

  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token)
    throw new Error("Google auth: no access_token in response");
  return data.access_token;
}

// ──────────────────────────────────────────────────────────────────────────────
// Free/busy → available slots
// ──────────────────────────────────────────────────────────────────────────────

interface BusyPeriod {
  start: string;
  end: string;
}

async function getBusyPeriods(
  cfg: GCalConfig,
  token: string,
  timeMinISO: string,
  timeMaxISO: string,
): Promise<BusyPeriod[]> {
  const res = await fetch(`${CAL_BASE}/freeBusy`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      items: [{ id: cfg.calendarId }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(
      `Google freeBusy error: ${res.status} ${err.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as {
    calendars?: Record<string, { busy?: BusyPeriod[]; errors?: unknown[] }>;
  };
  const cal = data.calendars?.[cfg.calendarId];
  if (cal?.errors?.length) {
    throw new Error(
      `Google freeBusy: no se pudo leer el calendario "${cfg.calendarId}" (¿lo compartiste con la cuenta de servicio?)`,
    );
  }
  return cal?.busy ?? [];
}

function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Resolves a timezone's UTC offset (in minutes) for a given date. */
function getTzOffsetMinutes(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUTC = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUTC - date.getTime()) / 60000);
}

/**
 * Computes free slots of `durationMinutes` between `dateFrom` and `dateTo`
 * (inclusive, ISO dates), restricted to the configured business hours in the
 * configured timezone, excluding any Google Calendar busy period. Past slots
 * are skipped.
 */
export async function listAvailableSlots(
  cfg: GCalConfig,
  dateFrom: string,
  dateTo: string,
  durationMinutes = 30,
): Promise<string[]> {
  const token = await getAccessToken(cfg);

  const startMs = Date.parse(dateFrom);
  const endMs = Date.parse(dateTo) + 24 * 60 * 60 * 1000 - 1; // inclusive end of day
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new Error("Fechas inválidas");
  }

  const busy = await getBusyPeriods(
    cfg,
    token,
    new Date(startMs).toISOString(),
    new Date(endMs).toISOString(),
  );
  const busyMs = busy.map((b) => ({
    start: Date.parse(b.start),
    end: Date.parse(b.end),
  }));

  const slots: string[] = [];
  const stepMs = durationMinutes * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;

  for (let dayStart = startMs; dayStart < endMs; dayStart += dayMs) {
    const day = new Date(dayStart);
    const tzOffsetMin = getTzOffsetMinutes(day, cfg.timezone);
    const dayStartLocalMs =
      Date.UTC(
        day.getUTCFullYear(),
        day.getUTCMonth(),
        day.getUTCDate(),
        cfg.businessStartHour,
      ) -
      tzOffsetMin * 60 * 1000;
    const dayEndLocalMs =
      Date.UTC(
        day.getUTCFullYear(),
        day.getUTCMonth(),
        day.getUTCDate(),
        cfg.businessEndHour,
      ) -
      tzOffsetMin * 60 * 1000;

    for (
      let slotStart = dayStartLocalMs;
      slotStart + stepMs <= dayEndLocalMs;
      slotStart += stepMs
    ) {
      const slotEnd = slotStart + stepMs;
      if (slotStart < Date.now()) continue;
      const isBusy = busyMs.some((b) =>
        overlaps(slotStart, slotEnd, b.start, b.end),
      );
      if (!isBusy) slots.push(new Date(slotStart).toISOString());
    }
  }

  return slots.slice(0, 20); // cap to keep the prompt lean
}

// ──────────────────────────────────────────────────────────────────────────────
// Events
// ──────────────────────────────────────────────────────────────────────────────

export interface CreateEventInput {
  summary: string;
  description?: string;
  startISO: string;
  durationMinutes?: number;
  attendeeEmail?: string | null;
}

export interface CreateEventResult {
  id: string;
  htmlLink?: string;
}

export async function createEvent(
  cfg: GCalConfig,
  input: CreateEventInput,
): Promise<CreateEventResult> {
  const token = await getAccessToken(cfg);

  const startMs = Date.parse(input.startISO);
  if (Number.isNaN(startMs)) throw new Error("Fecha/hora inválida");
  const endMs = startMs + (input.durationMinutes ?? 30) * 60 * 1000;

  // NOTE: we deliberately do NOT set `attendees` here. Google rejects
  // attendee invites from a bare service account with a 403
  // "forbiddenForServiceAccounts" error unless the account has
  // Domain-Wide Delegation (only available on paid Google Workspace, not
  // a personal @gmail.com calendar). Fold the contact's email into the
  // description instead so it's still visible on the event.
  const description = [
    input.description,
    input.attendeeEmail ? `Email del contacto: ${input.attendeeEmail}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const body: Record<string, unknown> = {
    summary: input.summary,
    description: description || undefined,
    start: {
      dateTime: new Date(startMs).toISOString(),
      timeZone: cfg.timezone,
    },
    end: { dateTime: new Date(endMs).toISOString(), timeZone: cfg.timezone },
  };

  const res = await fetch(
    `${CAL_BASE}/calendars/${encodeURIComponent(cfg.calendarId)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(
      `Google Calendar error: ${res.status} ${err.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as { id: string; htmlLink?: string };
  return { id: data.id, htmlLink: data.htmlLink };
}

/** Reads basic calendar metadata — used by the "Probar conexión" button. */
export async function testConnection(
  cfg: GCalConfig,
): Promise<{ summary: string; timeZone: string }> {
  const token = await getAccessToken(cfg);
  const res = await fetch(
    `${CAL_BASE}/calendars/${encodeURIComponent(cfg.calendarId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(
      `Google Calendar error: ${res.status} ${err.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as { summary?: string; timeZone?: string };
  return {
    summary: data.summary ?? cfg.calendarId,
    timeZone: data.timeZone ?? cfg.timezone,
  };
}
