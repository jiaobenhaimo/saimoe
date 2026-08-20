import { readDb, readDbRO, writeDb, commentCounts, approvalTally, groupBatch, type DB, type Competition, type Candidate, type Matchup, nominationTally, freezeOf, breakOf, topLevel } from "./db";

// ── reads ─────────────────────────────────────────────────────
/** The newest competition, or null. Pass `snap` to reuse a snapshot the caller already read —
 *  routes that need several reads should read once and thread it through (see /api/vote). */
export function getActiveCompetition(snap?: DB): Competition | null {
  const db = snap ?? readDbRO();
  if (!db.competitions.length) return null;
  return db.competitions.reduce((a, b) => (b.id > a.id ? b : a));
}

function matchCounts(db: DB, cid: number): Map<string, number> {
  const ids = new Set(db.matchups.filter((m) => m.competition_id === cid).map((m) => m.id));
  const c = new Map<string, number>();
  for (const v of db.matchVotes) if (ids.has(v.matchup_id)) {
    const k = v.matchup_id + ":" + v.choice_id;
    c.set(k, (c.get(k) || 0) + 1);
  }
  return c;
}

/**
 * What opens when the current break ends.
 *
 * During a break the phase has NOT advanced yet, so the client cannot work this out from the
 * competition record alone -- it would have to duplicate the batching rules for which groups open
 * on which matchday. Computing it here keeps one source of truth, and lets the countdown box say
 * 「A、B 组小组赛开始」 instead of the deadline that has already passed.
 *
 * Returns null when nothing meaningful follows (e.g. the tournament is finished).
 */
function nextUpAfterBreak(db: DB, comp: Competition): { kind: "group"; matchday: number; groups: number[] } | { kind: "ko"; label: string } | null {
  const perDay = comp.groups_per_day && comp.groups_per_day > 0 ? comp.groups_per_day : 2;
  const groupsOn = (md: number, total: number): number[] =>
    Array.from({ length: total }, (_, i) => i).filter((g) => groupBatch(g, perDay) === md);

  if (comp.phase === "nomination") {
    // 提名截止后的休赛期 → 接下来是小组赛第 1 比赛日。抽签还没发生，组号按计划的组数推。
    const N = comp.auto_size ?? 0;
    const G = Math.max(2, Math.floor(comp.group_size ?? 4));
    const total = N >= 4 ? Math.max(1, Math.floor(N / G)) : 0;
    if (!total) return null;
    return { kind: "group", matchday: 1, groups: groupsOn(1, total) };
  }
  if (comp.phase === "group") {
    const cur = comp.group_matchday ?? 1;
    const count = comp.group_matchday_count ?? 1;
    const total = comp.groups_count ?? 0;
    if (cur < count && total > 0) return { kind: "group", matchday: cur + 1, groups: groupsOn(cur + 1, total) };
    // 最后一个比赛日之后 → 淘汰赛首轮
    const koT = comp.ko_target ?? 0;
    return koT >= 2 ? { kind: "ko", label: roundLabel(koT) } : null;
  }
  if (comp.phase === "playoff") {
    const koT = comp.ko_target ?? 0;
    return koT >= 2 ? { kind: "ko", label: roundLabel(koT) } : null;
  }
  if (comp.phase === "knockout") {
    const koMs = db.matchups.filter((m) => m.competition_id === comp.id && m.stage === "knockout");
    if (!koMs.length) return null;
    const maxRn = Math.max(...koMs.map((m) => m.round_no));
    const cur = koMs.filter((m) => m.round_no === maxRn);
    const thirdOn = comp.third_place !== false;
    // 半决赛之后先打季军战（如启用），否则按人数减半推下一轮
    if (cur.length === 2 && thirdOn && !cur.some((m) => (m as any).bronze)) return { kind: "ko", label: "bronze" };
    if (cur.some((m) => (m as any).bronze)) return { kind: "ko", label: roundLabel(2) };
    const nextContestants = cur.length; // 每场出一个胜者
    return nextContestants >= 2 ? { kind: "ko", label: roundLabel(nextContestants) } : null;
  }
  return null;
}

// ── full state for the UI, personalised to one voter ─────────
export function getState(voterId: string, snap?: DB) {
  const db = snap ?? readDbRO();
  const comp = db.competitions.length ? db.competitions.reduce((a, b) => (b.id > a.id ? b : a)) : null;
  if (!comp) return { competition: null };

  const cands = db.candidates.filter((c) => c.competition_id === comp.id).sort((a, b) => a.id - b.id);
  const slim = (c: Candidate | undefined) =>
    c ? { id: c.id, bgmId: c.bgm_id, aliases: c.aliases || [], name: c.name, nameCn: c.name_cn, nameEn: c.name_en ?? null, image: c.image, subjectName: c.subject_name ?? null, subjectNameJa: c.subject_name_ja ?? null, subjectNameEn: c.subject_name_en ?? null,
        // 「待复核」标记：只有明确没查到「日本」标签的新角色才为 true（老数据 jp_status 缺失 → false）
        jpPending: c.jp_status === "flagged" } : null;

  const base = {
    competition: {
      id: comp.id, title: comp.title, description: comp.description, shortName: comp.short_name ?? "", phase: comp.phase,
      titleEn: comp.title_en ?? "", titleJa: comp.title_ja ?? "", descEn: comp.desc_en ?? "", descJa: comp.desc_ja ?? "", shortEn: comp.short_en ?? "", shortJa: comp.short_ja ?? "",
      blockedTags: comp.blocked_tags || [], blockedSubjects: comp.blocked_subjects || [],
      freeze: freezeOf(comp),
      // 休赛期：本轮已停投、正在核对票数，下一轮到点自动开始。前端据此显示倒计时并禁用投票按钮。
      // nextUp 说明「休赛期结束后开始的是什么」——倒计时框要显示这个，而不是已经过去的截止时间。
      onBreak: { ...breakOf(comp), nextUp: breakOf(comp).active ? nextUpAfterBreak(db, comp) : null },
      groupsCount: comp.groups_count, championId: comp.champion_id,
      targetSize: comp.target_size ?? null,
      nomEndsAt: comp.nom_ends_at ?? null, groupEndsAt: comp.group_ends_at ?? null, koRoundEndsAt: comp.ko_round_ends_at ?? null,
      koRound: comp.ko_round ?? null, // 前端要用它拼当前轮次键（禁投判定必须与服务端一致）
      postponeDays: comp.postpone_days ?? null,
      nomUserLimit: comp.nom_user_limit ?? 0, nomMinVotes: comp.nom_min_votes ?? 0,
      groupMatchday: comp.group_matchday ?? null, groupMatchdayCount: comp.group_matchday_count ?? null,
      groupRoundEndsAt: comp.group_round_ends_at ?? null,
      groupPerRound: comp.group_per_round ?? 0, groupRoundDays: comp.group_round_days ?? 0,
      groupDayCap: comp.group_day_cap ?? 4, roundHours: comp.round_hours ?? 0, groupSize: comp.group_size ?? null,
      koTarget: comp.ko_target ?? null,
      // 供 admin 表单回填：不回填的话，重新打开后台再点一次「预约」就会把这些配置覆盖成默认值
      autoSize: comp.auto_size ?? null, groupMode: (comp.group_mode as any) ?? null,
      groupsPerDay: comp.groups_per_day ?? null, thirdPlace: comp.third_place ?? null,
    },
    schedule: projectSchedule(db, comp),
  };

  if (comp.phase === "nomination") {
    const { total: nomTotal, own: nomOwn } = nominationTally(db, comp.id);
    const nameById = new Map(cands.map((c) => [c.id, c.name_cn || c.name]));
    const myNomSet = new Set(db.nominationVotes.filter((v) => v.competition_id === comp.id && v.voter_id === voterId).map((v) => v.candidate_id));
    const pool = cands
      .map((c) => ({
        ...slim(c)!,
        // 上级显示合并组汇总票（同一人投多个只算一次）；子角色显示自己的票，另标注并入了谁
        votes: c.parent_id == null ? (nomTotal.get(c.id) || 0) : (nomOwn.get(c.id) || 0),
        mergedInto: c.parent_id != null ? (nameById.get(c.parent_id) || null) : null,
        voted: myNomSet.has(c.id), mine: (c.added_by || "") === voterId,
        tally_at: c.tally_at ?? null,
      }))
      // 平票 → 先达到这个票数的在前（加票、撤票、作废都算「达到」的时刻）
      .sort((x, y) => y.votes - x.votes || tieByReachedFirst(x, y) || x.name.localeCompare(y.name));
    return { ...base, nomination: { pool, userLimit: comp.nom_user_limit ?? 0, minVotes: comp.nom_min_votes ?? 0, myCount: myNomSet.size } };
  }

  const ms = db.matchups.filter((m) => m.competition_id === comp.id);
  const cmap = new Map(cands.map((c) => [c.id, c]));
  const counts = matchCounts(db, comp.id);
  const cc = commentCounts(comp.id, db);
  const myChoice = new Map<number, number>();
  const compMatchIds = new Set(ms.map((m) => m.id));
  for (const v of db.matchVotes) if (v.voter_id === voterId && compMatchIds.has(v.matchup_id)) myChoice.set(v.matchup_id, v.choice_id);

  const votesA = (m: Matchup) => counts.get(m.id + ":" + m.a_id) || 0;
  const votesB = (m: Matchup) => counts.get(m.id + ":" + m.b_id) || 0;
  const seedOf = (id: number) => cmap.get(id)?.seed ?? Number.MAX_SAFE_INTEGER;
  const liveWinner = (m: Matchup): number | null => {
    if (m.decided) return m.winner_id;
    const a = votesA(m), b = votesB(m);
    // 与 decide() 一致：平票判种子高者，种子相同判 A 方
    if (a !== b) return a > b ? m.a_id : m.b_id;
    return seedOf(m.a_id) <= seedOf(m.b_id) ? m.a_id : m.b_id;
  };
  // 赛中不公布任何票数/得票率；结算后（decided）才公布绝对票数与占比。
  const shapeMatch = (m: Matchup) => {
    const va = votesA(m), vb = votesB(m), total = va + vb;
    const revealed = m.decided;
    return {
      id: m.id, stage: m.stage, round: m.round_no, group: m.group_no, slot: m.slot,
      a: slim(cmap.get(m.a_id)), b: slim(cmap.get(m.b_id)),
      votesA: revealed ? va : null, votesB: revealed ? vb : null, total: revealed ? total : null,
      rateA: revealed && total ? Math.round((va / total) * 100) : null,
      winnerId: liveWinner(m), decided: m.decided, myChoice: myChoice.get(m.id) ?? null,
      commentN: cc[m.id] || 0,
    };
  };

  const result: any = { ...base };

  // nomination ranking — kept for the "预选" view (read-only) after nomination closes
  {
    const { total: nomTotal2 } = nominationTally(db, comp.id);
    const topIds = new Set(topLevel(db, comp.id).map((c) => c.id));
    result.nominationRanking = cands
      .filter((c) => topIds.has(c.id)) // 子角色票已汇总到上级，不重复出现
      .map((c) => ({ ...slim(c)!, votes: nomTotal2.get(c.id) || 0, tally_at: c.tally_at ?? null }))
      // 平票 → 先达到这个票数的在前；都是老数据时才退回按名字排（保持原有的稳定顺序）
      .sort((x, y) => y.votes - x.votes || tieByReachedFirst(x, y) || x.name.localeCompare(y.name));
  }

  // ── approval-mode group block (no matchups): group ballots, ≤2 picks per group ──
  const isApproval = (comp.group_mode ?? "approval") === "approval";
  const groupedCands = cands.filter((c) => c.group_no != null);
  if (isApproval && groupedCands.length && (comp.phase === "group" || comp.phase === "playoff" || comp.phase === "knockout" || comp.phase === "finished")) {
    const isGroupPhase = comp.phase === "group";
    const curMd = comp.group_matchday ?? 1;
    const perDay = comp.groups_per_day && comp.groups_per_day > 0 ? comp.groups_per_day : 2;
    const numGroups = comp.groups_count ?? (Math.max(...groupedCands.map((c) => c.group_no!)) + 1);
    const mdCount = comp.group_matchday_count ?? Math.max(1, Math.ceil(numGroups / perDay));
    const gtStarts = (comp.group_matchday_starts || {}) as Record<number, number>;
    const knownDays = Object.keys(gtStarts).map(Number).filter((n) => Number.isFinite(n));
    const maxKnownDay = knownDays.length ? Math.max(...knownDays) : 0;
    const roundMs = (comp.group_round_days || 0) * 86400_000;
    const dayDate = (d: number): number | null => {
      if (gtStarts[d] != null) return gtStarts[d];
      if (!comp.group_round_days) return null;
      if (maxKnownDay > 0) return gtStarts[maxKnownDay] + (d - maxKnownDay) * roundMs;
      if (comp.group_started_at != null) return comp.group_started_at + (d - 1) * roundMs;
      return null;
    };
    const tally = approvalTally(db, comp.id);
    const myPicks = new Set(db.approvalVotes.filter((v) => v.competition_id === comp.id && v.voter_id === voterId).map((v) => v.candidate_id));
    const byG = new Map<number, Candidate[]>();
    for (const c of groupedCands) { const g = c.group_no!; if (!byG.has(g)) byG.set(g, []); byG.get(g)!.push(c); }
    const groups = [...byG.entries()].sort((a, b) => a[0] - b[0]).map(([g, members]) => {
      const batch = groupBatch(g, perDay);
      const open = isGroupPhase && batch === curMd;              // currently votable
      const closed = !isGroupPhase || batch < curMd;             // finished voting (past batch) or stage over
      const upcoming = isGroupPhase && batch > curMd;            // not started yet
      const revealed = closed;                                   // reveal counts + top-2 ONLY once closed (never for open/upcoming)
      const rows = members.map((c) => ({ ...slim(c)!, votes: tally.get(c.id) || 0, mine: myPicks.has(c.id), seed: c.seed ?? 0, tally_at: c.tally_at ?? null }));
      rows.sort((x, y) => (revealed ? (y.votes - x.votes) : 0) || (revealed ? tieByReachedFirst(x, y) : 0) || (x.seed - y.seed));
      const shaped = rows.map((r, i) => ({ ...r, rank: i, advancing: revealed && i < 2, votes: revealed ? r.votes : null }));
      return { group: g, day: batch, open, closed, upcoming, date: dayDate(batch), members: shaped };
    });
    // one pass over my votes → per-group pick counts (was: a full approvalVotes scan per group)
    const myByGroup = new Map<number, number>();
    for (const v of db.approvalVotes)
      if (v.competition_id === comp.id && v.voter_id === voterId)
        myByGroup.set(v.group_no, (myByGroup.get(v.group_no) || 0) + 1);
    result.group = { mode: "approval", groups: groups.map((g) => ({ ...g, myPicks: myByGroup.get(g.group) || 0 })), matchday: curMd, matchdayCount: mdCount, groupsPerDay: perDay, perGroupVotes: 2 };
  }

  // ── group block: returned whenever group matches exist, so it stays viewable in later phases ──
  const groupMs = ms.filter((m) => m.stage === "group");
  if (groupMs.length) {
    const isGroupPhase = comp.phase === "group";
    const curMd = comp.group_matchday ?? 1;
    const mdCount = comp.group_matchday_count ?? 1;
    const byGroup = new Map<number, Matchup[]>();
    for (const m of groupMs) {
      const g = m.group_no ?? 0;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(m);
    }
    // once the group stage is over every match is decided, so all of them count
    const played = (m: Matchup) => m.decided || (isGroupPhase && (m.matchday ?? curMd) === curMd);
    // "Date" shown per matchday. Ground truth: the real moment each matchday actually
    // opened, recorded in comp.group_matchday_starts the instant it happened (startGroups
    // for day 1, advanceGroupMatchday for every day after). That value is written once and
    // never recomputed, so it can't drift when pace changes later or when the admin
    // advances early/late/manually. A matchday not yet reached has no recorded entry, so
    // it's ESTIMATED by projecting forward from the latest known matchday using the
    // CURRENT pace — which is correct, since an estimate for the future should track the
    // latest pace setting (only history must stay fixed).
    const gtStarts = (comp.group_matchday_starts || {}) as Record<number, number>;
    const knownDays = Object.keys(gtStarts).map(Number).filter((n) => Number.isFinite(n));
    const maxKnownDay = knownDays.length ? Math.max(...knownDays) : 0;
    const roundMs = (comp.group_round_days || 0) * 86400_000;
    const mdDate = (d: number): number | null => {
      const known = gtStarts[d];
      if (known != null) return known;
      if (!comp.group_round_days) return null;
      if (maxKnownDay > 0) return gtStarts[maxKnownDay] + (d - maxKnownDay) * roundMs;
      if (comp.group_started_at != null) return comp.group_started_at + (d - 1) * roundMs; // legacy 兜底（迁移前的老数据）
      return null;
    };
    const groups = [...byGroup.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([g, list]) => {
        list.sort((a, b) => (a.matchday ?? 1) - (b.matchday ?? 1) || a.slot - b.slot);
        const members = cands.filter((c) => c.group_no === g);
        const stand = members.map((c) => {
          let wins = 0, vf = 0;
          for (const m of list) {
            if (!played(m)) continue;
            if (m.a_id === c.id) vf += votesA(m);
            if (m.b_id === c.id) vf += votesB(m);
            if (liveWinner(m) === c.id) wins++;
          }
          return { ...slim(c)!, wins, votesFor: vf };
        });
        stand.sort((x, y) => y.wins - x.wins || y.votesFor - x.votesFor);
        const matchups = list.map((m) => ({ ...shapeMatch(m), matchday: m.matchday ?? 1, date: mdDate(m.matchday ?? 1), live: isGroupPhase && ((m.matchday ?? curMd) === curMd) && !m.decided }));
        // reveal group vote totals only after the stage is over (i.e. in the history view)
        return { group: g, standings: stand.map((s) => ({ ...s, votesFor: isGroupPhase ? null : s.votesFor })), matchups };
      });
    result.group = { mode: "rr", groups, matchday: curMd, matchdayCount: mdCount };
  }

  // ── playoff block: returned whenever playoff matches exist ──
  const pms = ms.filter((m) => m.stage === "playoff");
  if (pms.length) {
    const isPlayoffPhase = comp.phase === "playoff";
    const bandIds = [...new Set(pms.flatMap((m) => [m.a_id, m.b_id]))];
    const rows = bandIds.map((id) => {
      let wins = 0, vf = 0;
      for (const m of pms) {
        if (m.a_id === id) vf += votesA(m);
        if (m.b_id === id) vf += votesB(m);
        if (liveWinner(m) === id) wins++;
      }
      return { id, wins, vf };
    });
    rows.sort((x, y) => y.wins - x.wins || y.vf - x.vf);
    const standings = rows.map((r) => ({ ...slim(cmap.get(r.id))!, wins: r.wins, votesFor: null }));
    const matchups = pms.map((m) => ({ ...shapeMatch(m), live: isPlayoffPhase && !m.decided }));
    result.playoff = { standings, matchups, slots: comp.playoff_slots ?? 0, contenders: bandIds.length };
  }

  // ── knockout block: returned whenever knockout matches exist (also carries the champion) ──
  const koMs = ms.filter((m) => m.stage === "knockout");
  if (koMs.length) {
    const roundNos = [...new Set(koMs.map((m) => m.round_no))].sort((a, b) => a - b);
    const rounds = roundNos.map((r) => {
      const list = koMs.filter((m) => m.round_no === r).sort((a, b) => a.slot - b.slot);
      const isBr = list.some((m) => (m as any).bronze);
      return { round: r, label: isBr ? "bronze" : roundLabel(list.length * 2), bronze: isBr, matchups: list.map(shapeMatch) };
    });
    const lastRoundNo = roundNos[roundNos.length - 1];
    const lastList = koMs.filter((m) => m.round_no === lastRoundNo);
    const lastCount = lastList.length;
    const lastIsBronze = lastList.some((m) => (m as any).bronze);
    const champion = comp.champion_id ? slim(cmap.get(comp.champion_id)) : null;
    // 名次：决赛（非季军战、2 人的那轮）败者=亚军；季军战胜者=季军、败者=殿军
    const finalM = koMs.filter((m) => !(m as any).bronze).sort((a, b) => b.round_no - a.round_no)[0] || null;
    const bronzeM = koMs.find((m) => (m as any).bronze);
    const runnerUp = comp.phase === "finished" && finalM && finalM.decided ? slim(cmap.get(finalM.winner_id === finalM.a_id ? finalM.b_id : finalM.a_id)) : null;
    const third = bronzeM && bronzeM.decided ? slim(cmap.get(bronzeM.winner_id!)) : null;
    const fourth = bronzeM && bronzeM.decided ? slim(cmap.get(bronzeM.winner_id === bronzeM.a_id ? bronzeM.b_id : bronzeM.a_id)) : null;
    // nextLabel: name the round that opens NEXT. Plain single-elimination lets us derive that
    // from the current round's match count (each match sends one winner up), but the bronze
    // match breaks that invariant: after a 2-match semifinal the losers play 季军战 first and
    // the final is deferred (see advanceKnockout), so a 2-match round must report "bronze".
    const nextLabel = comp.phase !== "knockout" ? null
      : lastIsBronze ? "final"
      : lastCount <= 1 ? null
      : (lastCount === 2 && comp.third_place !== false) ? "bronze"
      : roundLabel(lastCount);
    result.knockout = { rounds, champion, runnerUp, third, fourth, finished: comp.phase === "finished", nextLabel };
  } else if (comp.champion_id) {
    result.knockout = { rounds: [], champion: slim(cmap.get(comp.champion_id)), finished: comp.phase === "finished" };
  }

  return result;
}

function roundLabel(contestants: number): string {
  if (contestants <= 2) return "final";
  if (contestants === 4) return "semi";
  if (contestants === 8) return "quarter";
  return "top:" + contestants;
}

// ── public schedule preview (bracket + per-matchday pairings + projected times) ──
// Used by the rules page and admin so the schedule shown to the public stays in sync
// with what the admin configures. Group pairings are fixed once the stage starts;
// knockout pairings only exist for rounds already generated (they depend on winners),
// so future knockout rounds carry projected times but no pairings (pending = true).
export type SchedSide = { id: number; name: string; nameCn: string | null } | null;
export interface SchedMatch { a: SchedSide; b: SchedSide; decided: boolean; winnerId: number | null; groupNo?: number | null; }
export interface SchedGroupDay { matchday: number; matchdayCount: number; start: number | null; end: number | null; current: boolean; matches: SchedMatch[]; groups?: { groupNo: number; members: string[]; advancers?: string[] }[]; }
export interface SchedKoRound { label: string; contestants: number; start: number | null; end: number | null; pending: boolean; matches: SchedMatch[]; }
export interface SchedulePreview {
  known: boolean; phase: string; groupMatchday?: number;
  planned: boolean;                 // nomination-phase: a booked plan exists (structure known, draw pending)
  mode: "approval" | "rr";          // group-stage voting model
  targetSize: number | null; groups: number | null; koTarget: number | null; groupSize: number | null;
  plan: { nomEndsAt: number | null; groupRoundDays: number | null; dayCap: number | null; roundHours: number | null; postponeDays: number | null; breakHours: number | null } | null;
  /** 休赛期时长（小时），0 = 未启用。前端据此把每轮开头那段标成休赛。 */
  breakHours?: number;
  group: SchedGroupDay[]; knockout: SchedKoRound[];
}

export function projectSchedule(db: DB, comp: Competition): SchedulePreview {
  const DAY = 86_400_000, HOUR = 3_600_000;
  // 休赛期占掉每一轮开头的一段时间：截止时间的网格不动（见 deadlineBase），所以一轮的
  // **可投票窗口** = 轮长 − 休赛时长。预览里必须照这个显示，否则运营看到的开始时间会比
  // 实际早 N 小时，用户看到的「还剩多久」也会对不上。
  const breakMs = Math.max(0, (Number(comp.break_hours) || 0)) * HOUR;
  const nameOf = (id: number): SchedSide => {
    const c = db.candidates.find((x) => x.id === id && x.competition_id === comp.id);
    return c ? { id: c.id, name: c.name, nameCn: c.name_cn } : null;
  };
  const known = comp.phase === "group" || comp.phase === "playoff" || comp.phase === "knockout" || comp.phase === "finished";
  const out: SchedulePreview = {
    known, phase: comp.phase, groupMatchday: comp.group_matchday ?? 0, planned: false, mode: ((comp.group_mode as any) ?? "approval"),
    targetSize: comp.target_size ?? null, groups: comp.groups_count ?? null, koTarget: comp.ko_target ?? null,
    groupSize: comp.group_size ?? null, plan: null,
    breakHours: breakMs / HOUR,
    group: [], knockout: [],
  };

  if (!known) {
    // nomination phase: the group draw only happens when nomination closes, so per-match
    // pairings can't exist yet. But if the admin has booked a plan (auto_size set), we can
    // show the intended STRUCTURE + cadence so the rules/admin pages preview what's coming.
    const N = comp.auto_size ?? 0;
    if (N >= 4) {
      const G = Math.max(2, Math.floor(comp.group_size ?? 4));
      const groups = Math.max(1, Math.floor(N / G));
      out.planned = true;
      out.targetSize = N;
      out.groupSize = G;
      out.groups = groups;
      out.koTarget = nextPow2(2 * groups);
      out.plan = {
        nomEndsAt: comp.nom_ends_at ?? null,
        groupRoundDays: comp.group_round_days ?? null,
        dayCap: comp.group_day_cap ?? null,
        roundHours: comp.round_hours ?? null,
        postponeDays: comp.postpone_days ?? null,
        breakHours: comp.break_hours ?? null,
      };

      // Detailed projection so the rules page can show "which groups run on which day"
      // before the draw. Only approval mode is predictable: groups open in batches of
      // groups_per_day, one batch per matchday. Round-robin matchday count comes out of the
      // circle-method packing at draw time, so we must NOT invent one here.
      const perDay = comp.groups_per_day && comp.groups_per_day > 0 ? comp.groups_per_day : 2;
      const isApproval = ((comp.group_mode as any) ?? "approval") === "approval";
      const roundMs = (comp.group_round_days || 0) * DAY;
      const base = comp.nom_ends_at ?? null; // group stage starts when nomination closes
      // Dates are only meaningful with a pace set; otherwise the operator advances manually
      // and pretending every stage lands on the same timestamp would be worse than "TBD".
      const paced = base != null && roundMs > 0;
      let mdCount = 0;
      if (isApproval) {
        mdCount = Math.max(1, Math.ceil(groups / perDay));
        for (let d = 1; d <= mdCount; d++) {
          // 没设节奏时只有「第 1 比赛日何时开始」是确定的（提名一截止就开赛），
          // 后面的比赛日靠人工推进，所以留待定 —— 而不是连第一天也标待定。
          // 每轮开头的 breakMs 是休赛期，投票从它之后才开始
          const end = paced ? base! + d * roundMs : null;
          const start = paced ? base! + (d - 1) * roundMs + breakMs
            : (d === 1 ? (base != null ? base + breakMs : null) : null);
          const gs = Array.from({ length: groups }, (_, i) => i)
            .filter((g) => groupBatch(g, perDay) === d)
            .map((g) => ({ groupNo: g, members: [] as string[] }));
          out.group.push({ matchday: d, matchdayCount: mdCount, start, end, current: false, matches: [], groups: gs });
        }
      }
      // knockout rounds: … → semi → [bronze] → final, paced by round_hours when known
      const hrs = comp.round_hours ?? 0;
      let cursor = (paced && isApproval && hrs) ? base! + mdCount * roundMs : null;
      const koT = out.koTarget ?? 0;
      const thirdOn = comp.third_place !== false && koT >= 4;
      // cursor 走的是「截止时间网格」；每一轮显示的开始 = 网格起点 + 休赛时长
      const bump = (): { start: number | null; end: number | null } => {
        if (cursor == null) return { start: null, end: null };
        const gridStart = cursor;
        cursor = cursor + hrs * HOUR;
        return { start: gridStart + breakMs, end: cursor };
      };
      for (let S = koT; S >= 2; S = S >> 1) {
        if (S === 2 && thirdOn) { const w = bump(); out.knockout.push({ label: "bronze", contestants: 2, start: w.start, end: w.end, pending: true, matches: [] }); }
        const w = bump();
        out.knockout.push({ label: roundLabel(S), contestants: S, start: w.start, end: w.end, pending: true, matches: [] });
      }
    }
    return out;
  }

  // group matchday time windows — mirrors getState.mdDate: recorded ground truth for
  // reached days, pace-projection for days not yet opened (so history never drifts).
  const gtStarts = (comp.group_matchday_starts || {}) as Record<number, number>;
  const knownDays = Object.keys(gtStarts).map(Number).filter((n) => Number.isFinite(n));
  const maxKnownDay = knownDays.length ? Math.max(...knownDays) : 0;
  const pace = comp.group_round_days || 0;
  const roundMs = pace * DAY;
  // 已到达的比赛日读事实（真实开始时刻）；未到达的按「截止网格 + 休赛期」推算：
  // 网格是 每轮截止 = 上一轮截止 + 轮长（不受休赛期影响），开始 = 网格起点 + 休赛时长。
  const dayStart = (d: number): number | null => {
    const k = gtStarts[d];
    if (k != null) return k;
    if (!pace) return null;
    if (maxKnownDay > 0) return gtStarts[maxKnownDay] + (d - maxKnownDay) * roundMs + (d > maxKnownDay ? breakMs : 0);
    if (comp.group_started_at != null) return comp.group_started_at + (d - 1) * roundMs + (d > 1 ? breakMs : 0);
    return null;
  };
  const mdCount = comp.group_matchday_count ?? 1;
  const curMd = comp.group_matchday ?? 1;
  const approval = (comp.group_mode ?? "approval") === "approval";
  if (approval) {
    const perDay = comp.groups_per_day && comp.groups_per_day > 0 ? comp.groups_per_day : 2;
    const nameCn = (id: number) => { const s = nameOf(id); return s ? (s.nameCn || s.name) : "?"; };
    const grouped = db.candidates.filter((c) => c.competition_id === comp.id && c.group_no != null);
    for (let d = 1; d <= mdCount; d++) {
      const start = dayStart(d);
      let end: number | null = null;
      if (comp.phase === "group" && d === curMd && comp.group_round_ends_at) end = comp.group_round_ends_at;
      // start 里已经含了 breakMs（休赛期占在轮首），所以截止 = 开始 + 轮长 − 休赛时长；
      // 直接 start + roundMs 会把休赛期算两遍，预览的截止时间比真实晚 N 小时。
      else if (start != null && pace) end = start + roundMs - breakMs;
      const gNos = [...new Set(grouped.map((c) => c.group_no!))].filter((g) => groupBatch(g, perDay) === d).sort((a, b) => a - b);
      const dClosed = comp.phase !== "group" || d < curMd;
      const aTally = dClosed ? approvalTally(db, comp.id) : null;
      const groups = gNos.map((g) => {
        const mem = grouped.filter((c) => c.group_no === g).sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0));
        const advancers = aTally
          ? [...mem].sort((a, b) => (aTally.get(b.id) || 0) - (aTally.get(a.id) || 0) || tieByReachedFirst(a, b) || (a.seed ?? 0) - (b.seed ?? 0)).slice(0, 2).map((c) => nameCn(c.id))
          : [];
        return { groupNo: g, members: mem.map((c) => nameCn(c.id)), advancers };
      });
      out.group.push({ matchday: d, matchdayCount: mdCount, start, end, current: comp.phase === "group" && d === curMd, matches: [], groups });
    }
  } else {
    const gms = db.matchups.filter((m) => m.competition_id === comp.id && m.stage === "group");
    for (let d = 1; d <= mdCount; d++) {
      const start = dayStart(d);
      let end: number | null = null;
      if (comp.phase === "group" && d === curMd && comp.group_round_ends_at) end = comp.group_round_ends_at;
      // start 里已经含了 breakMs（休赛期占在轮首），所以截止 = 开始 + 轮长 − 休赛时长；
      // 直接 start + roundMs 会把休赛期算两遍，预览的截止时间比真实晚 N 小时。
      else if (start != null && pace) end = start + roundMs - breakMs;
      const matches = gms
        .filter((m) => (m.matchday ?? 1) === d)
        .sort((a, b) => (a.group_no ?? 0) - (b.group_no ?? 0) || a.slot - b.slot)
        .map((m) => ({ a: nameOf(m.a_id), b: nameOf(m.b_id), decided: m.decided, winnerId: m.winner_id, groupNo: m.group_no ?? null }));
      out.group.push({ matchday: d, matchdayCount: mdCount, start, end, current: comp.phase === "group" && d === curMd, matches });
    }
  }

  // knockout rounds — project times; attach pairings only where matchups already exist.
  const koTarget = comp.ko_target ?? 0;
  if (koTarget >= 2) {
    const koMs = db.matchups.filter((m) => m.competition_id === comp.id && m.stage === "knockout");
    const byRound = new Map<number, Matchup[]>();
    for (const m of koMs) { const arr = byRound.get(m.round_no) || []; arr.push(m); byRound.set(m.round_no, arr); }
    const roundNos = [...byRound.keys()];
    const rh = comp.round_hours || 0;
    const thirdOn = comp.third_place !== false && koTarget >= 4;
    // ordered steps: … semi → [bronze] → final
    const steps: { label: string; contestants: number; bronze: boolean }[] = [];
    for (let S = koTarget; S >= 2; S = S >> 1) {
      if (S === 2 && thirdOn) steps.push({ label: "bronze", contestants: 2, bronze: true });
      steps.push({ label: roundLabel(S), contestants: S, bronze: false });
    }
    const bronzeMatch = koMs.find((m) => (m as any).bronze);
    // locate the live current step (knockout phase) to anchor real deadline
    let curStepIdx: number | null = null;
    if (comp.phase === "knockout" && koMs.length) {
      const maxRn = Math.max(...koMs.map((m) => m.round_no));
      const maxList = koMs.filter((m) => m.round_no === maxRn);
      if (maxList.some((m) => (m as any).bronze)) curStepIdx = steps.findIndex((s) => s.bronze);
      else { const c = maxList.filter((m) => !(m as any).bronze).length * 2; curStepIdx = steps.findIndex((s) => !s.bronze && s.contestants === c); }
    }
    let cursor: number | null = (comp.phase === "group" || comp.phase === "playoff") ? (out.group.length ? out.group[out.group.length - 1].end : null) : null;
    steps.forEach((step, i) => {
      let list: Matchup[] = [];
      if (step.bronze) { if (bronzeMatch) list = [bronzeMatch]; }
      else { const rn = roundNos.find((r) => byRound.get(r)!.filter((m) => !(m as any).bronze).length * 2 === step.contestants && !byRound.get(r)!.some((m) => (m as any).bronze)); if (rn != null) list = byRound.get(rn)!.slice().sort((a, b) => a.slot - b.slot); }
      const matches: SchedMatch[] = list.map((m) => ({ a: nameOf(m.a_id), b: nameOf(m.b_id), decided: m.decided, winnerId: m.winner_id }));
      let start: number | null = null, end: number | null = null;
      if (curStepIdx != null) {
        if (i === curStepIdx) { end = comp.ko_round_ends_at ?? null; cursor = end; }
        // cursor 停在上一轮的**截止**（网格点）；下一轮先休赛 breakMs 再开投，截止仍在网格上。
        else if (i > curStepIdx) { start = cursor != null ? cursor + breakMs : null; end = (cursor != null && rh) ? cursor + rh * HOUR : null; cursor = end; }
      } else if (comp.phase === "group" || comp.phase === "playoff") {
        start = cursor != null ? cursor + breakMs : null; end = (cursor != null && rh) ? cursor + rh * HOUR : null; cursor = end;
      }
      out.knockout.push({ label: step.label, contestants: step.contestants, start, end, pending: list.length === 0, matches });
    });
  }
  return out;
}


// ── helpers ───────────────────────────────────────────────────
function isPow2(n: number) { return n >= 2 && (n & (n - 1)) === 0; }
function nextPow2(n: number): number { let p = 1; while (p < n) p <<= 1; return Math.max(2, p); }

/**
 * 平票排序：先达到当前票数的排在前面。
 *
 * tally_at 是「这个角色票数最近一次变化的时刻」，加票和撤票/作废都会刷新它，所以「先达到」
 * 对两种方向都成立：A 3 点到 10 票，B 5 点从 11 票被撤成 10 票 → A 在前。
 *
 * 老数据没有 tally_at（升级前入池的角色），一律排在有时间戳的之后、彼此按原来的规则
 * （种子 / id）比 —— 这样进行中的比赛不会因为升级就把已有排名重排一遍。
 */
function tieByReachedFirst(a: { tally_at?: number | null }, b: { tally_at?: number | null }): number {
  const ta = a.tally_at ?? null, tb = b.tally_at ?? null;
  if (ta != null && tb != null) return ta - tb;   // 都有：早的在前
  if (ta != null) return -1;                       // 有时间戳的优先于老数据
  if (tb != null) return 1;
  return 0;                                        // 都是老数据 → 交给下一级规则
}

/**
 * Base timestamp for the NEXT round's deadline.
 *
 * Normally "now". But if a break just ended, the deadline is measured from the deadline that
 * triggered that break, not from the moment the break finished -- otherwise every round lands N
 * hours later than the last and after a few matchdays the daily cut-off has wandered right across
 * the clock. Anchoring keeps the grid fixed and takes the break out of the round's voting time:
 * with a 23:00 daily deadline and a 2h break, the next round runs 01:00–23:00.
 *
 * Clears the anchor as it consumes it, and ignores an anchor already in the past by more than one
 * round length (a long manual pause shouldn't produce a deadline that is already overdue).
 */
function deadlineBase(comp: Competition, roundMs: number): number {
  const now = Date.now();
  const a = comp.break_anchor;
  if (a == null) return now;
  comp.break_anchor = null;              // consumed (caller writes the db)
  if (!Number.isFinite(a)) return now;
  // 锚点 + 轮长必须仍在未来，否则用 now（例如运营手动把休赛期拖了很久）
  return a + roundMs > now ? a : now;
}
function shuffle<T>(a: T[]): T[] { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

/** Hard cap on how many matches may be open on a single (global) matchday, across
 *  ALL groups. Keeps voters from being dumped 16 matches at once. */
const GROUP_DAY_CAP = 4;

/** One group's round-robin as a list of ROUNDS (circle method / 1-factorization).
 *  Each round is a set of disjoint pairs — no character appears twice in a round.
 *  `perRound > 0` further splits a round into chunks of that many matches. */
function roundRobinRounds(ids: number[], perRound = 0): [number, number][][] {
  const arr = ids.slice();
  const BYE = -1;
  if (arr.length % 2 === 1) arr.push(BYE);
  const n = arr.length;
  const rounds: [number, number][][] = [];
  if (n >= 2) {
    const fixed = arr[0];
    let rot = arr.slice(1);
    for (let r = 0; r < n - 1; r++) {
      const row = [fixed, ...rot];
      const pairs: [number, number][] = [];
      for (let i = 0; i < n / 2; i++) {
        const a = row[i], b = row[n - 1 - i];
        if (a !== BYE && b !== BYE) pairs.push([a, b]);
      }
      if (pairs.length) rounds.push(pairs);
      rot.unshift(rot.pop() as number); // rotate
    }
  }
  if (perRound && perRound > 0) {
    const chunked: [number, number][][] = [];
    for (const rd of rounds) for (let i = 0; i < rd.length; i += perRound) chunked.push(rd.slice(i, i + perRound));
    return chunked;
  }
  return rounds;
}

type PackedMatch = { group: number; a: number; b: number };

/** Pack every group's rounds into GLOBAL matchdays of at most `cap` matches, such that
 *  no character plays twice on one matchday. Matches from different groups never share a
 *  character; the per-day char set only guards the (rare) same-group cross-round case.
 *  Rounds are interleaved across groups so early matchdays span many groups rather than
 *  draining one group first. First-fit ⇒ deterministic and near-optimally full. */
function packMatchdays(perGroupRounds: [number, number][][][], cap: number): PackedMatch[][] {
  const flat: PackedMatch[] = [];
  const maxR = perGroupRounds.reduce((m, r) => Math.max(m, r.length), 0);
  for (let r = 0; r < maxR; r++)
    for (let g = 0; g < perGroupRounds.length; g++) {
      const rd = perGroupRounds[g][r];
      if (rd) for (const [a, b] of rd) flat.push({ group: g, a, b });
    }
  const days: PackedMatch[][] = [];
  const dayChars: Set<number>[] = [];
  for (const m of flat) {
    let placed = false;
    for (let d = 0; d < days.length; d++) {
      if (days[d].length < cap && !dayChars[d].has(m.a) && !dayChars[d].has(m.b)) {
        days[d].push(m); dayChars[d].add(m.a); dayChars[d].add(m.b); placed = true; break;
      }
    }
    if (!placed) { days.push([m]); dayChars.push(new Set<number>([m.a, m.b])); }
  }
  return days;
}

function seedLookup(db: DB, cid: number): (id: number) => number {
  const m = new Map<number, number>();
  for (const c of db.candidates) if (c.competition_id === cid) m.set(c.id, c.seed ?? Number.MAX_SAFE_INTEGER);
  return (id) => m.get(id) ?? Number.MAX_SAFE_INTEGER;
}

function decide(m: Matchup, counts: Map<string, number>, seedOf: (id: number) => number) {
  const a = counts.get(m.id + ":" + m.a_id) || 0;
  const b = counts.get(m.id + ":" + m.b_id) || 0;
  // 平票 / 零票：判给种子更高者（seed 序号更小）；种子相同则判 A 方。
  if (a !== b) m.winner_id = a > b ? m.a_id : m.b_id;
  else m.winner_id = seedOf(m.a_id) <= seedOf(m.b_id) ? m.a_id : m.b_id;
  m.decided = true;
}

/** Standard single-elimination seed placement (1-indexed), length n (power of two). */
function bracketSeedOrder(n: number): number[] {
  let rounds = [1, 2];
  while (rounds.length < n) {
    const m = rounds.length * 2 + 1;
    const next: number[] = [];
    for (const r of rounds) { next.push(r); next.push(m - r); }
    rounds = next;
  }
  return rounds;
}

// ── admin transitions ─────────────────────────────────────────
export function updateCompetition(cid: number, title: string, description: string | null, shortName = "", tri?: { titleEn?: string; titleJa?: string; descEn?: string; descJa?: string; shortEn?: string; shortJa?: string }) {
  const t = (title || "").trim();
  if (!t) throw new Error("标题不能为空。");
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return;
  const clean = (v?: string) => (v || "").trim() || null;
  comp.title = t;
  comp.description = clean(description || "");
  comp.short_name = clean(shortName);
  if (tri) {
    comp.title_en = clean(tri.titleEn); comp.title_ja = clean(tri.titleJa);
    comp.desc_en = clean(tri.descEn); comp.desc_ja = clean(tri.descJa);
    comp.short_en = clean(tri.shortEn); comp.short_ja = clean(tri.shortJa);
  }
  writeDb(db);
}

/** nomination → group: keep top `size` candidates, split into groups, build round-robin. */
export function startGroups(cid: number, size: number, perRound = 0, roundDays = 0, groupSize = 0, mode: "approval" | "rr" | "" = "", groupsPerDay = 0, thirdPlace: boolean | null = null) {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp || comp.phase !== "nomination") return; // idempotent

  const { total: nomCount } = nominationTally(db, cid); // 汇总票：一人投了合并组里多个角色只算一次
  const compCands = topLevel(db, cid); // 子角色不单独参赛（上级已不存在的会被视为独立）
  const minVotes = comp.nom_min_votes ?? 0;
  const ranked = compCands
    .map((c) => ({ id: c.id, votes: nomCount.get(c.id) || 0, tally_at: c.tally_at ?? null }))
    .filter((r) => r.votes >= minVotes)
    // 平票 → 先达到这个票数的在前（见 tieByReachedFirst），都是老数据时退回 id
    .sort((a, b) => b.votes - a.votes || tieByReachedFirst(a, b) || a.id - b.id);
  if (ranked.length < size) {
    // 提名池里可能还有「已并入他人」的子角色：它们仍在池中显示、仍可投票，但不单独参赛。
    // 若不说明，运营会看到「池里明明有 N 个」却被告知不足，从而怀疑数据出错。
    const merged = db.candidates.filter((c) => c.competition_id === cid && c.parent_id != null).length;
    const note = merged > 0 ? `（提名池共 ${compCands.length + merged} 个，其中 ${merged} 个已合并进其他角色、不单独参赛）` : "";
    throw new Error(minVotes > 0
      ? `达到最低提名票（${minVotes}）的可参赛角色只有 ${ranked.length} 个，不足 ${size} 个${note}。`
      : `可参赛角色只有 ${ranked.length} 个，不足 ${size} 个${note}。`);
  }

  // 并列全取：凑满 size，但票数与第 size 名并列的角色一并纳入（如取前 20 遇并列 → 可能取 23）。
  const cutoffVotes = ranked[size - 1].votes;
  const qualifiers = ranked.filter((r) => r.votes >= cutoffVotes); // a >= size
  const a = qualifiers.length;
  if (a < 4) throw new Error("晋级人数不足 4，无法组成小组。");

  const seedOfId = new Map<number, number>();
  qualifiers.forEach((r, i) => seedOfId.set(r.id, i)); // 排位赛种子 = 提名排名（0 最强）

  // 每组人数 G（默认 4）。前 base 名分成整齐的 G 人组，余数补进最弱的若干组 → 那些组变 G+1 人。
  const G = Math.max(2, Math.floor(groupSize > 0 ? groupSize : (comp.group_size ?? 4)));
  const c = a % G;
  const base = a - c;
  const numGroups = Math.max(1, Math.floor(base / G));

  // #1: fail fast at config time if this (entrants, group size) can't fill the knockout.
  //   auto-advancers = 2·groups; bracket = nextPow2(2·groups); the rest must cover the fill.
  const koCheck = nextPow2(2 * numGroups);
  if (a < koCheck)
    throw new Error(`当前配置无法凑成淘汰赛：${a} 人分 ${numGroups} 组，各组前 2 名共 ${2 * numGroups} 人，需要凑满 ${koCheck} 强，可补位人数不足。请增加晋级人数或调大每组人数（如 ${koCheck} 人以上，或每组 ${Math.max(4, Math.ceil(a / Math.max(1, Math.floor(koCheck / 2))))} 人）。`);

  // #2: a fresh draw must never inherit approval votes from a previous (undone) grouping.
  db.approvalVotes = db.approvalVotes.filter((v) => v.competition_id !== cid);

  // 前 base 名随机分成 numGroups 个 G 人组
  const topIds = shuffle(qualifiers.slice(0, base).map((r) => r.id));
  const groups: number[][] = Array.from({ length: numGroups }, () => []);
  topIds.forEach((id, i) => groups[Math.floor(i / G)].push(id));

  // 余下 c 名补进「最弱」的 c 个组（成员种子和最大者最弱；并列随机）→ 这些组变 G+1 人
  const leftovers = qualifiers.slice(base).map((r) => r.id);
  const strength = groups.map((g, idx) => ({ idx, sum: g.reduce((t, id) => t + (seedOfId.get(id) || 0), 0), r: Math.random() }));
  strength.sort((x, y) => y.sum - x.sum || x.r - y.r);
  leftovers.forEach((id, i) => groups[strength[i % strength.length].idx].push(id));

  // 落位：非晋级者淘汰
  const chosen = new Set(qualifiers.map((r) => r.id));
  for (const cand of compCands) if (!chosen.has(cand.id)) { cand.group_no = null; cand.eliminated = true; }
  groups.forEach((g, gi) => g.forEach((id) => {
    const cand = db.candidates.find((x) => x.id === id)!;
    cand.group_no = gi; cand.seed = seedOfId.get(id)!; cand.eliminated = false;
  }));

  comp.phase = "group";
  comp.target_size = a;
  comp.groups_count = numGroups;
  comp.group_size = G;
  comp.ko_target = nextPow2(2 * numGroups); // ≤8 组→16,9-16 组→32，以此类推
  comp.group_started_at = Date.now(); // legacy 锚点，仅供旧数据兜底
  comp.group_matchday_starts = { 1: comp.group_started_at }; // 事实来源：第 1 比赛日真实开始的时刻
  comp.nom_ends_at = null;

  const MODE: "approval" | "rr" = mode === "rr" || mode === "approval" ? mode : ((comp.group_mode as any) ?? "approval");
  comp.group_mode = MODE;
  if (thirdPlace != null) comp.third_place = thirdPlace;

  if (MODE === "approval") {
    // 投票晋级制：不生成对阵。每个「比赛日」开放 groups_per_day 个组的组内投票（每人 2 票）。
    const perDay = groupsPerDay > 0 ? Math.floor(groupsPerDay) : (comp.groups_per_day && comp.groups_per_day > 0 ? comp.groups_per_day : 2);
    const RD = roundDays > 0 ? roundDays : (comp.group_round_days ?? 0);
    comp.groups_per_day = perDay;
    comp.group_per_round = null;
    comp.group_round_days = RD || null;
    comp.group_matchday = 1;
    comp.group_matchday_count = Math.max(1, Math.ceil(numGroups / perDay));
    { const ms = RD * 86400_000, b = deadlineBase(comp, ms); comp.group_round_ends_at = RD > 0 ? b + ms : null; }
    comp.group_ends_at = null;
    writeDb(db);
    return;
  }

  // ── 循环赛（1v1）模式：每组各自 circle method 生成轮次，再全局装箱成「每个比赛日 ≤ DAY_CAP 场」──
  const K = perRound > 0 ? perRound : (comp.group_per_round ?? 0);
  const RD = roundDays > 0 ? roundDays : (comp.group_round_days ?? 0);
  const DAY_CAP = comp.group_day_cap == null ? GROUP_DAY_CAP : (comp.group_day_cap <= 0 ? Infinity : comp.group_day_cap); // 0 = 无限制
  const perGroupRounds = groups.map((g) => roundRobinRounds(g, K));
  const days = packMatchdays(perGroupRounds, DAY_CAP);
  days.forEach((day, di) => day.forEach((mm, si) => {
    db.matchups.push({ id: ++db.seq.matchup, competition_id: cid, stage: "group", round_no: 1, group_no: mm.group, slot: si, a_id: mm.a, b_id: mm.b, winner_id: null, decided: false, matchday: di + 1 });
  }));
  const mdCount = days.length;
  comp.group_matchday = 1;
  comp.group_matchday_count = Math.max(1, mdCount);
  comp.group_per_round = K || null;
  comp.group_round_days = RD || null;
  { const ms = RD * 86400_000, b = deadlineBase(comp, ms); comp.group_round_ends_at = RD > 0 ? b + ms : null; }
  comp.group_ends_at = null;
  writeDb(db);
}

/** Settle the current group matchday; open the next one, or report done. */
export function advanceGroupMatchday(cid: number): { done: boolean; message: string } {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp || comp.phase !== "group") throw new Error("当前不在小组赛阶段。");
  const cur = comp.group_matchday ?? 1;
  const count = comp.group_matchday_count ?? 1;
  const approval = (comp.group_mode ?? "approval") === "approval";
  if (!approval) {
    const counts = matchCounts(db, cid);
    const seedOf = seedLookup(db, cid);
    for (const m of db.matchups)
      if (m.competition_id === cid && m.stage === "group" && (m.matchday ?? 1) === cur) decide(m, counts, seedOf);
  }
  if (cur < count) {
    comp.group_matchday = cur + 1;
    const now = Date.now();
    const rMs = (comp.group_round_days || 0) * 86400_000;
    // 以「触发休赛期的原定截止」为基准，休赛期从本轮投票时间里扣，而不是把整条赛程往后推。
    // deadlineBase 无条件调用（即使没设节奏），否则手动推进时 anchor 会一直留着，
    // 被套用到很久以后的某一轮上。
    const gBase = deadlineBase(comp, rMs);
    comp.group_round_ends_at = comp.group_round_days ? gBase + rMs : null;
    comp.group_matchday_starts = { ...(comp.group_matchday_starts || {}), [cur + 1]: now }; // 事实来源：真实开始的时刻
    writeDb(db);
    return { done: false, message: `已结算第 ${cur} 个比赛日，进入第 ${cur + 1}/${count} 个比赛日。` };
  }
  comp.group_round_ends_at = null;
  writeDb(db);
  return { done: true, message: `已结算最后一个比赛日（第 ${cur}/${count}）。现在可以开淘汰赛。` };
}

/** group → knockout (World Cup): winners + runners-up + best remaining → nextPow2(2×组数).
 *  若最后填补名额在「小组胜负 + 提名票」上并列，则对并列者开循环赛加赛决定。 */
export function startKnockout(cid: number) {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp || comp.phase !== "group") throw new Error("当前不在小组赛阶段。");
  const numGroups = comp.groups_count as number;
  const koTarget = comp.ko_target ?? nextPow2(2 * numGroups);
  const counts = matchCounts(db, cid);
  const seedOf = seedLookup(db, cid);
  const approval = (comp.group_mode ?? "approval") === "approval";
  const appr = approval ? approvalTally(db, cid) : null;

  if (!approval) for (const m of db.matchups) if (m.competition_id === cid && m.stage === "group") decide(m, counts, seedOf);

  const nomCount = new Map<number, number>();
  for (const v of db.nominationVotes) if (v.competition_id === cid) nomCount.set(v.candidate_id, (nomCount.get(v.candidate_id) || 0) + 1);

  type Row = { id: number; wins: number; vf: number; votes: number; groupRank: number; tally_at: number | null };
  const autoAdv: Row[] = [];
  const fillPool: Row[] = [];
  for (let g = 0; g < numGroups; g++) {
    const gms = db.matchups.filter((m) => m.competition_id === cid && m.stage === "group" && m.group_no === g);
    const members = db.candidates.filter((cd) => cd.competition_id === cid && cd.group_no === g);
    const stats: Row[] = members.map((mem) => {
      if (approval) {
        // 投票晋级制：以组内得票数作为排名依据（等价地塞进 wins/vf，复用下方同一套排序/补位）
        const a2 = appr!.get(mem.id) || 0;
        return { id: mem.id, wins: a2, vf: a2, votes: nomCount.get(mem.id) || 0, groupRank: 0, tally_at: mem.tally_at ?? null };
      }
      let wins = 0, vf = 0;
      for (const mm of gms) {
        const va = counts.get(mm.id + ":" + mm.a_id) || 0, vb = counts.get(mm.id + ":" + mm.b_id) || 0;
        if (mm.a_id === mem.id) vf += va;
        if (mm.b_id === mem.id) vf += vb;
        if (mm.winner_id === mem.id) wins++;
      }
      return { id: mem.id, wins, vf, votes: nomCount.get(mem.id) || 0, groupRank: 0, tally_at: mem.tally_at ?? null };
    });
    // 出线排序：票数/胜场 → 平了就看谁先达到这个票数 → 再退回种子
    stats.sort((x, y) => y.wins - x.wins || y.vf - x.vf || tieByReachedFirst(x, y) || seedOf(x.id) - seedOf(y.id));
    stats.forEach((s2, i) => (s2.groupRank = i));
    autoAdv.push(...stats.slice(0, 2));
    fillPool.push(...stats.slice(2));
  }

  const seedCmp = (x: Row, y: Row) => x.groupRank - y.groupRank || y.wins - x.wins || y.votes - x.votes || tieByReachedFirst(x, y) || seedOf(x.id) - seedOf(y.id);
  // sameTier 判定「是否真的并列到需要加赛」。刻意**不**把 tally_at 算进去：先达到只是排序用的
  // 决胜手段，两人票数确实相同就仍然算并列，该不该加赛由运营看着办 —— 否则时间戳会悄悄
  // 消掉所有并列，加赛机制形同废除。
  const sameTier = (x: Row, y: Row) => x.groupRank === y.groupRank && x.wins === y.wins && x.votes === y.votes;
  const fillNeeded = koTarget - autoAdv.length;
  fillPool.sort(seedCmp);

  // 检测最后名额是否并列 → 需要加赛
  if (fillNeeded > 0 && fillNeeded < fillPool.length) {
    const boundary = fillPool[fillNeeded - 1];
    const bandStart = fillPool.findIndex((r) => sameTier(r, boundary));
    const band = fillPool.filter((r) => sameTier(r, boundary));
    const slotsForBand = fillNeeded - bandStart;
    if (band.length > slotsForBand && slotsForBand >= 1) {
      const confirmed = [...autoAdv, ...fillPool.slice(0, bandStart)].sort(seedCmp).map((r) => r.id);
      comp.ko_seed_ids = [...confirmed, ...Array(slotsForBand).fill(null)];
      comp.playoff_slots = slotsForBand;
      const keep = new Set<number>([...confirmed, ...band.map((r) => r.id)]);
      for (const cd of db.candidates) if (cd.competition_id === cid && cd.group_no != null && !keep.has(cd.id)) cd.eliminated = true;
      const bandIds = band.map((r) => r.id);
      let slot = 0;
      for (let i = 0; i < bandIds.length; i++) for (let j = i + 1; j < bandIds.length; j++)
        db.matchups.push({ id: ++db.seq.matchup, competition_id: cid, stage: "playoff", round_no: 1, group_no: null, slot: slot++, a_id: bandIds[i], b_id: bandIds[j], winner_id: null, decided: false, matchday: 1 });
      comp.phase = "playoff";
      comp.group_round_ends_at = comp.round_hours ? Date.now() + comp.round_hours * 3600_000 : null;
      comp.group_ends_at = null;
      writeDb(db);
      return;
    }
  }

  const advancers = [...autoAdv, ...(fillNeeded > 0 ? fillPool.slice(0, fillNeeded) : [])].sort(seedCmp);
  const bySeed = advancers.map((r) => r.id);
  if (bySeed.length !== koTarget || !isPow2(bySeed.length)) throw new Error(`可晋级人数 ${bySeed.length} 无法凑成 ${koTarget} 强（检查小组与人数）。`);
  buildKnockout(db, comp, cid, bySeed);
  writeDb(db);
}

/** Build the round-1 bracket from an ordered advancer list (index 0 = strongest). */
function buildKnockout(db: DB, comp: Competition, cid: number, seedIds: number[]) {
  // Validate the seed list BEFORE writing anything. A hole here (null/undefined/duplicate) used to
  // be serialised straight into the data file as a matchup with a missing side -- votes for it can
  // never resolve it, decide() picks a winner that doesn't exist, and the only way out is editing
  // the JSON by hand. resolvePlayoff could produce exactly that whenever there were fewer playoff
  // contenders than slots to fill. Fail loudly instead: the caller is an admin action, so an error
  // message is recoverable while a corrupt bracket mid-tournament is not.
  const n = seedIds.length;
  if (n < 2 || (n & (n - 1)) !== 0)
    throw new Error(`淘汰赛名额数必须是 2 的幂且至少 2（当前 ${n}），无法生成对阵。`);
  const holes = seedIds.filter((x) => x == null || !Number.isFinite(x)).length;
  if (holes > 0)
    throw new Error(`淘汰赛有 ${holes} 个名额没有确定的角色，无法生成对阵。请检查加赛结果/晋级人数配置后重试。`);
  const dupes = seedIds.length - new Set(seedIds).size;
  if (dupes > 0)
    throw new Error(`淘汰赛名额里有 ${dupes} 个重复的角色，无法生成对阵。`);
  const missing = seedIds.filter((id) => !db.candidates.some((c) => c.id === id && c.competition_id === cid));
  if (missing.length)
    throw new Error(`淘汰赛名额里有 ${missing.length} 个角色已不在本届（可能被移除），无法生成对阵。`);

  const advSet = new Set(seedIds);
  for (const cd of db.candidates) if (cd.competition_id === cid && cd.group_no != null && !advSet.has(cd.id)) cd.eliminated = true;
  comp.phase = "knockout"; comp.ko_round = 1;
  comp.group_round_ends_at = null; comp.group_ends_at = null;
  comp.ko_seed_ids = null; comp.playoff_slots = null;
  { const ms = (comp.round_hours || 0) * 3600_000, b = deadlineBase(comp, ms); comp.ko_round_ends_at = comp.round_hours ? b + ms : null; }
  const order = bracketSeedOrder(n);
  const placed = order.map((seed) => seedIds[seed - 1]);
  for (let i = 0; i < placed.length; i += 2) {
    db.matchups.push({ id: ++db.seq.matchup, competition_id: cid, stage: "knockout", round_no: 1, group_no: null, slot: i / 2, a_id: placed[i], b_id: placed[i + 1], winner_id: null, decided: false });
    const ca = db.candidates.find((x) => x.id === placed[i]); if (ca) ca.seed = order[i];
    const cb = db.candidates.find((x) => x.id === placed[i + 1]); if (cb) cb.seed = order[i + 1];
  }
}

/** Settle the third-place playoff round-robin, then seed the knockout. */
export function resolvePlayoff(cid: number) {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp || comp.phase !== "playoff") throw new Error("当前不在加赛阶段。");
  const counts = matchCounts(db, cid);
  const seedOf = seedLookup(db, cid);
  const pms = db.matchups.filter((m) => m.competition_id === cid && m.stage === "playoff");
  for (const m of pms) decide(m, counts, seedOf);

  const nomCount = new Map<number, number>();
  for (const v of db.nominationVotes) if (v.competition_id === cid) nomCount.set(v.candidate_id, (nomCount.get(v.candidate_id) || 0) + 1);

  const bandIds = [...new Set(pms.flatMap((m) => [m.a_id, m.b_id]))];
  const rows = bandIds.map((id) => {
    let wins = 0, vf = 0;
    for (const m of pms) {
      const va = counts.get(m.id + ":" + m.a_id) || 0, vb = counts.get(m.id + ":" + m.b_id) || 0;
      if (m.a_id === id) vf += va;
      if (m.b_id === id) vf += vb;
      if (m.winner_id === id) wins++;
    }
    return { id, wins, vf, votes: nomCount.get(id) || 0 };
  });
  rows.sort((x, y) => y.wins - x.wins || y.vf - x.vf || y.votes - x.votes || seedOf(x.id) - seedOf(y.id));

  const slots = comp.playoff_slots ?? 0;
  const holes = (comp.ko_seed_ids || []).filter((x) => x == null).length;
  // Guard before mutating: there must be at least as many playoff survivors as bracket holes to
  // fill. Otherwise we would leave nulls in the seed list, which buildKnockout used to write out
  // as matchups with a missing side. Throwing here keeps the playoff phase intact and reversible.
  if (rows.length < holes)
    throw new Error(`加赛只有 ${rows.length} 个角色，但淘汰赛还有 ${holes} 个名额待填，无法生成对阵。请调整晋级人数后重试。`);
  for (const r of rows.slice(slots)) { const c = db.candidates.find((x) => x.id === r.id); if (c) c.eliminated = true; }
  const winners = rows.slice(0, Math.max(slots, holes)).map((r) => r.id);
  const seedIds = (comp.ko_seed_ids || []).slice();
  let w = 0;
  for (let i = 0; i < seedIds.length; i++) if (seedIds[i] == null) seedIds[i] = winners[w++];

  buildKnockout(db, comp, cid, seedIds as number[]);
  writeDb(db);
}
export function advanceKnockout(cid: number) {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp || comp.phase !== "knockout") throw new Error("当前不在淘汰赛阶段。");

  const koMs = db.matchups.filter((m) => m.competition_id === cid && m.stage === "knockout");
  const round = comp.ko_round ?? (koMs.length ? Math.max(...koMs.map((m) => m.round_no)) : 1);
  const counts = matchCounts(db, cid);

  const cur = koMs.filter((m) => m.round_no === round).sort((a, b) => a.slot - b.slot);
  const seedOf = seedLookup(db, cid);
  for (const m of cur) decide(m, counts, seedOf);
  for (const m of cur) {
    const loser = m.winner_id === m.a_id ? m.b_id : m.a_id;
    const lc = db.candidates.find((c) => c.id === loser);
    if (lc) lc.eliminated = true;
  }
  const thirdOn = comp.third_place !== false; // 默认进行季军战

  // 季军战刚打完 → 定出 3/4 名，再用半决赛的两位胜者生成决赛
  if (cur.some((m) => m.bronze)) {
    const semi = koMs.filter((m) => m.round_no === round - 1 && !m.bronze);
    const finalists = semi.map((m) => m.winner_id!).filter((x) => x != null) as number[];
    comp.ko_round = round + 1;
    if (finalists.length >= 2) {
      { const ms = (comp.round_hours || 0) * 3600_000, b = deadlineBase(comp, ms); comp.ko_round_ends_at = comp.round_hours ? b + ms : null; }
      db.matchups.push({ id: ++db.seq.matchup, competition_id: cid, stage: "knockout", round_no: round + 1, group_no: null, slot: 0, a_id: finalists[0], b_id: finalists[1], winner_id: null, decided: false, bronze: false });
    } else { comp.phase = "finished"; comp.champion_id = finalists[0] ?? null; comp.ko_round_ends_at = null; }
    writeDb(db);
    return;
  }

  const winners = cur.map((m) => m.winner_id!).filter((x) => x != null) as number[];
  comp.ko_round = round + 1;
  if (winners.length <= 1) {
    comp.phase = "finished"; comp.champion_id = winners[0] ?? null;
    comp.ko_round_ends_at = null;
    writeDb(db);
    return;
  }
  { const ms = (comp.round_hours || 0) * 3600_000, b = deadlineBase(comp, ms); comp.ko_round_ends_at = comp.round_hours ? b + ms : null; }
  if (winners.length === 2 && thirdOn) {
    // 半决赛结束：两位败者先打季军战（单独一轮/一天），决赛推迟到季军战之后生成
    const losers = cur.map((m) => (m.winner_id === m.a_id ? m.b_id : m.a_id)).filter((x) => x != null) as number[];
    db.matchups.push({ id: ++db.seq.matchup, competition_id: cid, stage: "knockout", round_no: round + 1, group_no: null, slot: 0, a_id: losers[0], b_id: losers[1], winner_id: null, decided: false, bronze: true });
    writeDb(db);
    return;
  }
  // Bug guard: an odd winner count would previously build a matchup with b_id === undefined,
  // which then serialises into the data file as a broken pair (votes for it can never resolve).
  // The bracket is a power of two so this shouldn't happen, but undo/resettle/manual edits can
  // leave a round with an odd size — carry the last winner forward as a bye instead of corrupting.
  const pairable = winners.length - (winners.length % 2);
  for (let i = 0; i < pairable; i += 2)
    db.matchups.push({ id: ++db.seq.matchup, competition_id: cid, stage: "knockout", round_no: round + 1, group_no: null, slot: i / 2, a_id: winners[i], b_id: winners[i + 1], winner_id: null, decided: false, bronze: false });
  if (winners.length % 2 === 1) {
    const odd = winners[winners.length - 1];
    console.error(`saimoe: knockout round ${round} produced ${winners.length} winners (odd); #${odd} advances on a bye`);
    db.matchups.push({ id: ++db.seq.matchup, competition_id: cid, stage: "knockout", round_no: round + 1, group_no: null, slot: pairable / 2, a_id: odd, b_id: odd, winner_id: odd, decided: true, bronze: false });
  }
  writeDb(db);
}

// ── scheduling ────────────────────────────────────────────────
export interface ScheduleOpts {
  nomEndsAt: number | null;      // epoch ms when nomination auto-closes
  autoSize: number;
  roundHours: number | null;     // per knockout-round duration
  postponeDays: number;          // days to push back if the pool is short at the deadline
  groupPerRound?: number;        // matches per matchday per group (0 = auto)
  groupRoundDays?: number;       // days per group matchday
  groupSize?: number;            // players per group (0 = default 4)
  dayCap?: number;               // max matches opened per global matchday (0 = default)
  groupMode?: "approval" | "rr" | ""; // group-stage model to use when auto-opening
  groupsPerDay?: number;         // approval mode: groups opened per matchday (0 = default 2)
  thirdPlace?: boolean;          // whether to hold a bronze (third-place) match
}

/** Arm the automatic schedule (only meaningful in the nomination phase). */
export function scheduleCompetition(cid: number, o: ScheduleOpts) {
  if (o.autoSize < 4) throw new Error("参赛人数至少 4 人。");
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return;
  comp.auto_size = o.autoSize;
  comp.round_hours = o.roundHours;
  comp.group_per_round = o.groupPerRound && o.groupPerRound > 0 ? o.groupPerRound : null;
  comp.group_round_days = o.groupRoundDays && o.groupRoundDays > 0 ? o.groupRoundDays : null;
  comp.group_size = o.groupSize && o.groupSize > 0 ? Math.max(2, Math.floor(o.groupSize)) : comp.group_size;
  comp.group_day_cap = (typeof o.dayCap === "number" && o.dayCap >= 0) ? Math.floor(o.dayCap) : comp.group_day_cap;
  if (o.groupMode === "approval" || o.groupMode === "rr") comp.group_mode = o.groupMode;
  if (o.groupsPerDay && o.groupsPerDay > 0) comp.groups_per_day = Math.floor(o.groupsPerDay);
  if (typeof o.thirdPlace === "boolean") comp.third_place = o.thirdPlace;
  comp.postpone_days = o.postponeDays > 0 ? o.postponeDays : 1;
  comp.nom_ends_at = o.nomEndsAt && o.nomEndsAt > Date.now() ? o.nomEndsAt : null;
  writeDb(db);
}

/** Clear the automatic schedule (revert to manual control). */
export function clearSchedule(cid: number) {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return;
  comp.nom_ends_at = null; comp.group_ends_at = null; comp.ko_round_ends_at = null; comp.group_round_ends_at = null;
  comp.break_anchor = null; // 没有截止时间就没有网格可锚
  writeDb(db);
}

/** Push the nomination deadline back by `postpone_days` (pool was too small). */
export function postponeNomination(cid: number) {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp || comp.phase !== "nomination" || !comp.nom_ends_at) return;
  comp.nom_ends_at += (comp.postpone_days || 1) * 86400_000;
  writeDb(db);
}

/** How many candidates are currently in the pool (used to decide postpone). */
export function poolSize(cid: number): number {
  return readDbRO().candidates.filter((c) => c.competition_id === cid).length;
}

/** #4: how many candidates clear nom_min_votes — the number startGroups actually ranks
 *  (poolSize counts everyone, which can deadlock auto-open when a threshold is set). */
export function qualifyingCount(cid: number): number {
  const db = readDbRO();
  const comp = db.competitions.find((c) => c.id === cid);
  const minVotes = comp?.nom_min_votes ?? 0;
  const { total: nomCount } = nominationTally(db, cid);
  return topLevel(db, cid).filter((c) => (nomCount.get(c.id) || 0) >= minVotes).length;
}

/** #5: can the current grouping actually fill the knockout bracket? Checked before advancing
 *  the final matchday so we never commit "group done" and then fail to start the knockout. */
export function canStartKnockout(cid: number): boolean {
  const db = readDbRO();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return false;
  const grouped = db.candidates.filter((c) => c.competition_id === cid && c.group_no != null);
  const numGroups = comp.groups_count ?? (grouped.length ? Math.max(...grouped.map((c) => c.group_no!)) + 1 : 0);
  if (numGroups <= 0) return false;
  const koTarget = comp.ko_target ?? nextPow2(2 * numGroups);
  return grouped.length >= koTarget;
}

// ── undo / resettle ───────────────────────────────────────────

function dropMatchups(db: DB, cid: number, pred: (m: Matchup) => boolean): void {
  const removed = new Set(db.matchups.filter((m) => m.competition_id === cid && pred(m)).map((m) => m.id));
  db.matchups = db.matchups.filter((m) => !(m.competition_id === cid && pred(m)));
  db.matchVotes = db.matchVotes.filter((v) => !removed.has(v.matchup_id));
}

/** 撤回上一步阶段推进（仅一步）：finished→knockout、knockout→上一轮/小组赛、小组赛→提名。 */
/**
 * Wipe the intermission bookkeeping. Call whenever a round is un-done or re-planned.
 *
 * Why it matters: break_after records "this round already had its break", which is what stops the
 * scheduler re-arming a break forever. After an undo the round is going to be run AGAIN, so that
 * marker is stale — leaving it makes the retry skip its review window entirely, which is exactly
 * the run where the operator most wants one (they just undid something). A stale break_until would
 * also keep voting shut after the phase moved, and a stale break_anchor could anchor the next
 * deadline to a round that no longer exists.
 */
function clearBreakState(comp: Competition): void {
  comp.break_until = null;
  comp.break_after = null;
  comp.break_anchor = null;
}

export function undoLastTransition(cid: number): string {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) throw new Error("比赛不存在。");
  if (comp.phase === "nomination") throw new Error("提名阶段没有可撤销的步骤。");
  clearBreakState(comp); // 这一轮要重新跑，休赛期记录一律作废（见 clearBreakState）

  if (comp.phase === "group") {
    dropMatchups(db, cid, (m) => m.stage === "group");
    db.approvalVotes = db.approvalVotes.filter((v) => v.competition_id !== cid); // #2: don't let stale group votes survive the undo
    for (const c of db.candidates) if (c.competition_id === cid) { c.group_no = null; c.seed = null; c.eliminated = false; }
    comp.phase = "nomination";
    comp.target_size = null; comp.groups_count = null;
    comp.group_ends_at = null;
    comp.group_matchday = null; comp.group_matchday_count = null; comp.group_round_ends_at = null; comp.group_started_at = null; comp.group_matchday_starts = null;
    writeDb(db);
    return "已撤回：小组赛 → 回到提名阶段。";
  }

  if (comp.phase === "knockout") {
    const cur = comp.ko_round as number;
    if (cur > 1) {
      const prev = cur - 1;
      const prevMs = db.matchups.filter((m) => m.competition_id === cid && m.stage === "knockout" && m.round_no === prev);
      const losers = new Set<number>();
      for (const m of prevMs) if (m.decided && m.winner_id != null) losers.add(m.winner_id === m.a_id ? m.b_id : m.a_id);
      dropMatchups(db, cid, (m) => m.stage === "knockout" && m.round_no === cur);
      for (const m of prevMs) { m.decided = false; m.winner_id = null; }
      for (const c of db.candidates) if (c.competition_id === cid && losers.has(c.id)) c.eliminated = false;
      comp.ko_round = prev; comp.ko_round_ends_at = null;
      writeDb(db);
      return `已撤回：第 ${cur} 轮 → 回到第 ${prev} 轮。`;
    }
    dropMatchups(db, cid, (m) => m.stage === "knockout");
    for (const m of db.matchups) if (m.competition_id === cid && m.stage === "group") { m.decided = false; m.winner_id = null; }
    for (const c of db.candidates) if (c.competition_id === cid && c.group_no !== null) c.eliminated = false;
    comp.phase = "group"; comp.ko_round = null; comp.ko_round_ends_at = null;
    comp.group_matchday = comp.group_matchday_count ?? 1; comp.group_round_ends_at = null;
    writeDb(db);
    return "已撤回：淘汰赛 → 回到小组赛。";
  }

  if (comp.phase === "finished") {
    const last = (comp.ko_round as number) - 1;
    const ms = db.matchups.filter((m) => m.competition_id === cid && m.stage === "knockout" && m.round_no === last);
    const losers = new Set<number>();
    for (const m of ms) if (m.decided && m.winner_id != null) losers.add(m.winner_id === m.a_id ? m.b_id : m.a_id);
    for (const m of ms) { m.decided = false; m.winner_id = null; }
    for (const c of db.candidates) if (c.competition_id === cid && losers.has(c.id)) c.eliminated = false;
    comp.phase = "knockout"; comp.champion_id = null; comp.ko_round = last; comp.ko_round_ends_at = null;
    writeDb(db);
    return "已撤回：冠军 → 回到决赛轮。";
  }
  if (comp.phase === "playoff") {
    dropMatchups(db, cid, (m) => m.stage === "playoff");
    for (const c of db.candidates) if (c.competition_id === cid && c.group_no != null) c.eliminated = false; // playoff eliminated nobody permanently yet
    comp.ko_seed_ids = null; comp.playoff_slots = null;
    comp.phase = "group";
    comp.group_matchday = comp.group_matchday_count ?? 1;
    comp.group_round_ends_at = null;
    writeDb(db);
    return "已撤回：加赛 → 回到小组赛（末比赛日）。";
  }
  throw new Error("当前阶段没有可撤销的步骤。");
}

/** 按当前票数重算当前轮：group 锁定小组赛、knockout 结算当前轮、finished 重算决赛。 */
export function resettleCurrentRound(cid: number): string {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) throw new Error("比赛不存在。");
  const counts = matchCounts(db, cid);

  if (comp.phase === "group") {
    const cur = comp.group_matchday ?? 1;
    const seedOf = seedLookup(db, cid);
    for (const m of db.matchups) if (m.competition_id === cid && m.stage === "group" && (m.matchday ?? 1) === cur) decide(m, counts, seedOf);
    writeDb(db);
    return `已重算：第 ${cur} 个比赛日按当前票数结算。`;
  }
  if (comp.phase === "knockout") {
    const round = comp.ko_round as number;
    const seedOf = seedLookup(db, cid);
    for (const m of db.matchups) if (m.competition_id === cid && m.stage === "knockout" && m.round_no === round) decide(m, counts, seedOf);
    writeDb(db);
    return `已重算：第 ${round} 轮按当前票数结算。`;
  }
  if (comp.phase === "finished") {
    const last = (comp.ko_round as number) - 1;
    const ms = db.matchups.filter((m) => m.competition_id === cid && m.stage === "knockout" && m.round_no === last);
    const seedOf = seedLookup(db, cid);
    for (const m of ms) decide(m, counts, seedOf);
    const winners = ms.map((m) => m.winner_id!).filter((x) => x != null);
    comp.champion_id = winners[0] ?? null;
    writeDb(db);
    return "已重算：决赛按当前票数结算。";
  }
  if (comp.phase === "playoff") {
    const seedOf = seedLookup(db, cid);
    for (const m of db.matchups) if (m.competition_id === cid && m.stage === "playoff") decide(m, counts, seedOf);
    writeDb(db);
    return "已重算：加赛按当前票数结算（如需进入淘汰赛请再点『结算加赛 → 生成淘汰赛』）。";
  }
  throw new Error("当前阶段无需重算。");
}

/** 设置提名约束：每人提名上限（userLimit,0=不限）、进入小组赛的最低提名票（minVotes,0=不限）。 */
export function setNominationRules(cid: number, userLimit: number, minVotes: number) {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return;
  comp.nom_user_limit = Number.isFinite(userLimit) && userLimit > 0 ? Math.floor(userLimit) : 0;
  comp.nom_min_votes = Number.isFinite(minVotes) && minVotes > 0 ? Math.floor(minVotes) : 0;
  writeDb(db);
}

/** 直接设定/延长/清除当前阶段的截止时间（hours<=0 表示清除）。用于运营手动调度控制。 */
export function setPhaseDeadline(cid: number, hours: number) {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return;
  const at = hours > 0 ? Date.now() + Math.round(hours * 3600_000) : null;
  if (comp.phase === "nomination") comp.nom_ends_at = at;
  else if (comp.phase === "group") comp.group_round_ends_at = at;
  else if (comp.phase === "knockout") comp.ko_round_ends_at = at;
  // 管理员手动改本阶段截止 = 重新定义时间网格，旧的休赛期锚点不再适用
  comp.break_anchor = null;
  writeDb(db);
}

/** 设置每比赛日最多对局数（0/负数 → 默认 4）。 */
export function setGroupDayCap(cid: number, cap: number): void {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return;
  comp.group_day_cap = Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : null;
  writeDb(db);
}

/** 调整"节奏"：后续小组赛比赛日的天数 / 后续淘汰赛每轮的小时数（0 表示不改）。 */
export function setPace(cid: number, groupRoundDays: number, roundHours: number) {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return;
  if (groupRoundDays > 0) comp.group_round_days = Math.floor(groupRoundDays);
  if (roundHours > 0) comp.round_hours = Math.floor(roundHours);
  writeDb(db);
}
