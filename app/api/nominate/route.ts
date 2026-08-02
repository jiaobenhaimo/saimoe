import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, sql } from "@/lib/db";
import { getActiveCompetition } from "@/lib/engine";
import { getCharacter } from "@/lib/bangumi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const comp = await getActiveCompetition();
    if (!comp) return NextResponse.json({ error: "还没有进行中的比赛。" }, { status: 400 });
    if (comp.phase !== "nomination")
      return NextResponse.json({ error: "提名阶段已结束。" }, { status: 400 });

    const body = await req.json();
    let name: string, nameCn: string, image: string, bgmId: string;

    if (body.bgmId) {
      const d = await getCharacter(String(body.bgmId));
      bgmId = d.bgmId;
      name = d.name;
      nameCn = d.nameCn;
      image = d.image;
    } else if (body.manual?.name) {
      name = String(body.manual.name).trim();
      nameCn = String(body.manual.nameCn || "").trim();
      image = String(body.manual.image || "").trim();
      bgmId = "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    } else {
      return NextResponse.json({ error: "缺少角色信息。" }, { status: 400 });
    }

    const res = (await sql`
      INSERT IGNORE INTO candidate (competition_id, bgm_id, name, name_cn, image)
      VALUES (${comp.id}, ${bgmId}, ${name}, ${nameCn || null}, ${image || null})`) as any;

    // affectedRows is 1 if a new row was inserted, 0 if IGNORE swallowed a duplicate.
    return NextResponse.json({ ok: true, added: res.affectedRows > 0 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "nominate failed" }, { status: 500 });
  }
}
