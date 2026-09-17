import { NextRequest, NextResponse } from "next/server";
import { createClient as svcClient } from "@supabase/supabase-js";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";

// GET /api/workspace/[id]/tool-calls/recent?limit=20
// Debug/audit view over the tool_call events already logged by the tool
// registry (registry.ts → logToolCall). Lets admins see whether a given
// tool actually ran, and why it failed, without digging through Vercel logs.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const auth = await requireWorkspaceMember(workspaceId);
  if (!auth.ok) return auth.response;

  const limitParam = Number(req.nextUrl.searchParams.get("limit") ?? "20");
  const limit = Math.min(Math.max(limitParam || 20, 1), 100);

  const svc = svcClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data, error } = await svc
    .from("events")
    .select("id, created_at, level, payload")
    .eq("workspace_id", workspaceId)
    .eq("type", "tool_call")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ calls: data ?? [] });
}
