import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, readDbRO, toggleNomination, castMatchVote, castApprovalVote, resolveCandidate, freezeState, breakState, voterSanction, roundKeyOf } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { getVoterId, getDeviceBucket } from "@/lib/voter";
import { getSid } from "@/lib/sid";
import { getActiveCompetition } from "@/lib/engine";
import { rateLimited } from "@/lib/ratelimit";
import { verifyToken, gateOn, VOTER_COOKIE } from "@/lib/wxsession";
import { clientIp } from "@/lib/ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。请设置环境变量 API_ENABLED=true 后重新部署。", disabled: true }, { status: 503 });
    ensureSchema();
    const vid = await getVoterId();
    const bucket = await getDeviceBucket();
    const ip = clientIp(req.headers);
    const meta = { bucket, ip };

    // WeChat gate (admin-toggleable): only users who opened a per-user link from the 公众号
    // may vote; direct site visitors are read-only. openid becomes the dedup identity.
    let voterId = vid;
    const strict = gateOn();
    if (strict) {
      const openid = verifyToken(req.cookies.get(VOTER_COOKIE)?.value);
      if (!openid) return NextResponse.json({ error: "请在公众号回复「投票」获取投票链接后再来投票。", needLink: true }, { status: 403 });
      voterId = "wx:" + openid;
    }

    // Rate limiting. The per-identity cap keys on the server-signed sid (see lib/sid.ts) so
    // rotating the client `x-fp` header can't reset it. When the WeChat gate is on, the openid
    // session is an even stronger identity. The per-IP cap is a coarse abuse guard, loosened
    // when the gate is off since many legitimate voters share one IP (campus/dorm NAT).
    const rlKey = strict ? voterId : await getSid();
    if (rateLimited("votev:" + rlKey, 60, 60_000))
      return NextResponse.json({ error: "投票太频繁，请稍后再试。" }, { status: 429 });
    if (rateLimited("vote:" + ip, strict ? 120 : 1000, 60_000))
      return NextResponse.json({ error: "该网络投票过于密集，请稍后再试。" }, { status: 429 });

    // One snapshot for all pre-flight checks. Previously each of getActiveCompetition,
    // freezeState, voterSanction and resolveCandidate deep-cloned the entire data file, so a
    // single vote cost five clones before it wrote anything.
    const snap = readDbRO();
    const comp = getActiveCompetition(snap);
    if (!comp) return NextResponse.json({ error: "没有进行中的比赛。" }, { status: 400 });

    // 维护冻结：停投期间一律不写票，admin 可安心改数据
    const fz = freezeState(comp.id, Date.now(), snap);
    if (fz.active) return NextResponse.json({ error: fz.note || "系统维护中，暂停投票，请稍后再来。", frozen: true }, { status: 503 });

    // 休赛期：本轮投票已结束、结算前留出的查票窗口。票数此刻必须固定，否则「先查后算」就没意义了。
    const bk = breakState(comp.id, Date.now(), snap);
    if (bk.active) return NextResponse.json({
      error: "本轮投票已结束，正在休赛期核对票数，下一轮开始后即可投票。",
      onBreak: true, breakUntil: bk.until,
    }, { status: 503 });

    // 本轮被作废过票的身份，本轮不得再投（换 voter_id 也拦得住：设备标识已含 IP）
    const round = roundKeyOf(comp);
    const sanc = voterSanction({ voterId, bucket: meta.bucket }, round, snap);
    if (sanc?.blockedThisRound)
      // count 可以是 0：智能删票为了「每个角色留一张票」保留了它那张，但身份仍本轮封禁。
      // 此时绝不能说「0 张票被作废」。
      return NextResponse.json({ error: sanc.count > 0
        ? `你在本轮有 ${sanc.count} 张票因异常投票被作废，本轮已不能再投票。下一轮可正常参与。`
        : `你的投票被判定为异常投票（同一设备/网络重复投票），本轮已不能再投票。下一轮可正常参与。`, sanctioned: true }, { status: 403 });

    const body = await req.json();

    // ── nomination upvote (toggle) ──
    if (body.type === "nominate") {
      if (comp.phase !== "nomination") return NextResponse.json({ error: "提名投票已结束。" }, { status: 400 });
      const cand = resolveCandidate(comp.id, body.bgmId ?? body.candidateId);
      if (!cand) return NextResponse.json({ error: "角色不存在。" }, { status: 404 });
      const r = toggleNomination(comp.id, cand.id, voterId, meta);
      if (!r) return NextResponse.json({ error: "角色不存在。" }, { status: 404 });
      if ("error" in r) return NextResponse.json({ error: r.error }, { status: 400 });
      return NextResponse.json({ ok: true, voted: r.voted });
    }

    // ── group approval vote (approval mode: ≤2 picks per group) ──
    if (body.type === "approval") {
      if (comp.phase !== "group") return NextResponse.json({ error: "当前不在小组赛阶段。" }, { status: 400 });
      const cand = resolveCandidate(comp.id, body.bgmId ?? body.candidateId);
      if (!cand) return NextResponse.json({ error: "角色不存在。" }, { status: 404 });
      const r = castApprovalVote(comp.id, cand.id, voterId, meta);
      if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
      return NextResponse.json({ ok: true, picked: r.picked, count: r.count });
    }

    // ── matchup vote (group or knockout) ──
    if (body.type === "match") {
      if (comp.phase !== "group" && comp.phase !== "knockout" && comp.phase !== "playoff") return NextResponse.json({ error: "当前没有开放的对战。" }, { status: 400 });
      const pick = resolveCandidate(comp.id, body.choiceBgmId ?? body.choiceId);
      if (!pick) return NextResponse.json({ error: "无效的选择。" }, { status: 400 });
      const r = castMatchVote(comp.id, Number(body.matchupId), voterId, pick.id, meta);
      if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
      return NextResponse.json({ ok: true, choice: r.choice });
    }

    return NextResponse.json({ error: "未知投票类型。" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "vote failed" }, { status: 500 });
  }
}
