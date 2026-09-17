import { NextRequest, NextResponse } from "next/server";
import {
  getGCalConfig,
  testConnection,
} from "@/features/inbox/services/google-calendar-client";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";

// POST /api/workspace/[id]/integrations/google-calendar/test
// Verifies the saved service-account credentials + Calendar ID by reading
// the calendar's own metadata (fails if it wasn't shared with the SA).
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const auth = await requireWorkspaceMember(workspaceId);
  if (!auth.ok) return auth.response;

  const cfg = await getGCalConfig(workspaceId);
  if (!cfg) {
    return NextResponse.json({
      ok: false,
      error: "Falta el Service Account o el Calendar ID",
    });
  }

  try {
    const info = await testConnection(cfg);
    return NextResponse.json({
      ok: true,
      calendarName: info.summary,
      timeZone: info.timeZone,
    });
  } catch (err) {
    console.error(
      "[integrations/google-calendar/test] error:",
      err instanceof Error ? err.message : "unknown",
    );
    return NextResponse.json({
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "No se pudo conectar con Google Calendar",
    });
  }
}
