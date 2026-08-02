import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, createCompetition, deleteCompetition } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { getActiveCompetition, startGroups, startKnockout, advanceKnockout, updateCompetition, scheduleCompetition, clearSchedule } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: NextRequest): boolean {
  const token = req.headers.get("x-admin-token");
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "未授权：管理员令牌不正确。" }, { status: 401 });
  if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。请设置环境变量 API_ENABLED=true 后重新部署。", disabled: true }, { status: 503 });
  try {
    ensureSchema();
    const body = await req.json();
    const action = body.action as string;

    if (action === "create") {
      const title = String(body.title || "Bangumi 世萌大会").trim();
      const id = createCompetition(title);
      return NextResponse.json({ ok: true, id });
    }

    const comp = getActiveCompetition();
    if (!comp) return NextResponse.json({ error: "还没有比赛，请先创建。" }, { status: 400 });

    if (action === "update") { updateCompetition(comp.id, String(body.title ?? ""), body.description ?? null); return NextResponse.json({ ok: true }); }
    if (action === "schedule") {
      scheduleCompetition(comp.id, {
        nomEndsAt: Number(body.nomEndsAt) || null,
        autoSize: Number(body.size), autoGroups: Number(body.groups), autoAdvance: Number(body.advance),
        groupHours: body.groupHours ? Number(body.groupHours) : null,
        roundHours: body.roundHours ? Number(body.roundHours) : null,
        postponeDays: Number(body.postponeDays) || 1,
      });
      return NextResponse.json({ ok: true });
    }
    if (action === "unschedule") { clearSchedule(comp.id); return NextResponse.json({ ok: true }); }
    if (action === "start_groups") { startGroups(comp.id, Number(body.size), Number(body.groups), Number(body.advance)); return NextResponse.json({ ok: true }); }
    if (action === "start_knockout") { startKnockout(comp.id); return NextResponse.json({ ok: true }); }
    if (action === "advance") { advanceKnockout(comp.id); return NextResponse.json({ ok: true }); }
    if (action === "reset") { deleteCompetition(comp.id); return NextResponse.json({ ok: true }); }

    return NextResponse.json({ error: "未知操作。" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "admin action failed" }, { status: 400 });
  }
}
