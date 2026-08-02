import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, sql } from "@/lib/db";
import { getActiveCompetition, startGroups, startKnockout, advanceKnockout, updateCompetition } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: NextRequest): boolean {
  const token = req.headers.get("x-admin-token");
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "未授权:管理员令牌不正确。" }, { status: 401 });
  try {
    await ensureSchema();
    const body = await req.json();
    const action = body.action as string;

    if (action === "create") {
      const title = String(body.title || "Bangumi 世萌大会").trim();
      const res = (await sql`INSERT INTO competition (title, phase) VALUES (${title}, 'nomination')`) as any;
      return NextResponse.json({ ok: true, id: res.insertId });
    }

    const comp = await getActiveCompetition();
    if (!comp) return NextResponse.json({ error: "还没有比赛,请先创建。" }, { status: 400 });

    if (action === "update") {
      await updateCompetition(comp.id, String(body.title ?? ""), body.description ?? null);
      return NextResponse.json({ ok: true });
    }
    if (action === "start_groups") {
      await startGroups(
        comp.id,
        Number(body.size),
        Number(body.groups),
        Number(body.advance)
      );
      return NextResponse.json({ ok: true });
    }
    if (action === "start_knockout") {
      await startKnockout(comp.id);
      return NextResponse.json({ ok: true });
    }
    if (action === "advance") {
      await advanceKnockout(comp.id);
      return NextResponse.json({ ok: true });
    }
    if (action === "reset") {
      await sql`DELETE FROM competition WHERE id=${comp.id}`;
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "未知操作。" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "admin action failed" }, { status: 400 });
  }
}
