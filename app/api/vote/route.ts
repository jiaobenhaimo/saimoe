import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, sql } from "@/lib/db";
import { getVoterId } from "@/lib/voter";
import { getActiveCompetition } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const vid = await getVoterId();
    const comp = await getActiveCompetition();
    if (!comp) return NextResponse.json({ error: "没有进行中的比赛。" }, { status: 400 });

    const body = await req.json();

    // ── nomination upvote (toggle) ──
    if (body.type === "nominate") {
      if (comp.phase !== "nomination")
        return NextResponse.json({ error: "提名投票已结束。" }, { status: 400 });
      const candidateId = Number(body.candidateId);
      const owned = (await sql`SELECT * FROM candidate WHERE id=${candidateId} AND competition_id=${comp.id}`) as any[];
      if (!owned.length) return NextResponse.json({ error: "角色不存在。" }, { status: 404 });

      const existing = (await sql`SELECT 1 FROM nomination_vote
        WHERE competition_id=${comp.id} AND voter_id=${vid} AND candidate_id=${candidateId}`) as any[];
      if (existing.length) {
        await sql`DELETE FROM nomination_vote
          WHERE competition_id=${comp.id} AND voter_id=${vid} AND candidate_id=${candidateId}`;
        return NextResponse.json({ ok: true, voted: false });
      }
      await sql`INSERT IGNORE INTO nomination_vote (competition_id, candidate_id, voter_id)
        VALUES (${comp.id}, ${candidateId}, ${vid})`;
      return NextResponse.json({ ok: true, voted: true });
    }

    // ── matchup vote (group or knockout) ──
    if (body.type === "match") {
      if (comp.phase !== "group" && comp.phase !== "knockout")
        return NextResponse.json({ error: "当前没有开放的对战。" }, { status: 400 });
      const matchupId = Number(body.matchupId);
      const choiceId = Number(body.choiceId);
      const m = (await sql`SELECT * FROM matchup WHERE id=${matchupId} AND competition_id=${comp.id}`) as any[];
      if (!m.length) return NextResponse.json({ error: "对战不存在。" }, { status: 404 });
      if (m[0].decided) return NextResponse.json({ error: "该场已结束,不能再投票。" }, { status: 400 });
      if (choiceId !== m[0].a_id && choiceId !== m[0].b_id)
        return NextResponse.json({ error: "无效的选择。" }, { status: 400 });

      const cur = (await sql`SELECT choice_id FROM match_vote
        WHERE matchup_id=${matchupId} AND voter_id=${vid}`) as any[];
      if (cur.length && cur[0].choice_id === choiceId) {
        // clicking your current pick again = retract vote
        await sql`DELETE FROM match_vote WHERE matchup_id=${matchupId} AND voter_id=${vid}`;
        return NextResponse.json({ ok: true, choice: null });
      }
      await sql`INSERT INTO match_vote (matchup_id, voter_id, choice_id)
        VALUES (${matchupId}, ${vid}, ${choiceId})
        ON DUPLICATE KEY UPDATE choice_id=VALUES(choice_id)`;
      return NextResponse.json({ ok: true, choice: choiceId });
    }

    return NextResponse.json({ error: "未知投票类型。" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "vote failed" }, { status: 500 });
  }
}
