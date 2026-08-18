import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, readDbRO, addCandidates, removeOwnCandidate, sweepOwnOrphans, getBlocklist, isBlockedBy, freezeState, voterSanction, roundKeyOf, type NewCandidate } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { getActiveCompetition } from "@/lib/engine";
import { getVoterId, getDeviceBucket } from "@/lib/voter";
import { getSid } from "@/lib/sid";
import { rateLimited } from "@/lib/ratelimit";
import { clientIp } from "@/lib/ip";
import { gateOn, verifyToken, VOTER_COOKIE } from "@/lib/wxsession";
import { characterDetail, subjectCharacters, subjectNames, jpOfCharacter, jpOfSubject, normalizeImage, type JpVerdict } from "@/lib/bgm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Importing a whole series resolves up to 60 characters upstream (concurrency-capped in lib/bgm),
// so this route legitimately runs far longer than a vote. Declare the budget rather than letting a
// platform default cut it off halfway through and leave a partially-imported pool.
export const maxDuration = 120;

/** Map an origin verdict onto the stored status. null (couldn't tell) is NOT a failure. */
function jpFields(v: JpVerdict | null): { jpStatus: "ok" | "flagged" | "unknown" | null; jpReason: string | null } {
  if (!v) return { jpStatus: null, jpReason: null };
  if (v.ok === true) return { jpStatus: "ok", jpReason: v.reason };
  if (v.ok === false) return { jpStatus: "flagged", jpReason: v.reason };
  return { jpStatus: "unknown", jpReason: v.reason };
}

export async function POST(req: NextRequest) {
  try {
    if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。请设置环境变量 API_ENABLED=true 后重新部署。", disabled: true }, { status: 503 });

    // per-IP nominate cap is a coarse abuse guard; loosen it a lot when the WeChat gate is
    // off (no strong identity, and legit voters share IPs behind NAT).
    if (rateLimited("nominate:" + clientIp(req.headers), gateOn() ? 30 : 200, 60_000))
      return NextResponse.json({ error: "操作太频繁，请稍后再试。" }, { status: 429 });
    // per-identity cap on the unforgeable sid (rotating x-fp can't reset it)
    if (rateLimited("nomv:" + (await getSid()), gateOn() ? 30 : 120, 60_000))
      return NextResponse.json({ error: "提名太频繁，请稍后再试。" }, { status: 429 });

    ensureSchema();
    // One snapshot for every pre-flight check below. This used to be four separate whole-file
    // reads (getActiveCompetition, a second getActiveCompetition, freezeState, getBlocklist).
    const snap = readDbRO();
    const comp = getActiveCompetition(snap);
    if (!comp) return NextResponse.json({ error: "还没有进行中的比赛。" }, { status: 400 });
    if (comp.phase !== "nomination") return NextResponse.json({ error: "提名阶段已结束。" }, { status: 400 });

    const vid = await getVoterId();

    const fz = freezeState(comp.id, Date.now(), snap);
    if (fz.active) return NextResponse.json({ error: fz.note || "系统维护中，暂停提名，请稍后再来。", frozen: true }, { status: 503 });
    // 本轮被作废过票的身份，本轮连提名也一并停掉——否则禁投形同虚设（还能继续加角色）
    const sanc = voterSanction({ voterId: vid, bucket: await getDeviceBucket() }, roundKeyOf(comp), snap);
    if (sanc?.blockedThisRound)
      // count 可以是 0：智能删票为了「每个角色留一张票」保留了它那张，但身份仍本轮封禁。
      // 此时绝不能说「0 张票被作废」。
      return NextResponse.json({ error: sanc.count > 0
        ? `你在本轮有 ${sanc.count} 张票因异常投票被作废，本轮已不能再提名或投票。`
        : `你的投票被判定为异常投票（同一设备/网络重复投票），本轮已不能再提名或投票。`, sanctioned: true }, { status: 403 });

    // WeChat gate: when on, only users arriving via a per-user 公众号 link may modify the pool.
    if (gateOn() && !verifyToken(req.cookies.get(VOTER_COOKIE)?.value))
      return NextResponse.json({ error: "请在公众号回复「投票」获取链接后再提名。", needLink: true }, { status: 403 });

    const body = await req.json();
    const bl = getBlocklist(comp.id);

    // ── page-close beacon: drop the caller's own un-voted (0-vote) self-nominations ──
    if (body.sweep === true) {
      return NextResponse.json({ ok: true, removed: sweepOwnOrphans(comp.id, vid) });
    }

    // ── remove a character the current user nominated (only if it has 0 votes) ──
    if (body.remove != null) {
      const r = removeOwnCandidate(comp.id, Number(body.remove), vid);
      if ("error" in r) return NextResponse.json({ error: r.error }, { status: 400 });
      return NextResponse.json({ ok: true });
    }

    // ── add ONE character, resolved server-side ────────────────────────────
    // The client sends just a bangumi id. The server fetches the character's names (including
    // the 简体中文名 from the infobox), its icon, its primary work in three languages, and runs
    // the Japan-origin check -- work the browser used to do over several cross-border round
    // trips, often on a phone connection that couldn't finish them.
    if (body.addChar != null) {
      const rawId = String(body.addChar).replace(/^c/, "").replace(/\D/g, "");
      if (!rawId) return NextResponse.json({ error: "无效的角色 id。" }, { status: 400 });

      const info = await characterDetail(rawId);
      if (!info) return NextResponse.json({ error: "查不到该角色，请稍后再试。" }, { status: 502 });

      const why = isBlockedBy(bl, info.subjectName || info.subjectNameJa, []);
      if (why) return NextResponse.json({ error: why }, { status: 400 });

      const jp = await jpOfCharacter(rawId);
      const { added } = addCandidates(comp.id, [{ ...info, ...jpFields(jp) }], vid);
      return NextResponse.json({
        ok: true, added,
        duplicate: added === 0,
        name: info.nameCn || info.name,
        // jp: true = passed, false = flagged for review, null = couldn't tell (say nothing)
        jp: jp.ok, jpReason: jp.reason,
      });
    }

    // ── import a whole series, resolved server-side ─────────────────────────
    if (body.importSubject != null) {
      const sid = String(body.importSubject).replace(/\D/g, "");
      if (!sid) return NextResponse.json({ error: "无效的作品 id。" }, { status: 400 });

      const names = await subjectNames(sid);
      const shownName = names.zh || names.ja || `#${sid}`;
      const why = isBlockedBy(bl, names.zh || names.ja, Array.isArray(body.tags) ? body.tags.map(String) : []);
      if (why) return NextResponse.json({ error: why }, { status: 400 });

      const [chars, jp] = await Promise.all([subjectCharacters(sid), jpOfSubject(sid)]);
      if (!chars.length) return NextResponse.json({ error: "这部作品下没有可导入的角色。" }, { status: 400 });

      const jpf = jpFields(jp);
      const { added, skipped } = addCandidates(comp.id, chars.map((c) => ({ ...c, ...jpf })), vid);
      return NextResponse.json({
        ok: true, added, skipped, imported: chars.length,
        subjectName: shownName, jp: jp.ok, jpReason: jp.reason,
      });
    }

    // ── client-resolved batch (LEGACY) ─────────────────────────────────────
    // Kept so a browser tab loaded before this deploy still works: it resolves characters itself
    // and posts them here. New clients use addChar / importSubject above.
    if (Array.isArray(body.batch)) {
      const rows: NewCandidate[] = [];
      const blocked: string[] = [];
      for (const c of body.batch.slice(0, 200)) {
        const name = String(c?.name || "").trim();
        if (!name) continue;
        const bgmId = String(c?.bgmId || "m_" + Math.random().toString(36).slice(2, 8));
        const nameCn = String(c?.nameCn || "").trim();
        const subjectName = String(c?.subjectName || "").trim();
        const why = isBlockedBy(bl, subjectName, Array.isArray(c?.tags) ? c.tags.map(String) : []);
        if (why) { blocked.push(`${nameCn || name}：${why}`); continue; }
        rows.push({
          bgmId, name, nameCn,
          image: normalizeImage(c?.image),
          subjectName,
          nameEn: String(c?.nameEn || "").trim(),
          subjectNameJa: String(c?.subjectNameJa || "").trim(),
          subjectNameEn: String(c?.subjectNameEn || "").trim(),
          // Legacy clients do their own origin check and only show a warning; the server has no
          // verdict to record here, so the candidate carries none (and stays out of the review
          // queue rather than being wrongly flagged).
        });
      }
      const { added } = addCandidates(comp.id, rows, vid);
      return NextResponse.json({
        ok: true, added, imported: body.batch.length, blocked,
        ...(blocked.length && !added ? { error: "全部被黑名单拦截：" + blocked.slice(0, 3).join("；") } : {}),
      });
    }

    return NextResponse.json({ error: "缺少角色信息。" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "nominate failed" }, { status: 500 });
  }
}
