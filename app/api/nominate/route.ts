import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, sql } from "@/lib/db";
import { getActiveCompetition } from "@/lib/engine";
import { getCharacter, getSubjectCharacters, parseSubjectId, type BgmHit } from "@/lib/bangumi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function insertCandidate(cid: number, bgmId: string, name: string, nameCn: string, image: string) {
  const res = (await sql`
    INSERT IGNORE INTO candidate (competition_id, bgm_id, name, name_cn, image)
    VALUES (${cid}, ${bgmId}, ${name}, ${nameCn || null}, ${image || null})`) as any;
  return res.affectedRows > 0;
}

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const comp = await getActiveCompetition();
    if (!comp) return NextResponse.json({ error: "还没有进行中的比赛。" }, { status: 400 });
    if (comp.phase !== "nomination")
      return NextResponse.json({ error: "提名阶段已结束。" }, { status: 400 });

    const body = await req.json();

    // ── batch: import a whole subject's cast ──
    if (body.subject) {
      const sid = parseSubjectId(String(body.subject));
      if (!sid) return NextResponse.json({ error: "无法识别作品 ID / 链接。" }, { status: 400 });
      const cast: BgmHit[] = await getSubjectCharacters(sid);
      let added = 0;
      for (const c of cast) {
        if (await insertCandidate(comp.id, c.bgmId, c.name, "", c.image)) added++;
      }
      return NextResponse.json({ ok: true, imported: cast.length, added });
    }

    // ── single from Bangumi id ──
    if (body.bgmId) {
      const d = await getCharacter(String(body.bgmId));
      const added = await insertCandidate(comp.id, d.bgmId, d.name, d.nameCn, d.image);
      return NextResponse.json({ ok: true, added });
    }

    // ── manual add ──
    if (body.manual?.name) {
      const name = String(body.manual.name).trim();
      const nameCn = String(body.manual.nameCn || "").trim();
      const image = String(body.manual.image || "").trim();
      const bgmId = "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const added = await insertCandidate(comp.id, bgmId, name, nameCn, image);
      return NextResponse.json({ ok: true, added });
    }

    return NextResponse.json({ error: "缺少角色信息。" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "nominate failed" }, { status: 500 });
  }
}
