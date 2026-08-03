import { readDb, writeDb, commentCounts, type DB, type Competition, type Candidate, type Matchup } from "./db";

// ── reads ─────────────────────────────────────────────────────
export function getActiveCompetition(): Competition | null {
  const db = readDb();
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

// ── full state for the UI, personalised to one voter ─────────
export function getState(voterId: string) {
  const db = readDb();
  const comp = db.competitions.length ? db.competitions.reduce((a, b) => (b.id > a.id ? b : a)) : null;
  if (!comp) return { competition: null };

  const cands = db.candidates.filter((c) => c.competition_id === comp.id).sort((a, b) => a.id - b.id);
  const slim = (c: Candidate | undefined) =>
    c ? { id: c.id, name: c.name, nameCn: c.name_cn, nameEn: c.name_en ?? null, image: c.image, subjectName: c.subject_name ?? null } : null;

  const base = {
    competition: {
      id: comp.id, title: comp.title, description: comp.description, phase: comp.phase,
      groupsCount: comp.groups_count, advancePerGroup: comp.advance_per_group, championId: comp.champion_id,
      nomEndsAt: comp.nom_ends_at ?? null, groupEndsAt: comp.group_ends_at ?? null, koRoundEndsAt: comp.ko_round_ends_at ?? null,
      postponeDays: comp.postpone_days ?? null,
      nomUserLimit: comp.nom_user_limit ?? 0, nomMinVotes: comp.nom_min_votes ?? 0,
      groupMatchday: comp.group_matchday ?? null, groupMatchdayCount: comp.group_matchday_count ?? null,
      groupRoundEndsAt: comp.group_round_ends_at ?? null,
      groupPerRound: comp.group_per_round ?? 0, groupRoundDays: comp.group_round_days ?? 0,
      groupDayCap: comp.group_day_cap ?? 4,
      koTarget: comp.ko_target ?? null,
    },
  };

  if (comp.phase === "nomination") {
    const nomCount = new Map<number, number>();
    for (const v of db.nominationVotes) if (v.competition_id === comp.id) nomCount.set(v.candidate_id, (nomCount.get(v.candidate_id) || 0) + 1);
    const myNomSet = new Set(db.nominationVotes.filter((v) => v.competition_id === comp.id && v.voter_id === voterId).map((v) => v.candidate_id));
    const pool = cands
      .map((c) => ({ ...slim(c)!, votes: nomCount.get(c.id) || 0, voted: myNomSet.has(c.id), mine: (c.added_by || "") === voterId }))
      .sort((x, y) => y.votes - x.votes || x.name.localeCompare(y.name));
    return { ...base, nomination: { pool, userLimit: comp.nom_user_limit ?? 0, minVotes: comp.nom_min_votes ?? 0, myCount: myNomSet.size } };
  }

  const ms = db.matchups.filter((m) => m.competition_id === comp.id);
  const cmap = new Map(cands.map((c) => [c.id, c]));
  const counts = matchCounts(db, comp.id);
  const cc = commentCounts(comp.id);
  const myChoice = new Map<number, number>();
  const compMatchIds = new Set(ms.map((m) => m.id));
  for (const v of db.matchVotes) if (v.voter_id === voterId && compMatchIds.has(v.matchup_id)) myChoice.set(v.matchup_id, v.choice_id);

  const votesA = (m: Matchup) => counts.get(m.id + ":" + m.a_id) || 0;
  const votesB = (m: Matchup) => counts.get(m.id + ":" + m.b_id) || 0;
  const seedOf = (id: number) => cmap.get(id)?.seed ?? Number.MAX_SAFE_INTEGER;
  const liveWinner = (m: Matchup): number | null => {
    if (m.decided) return m.winner_id;
    const a = votesA(m), b = votesB(m);
    // 与 decide() 一致:平票判种子高者,种子相同判 A 方
    if (a !== b) return a > b ? m.a_id : m.b_id;
    return seedOf(m.a_id) <= seedOf(m.b_id) ? m.a_id : m.b_id;
  };
  // 赛中只公布「得票率」;结算后(decided)才公布绝对票数。
  const shapeMatch = (m: Matchup) => {
    const va = votesA(m), vb = votesB(m), total = va + vb;
    const revealed = m.decided;
    return {
      id: m.id, stage: m.stage, round: m.round_no, group: m.group_no, slot: m.slot,
      a: slim(cmap.get(m.a_id)), b: slim(cmap.get(m.b_id)),
      votesA: revealed ? va : null, votesB: revealed ? vb : null, total: revealed ? total : null,
      rateA: total ? Math.round((va / total) * 100) : null,
      winnerId: liveWinner(m), decided: m.decided, myChoice: myChoice.get(m.id) ?? null,
      commentN: cc[m.id] || 0,
    };
  };

  const result: any = { ...base };

  // nomination ranking — kept for the "预选" view (read-only) after nomination closes
  {
    const nomCount = new Map<number, number>();
    for (const v of db.nominationVotes) if (v.competition_id === comp.id) nomCount.set(v.candidate_id, (nomCount.get(v.candidate_id) || 0) + 1);
    result.nominationRanking = cands
      .map((c) => ({ ...slim(c)!, votes: nomCount.get(c.id) || 0 }))
      .sort((x, y) => y.votes - x.votes || x.name.localeCompare(y.name));
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
    // scheduled start of each matchday (null when no pace is set)
    const roundMs = (comp.group_round_days || 0) * 86400_000;
    const mdDate = (d: number): number | null => (!comp.group_round_days || !comp.group_round_ends_at) ? null : comp.group_round_ends_at - (curMd - d + 1) * roundMs;
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
    result.group = { groups, matchday: curMd, matchdayCount: mdCount };
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
      return { round: r, label: roundLabel(list.length * 2), matchups: list.map(shapeMatch) };
    });
    const lastRoundNo = roundNos[roundNos.length - 1];
    const lastCount = koMs.filter((m) => m.round_no === lastRoundNo).length;
    const champion = comp.champion_id ? slim(cmap.get(comp.champion_id)) : null;
    result.knockout = { rounds, champion, finished: comp.phase === "finished", nextLabel: comp.phase === "knockout" && lastCount > 1 ? roundLabel(lastCount) : null };
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

// ── helpers ───────────────────────────────────────────────────
function isPow2(n: number) { return n >= 2 && (n & (n - 1)) === 0; }
function nextPow2(n: number): number { let p = 1; while (p < n) p <<= 1; return Math.max(2, p); }
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
  // 平票 / 零票:判给种子更高者(seed 序号更小);种子相同则判 A 方。
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
export function updateCompetition(cid: number, title: string, description: string | null) {
  const t = (title || "").trim();
  if (!t) throw new Error("标题不能为空。");
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return;
  comp.title = t;
  comp.description = (description || "").trim() || null;
  writeDb(db);
}

/** nomination → group: keep top `size` candidates, split into groups, build round-robin. */
export function startGroups(cid: number, size: number, perRound = 0, roundDays = 0) {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp || comp.phase !== "nomination") return; // idempotent

  const nomCount = new Map<number, number>();
  for (const v of db.nominationVotes) if (v.competition_id === cid) nomCount.set(v.candidate_id, (nomCount.get(v.candidate_id) || 0) + 1);
  const compCands = db.candidates.filter((c) => c.competition_id === cid);
  const minVotes = comp.nom_min_votes ?? 0;
  const ranked = compCands
    .map((c) => ({ id: c.id, votes: nomCount.get(c.id) || 0 }))
    .filter((r) => r.votes >= minVotes)
    .sort((a, b) => b.votes - a.votes || a.id - b.id);
  if (ranked.length < size) throw new Error(minVotes > 0
    ? `达到最低提名票(${minVotes})的角色只有 ${ranked.length} 个,不足 ${size} 个。`
    : `提名池只有 ${ranked.length} 个角色,不足 ${size} 个。`);

  // 并列全取:凑满 size,但票数与第 size 名并列的角色一并纳入(如取前 20 遇并列 → 可能取 23)。
  const cutoffVotes = ranked[size - 1].votes;
  const qualifiers = ranked.filter((r) => r.votes >= cutoffVotes); // a >= size
  const a = qualifiers.length;
  if (a < 4) throw new Error("晋级人数不足 4,无法组成小组。");

  const seedOfId = new Map<number, number>();
  qualifiers.forEach((r, i) => seedOfId.set(r.id, i)); // 排位赛种子 = 提名排名(0 最强)

  const c = a % 4;
  const base = a - c;
  const numGroups = Math.max(1, Math.floor(base / 4));

  // 前 base 名随机分成 numGroups 个 4 人组
  const topIds = shuffle(qualifiers.slice(0, base).map((r) => r.id));
  const groups: number[][] = Array.from({ length: numGroups }, () => []);
  topIds.forEach((id, i) => groups[Math.floor(i / 4)].push(id));

  // 余下 c 名补进「最弱」的 c 个组(成员种子和最大者最弱;并列随机)→ 这些组变 5 人
  const leftovers = qualifiers.slice(base).map((r) => r.id);
  const strength = groups.map((g, idx) => ({ idx, sum: g.reduce((t, id) => t + (seedOfId.get(id) || 0), 0), r: Math.random() }));
  strength.sort((x, y) => y.sum - x.sum || x.r - y.r);
  leftovers.forEach((id, i) => groups[strength[i % strength.length].idx].push(id));

  // 落位:非晋级者淘汰
  const chosen = new Set(qualifiers.map((r) => r.id));
  for (const cand of compCands) if (!chosen.has(cand.id)) { cand.group_no = null; cand.eliminated = true; }
  groups.forEach((g, gi) => g.forEach((id) => {
    const cand = db.candidates.find((x) => x.id === id)!;
    cand.group_no = gi; cand.seed = seedOfId.get(id)!; cand.eliminated = false;
  }));

  comp.phase = "group";
  comp.target_size = a;
  comp.groups_count = numGroups;
  comp.advance_per_group = null; // 世界杯式:不再是固定「每组晋级 N」
  comp.ko_target = nextPow2(2 * numGroups); // ≤8 组→16,9-16 组→32,以此类推
  comp.nom_ends_at = null;

  // 比赛日排程:每组各自 circle method 生成轮次,再全局装箱成「每个比赛日 ≤ DAY_CAP 场」
  const K = perRound > 0 ? perRound : (comp.group_per_round ?? 0);
  const RD = roundDays > 0 ? roundDays : (comp.group_round_days ?? 0);
  const DAY_CAP = comp.group_day_cap && comp.group_day_cap > 0 ? comp.group_day_cap : GROUP_DAY_CAP;
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
  comp.group_round_ends_at = RD > 0 ? Date.now() + RD * 86400_000 : null;
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
  const counts = matchCounts(db, cid);
  const seedOf = seedLookup(db, cid);
  for (const m of db.matchups)
    if (m.competition_id === cid && m.stage === "group" && (m.matchday ?? 1) === cur) decide(m, counts, seedOf);
  if (cur < count) {
    comp.group_matchday = cur + 1;
    comp.group_round_ends_at = comp.group_round_days ? Date.now() + comp.group_round_days * 86400_000 : null;
    writeDb(db);
    return { done: false, message: `已结算第 ${cur} 个比赛日，进入第 ${cur + 1}/${count} 个比赛日。` };
  }
  comp.group_round_ends_at = null;
  writeDb(db);
  return { done: true, message: `已结算最后一个比赛日（第 ${cur}/${count}）。现在可以开淘汰赛。` };
}

/** group → knockout (World Cup): winners + runners-up + best remaining → nextPow2(2×组数).
 *  若最后填补名额在「小组胜负 + 提名票」上并列,则对并列者开循环赛加赛决定。 */
export function startKnockout(cid: number) {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp || comp.phase !== "group") throw new Error("当前不在小组赛阶段。");
  const numGroups = comp.groups_count as number;
  const koTarget = comp.ko_target ?? nextPow2(2 * numGroups);
  const counts = matchCounts(db, cid);
  const seedOf = seedLookup(db, cid);

  for (const m of db.matchups) if (m.competition_id === cid && m.stage === "group") decide(m, counts, seedOf);

  const nomCount = new Map<number, number>();
  for (const v of db.nominationVotes) if (v.competition_id === cid) nomCount.set(v.candidate_id, (nomCount.get(v.candidate_id) || 0) + 1);

  type Row = { id: number; wins: number; vf: number; votes: number; groupRank: number };
  const autoAdv: Row[] = [];
  const fillPool: Row[] = [];
  for (let g = 0; g < numGroups; g++) {
    const gms = db.matchups.filter((m) => m.competition_id === cid && m.stage === "group" && m.group_no === g);
    const members = db.candidates.filter((cd) => cd.competition_id === cid && cd.group_no === g);
    const stats: Row[] = members.map((mem) => {
      let wins = 0, vf = 0;
      for (const mm of gms) {
        const va = counts.get(mm.id + ":" + mm.a_id) || 0, vb = counts.get(mm.id + ":" + mm.b_id) || 0;
        if (mm.a_id === mem.id) vf += va;
        if (mm.b_id === mem.id) vf += vb;
        if (mm.winner_id === mem.id) wins++;
      }
      return { id: mem.id, wins, vf, votes: nomCount.get(mem.id) || 0, groupRank: 0 };
    });
    stats.sort((x, y) => y.wins - x.wins || y.vf - x.vf || seedOf(x.id) - seedOf(y.id));
    stats.forEach((s2, i) => (s2.groupRank = i));
    autoAdv.push(...stats.slice(0, 2));
    fillPool.push(...stats.slice(2));
  }

  const seedCmp = (x: Row, y: Row) => x.groupRank - y.groupRank || y.wins - x.wins || y.votes - x.votes || seedOf(x.id) - seedOf(y.id);
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
  if (bySeed.length !== koTarget || !isPow2(bySeed.length)) throw new Error(`可晋级人数 ${bySeed.length} 无法凑成 ${koTarget} 强(检查小组与人数)。`);
  buildKnockout(db, comp, cid, bySeed);
  writeDb(db);
}

/** Build the round-1 bracket from an ordered advancer list (index 0 = strongest). */
function buildKnockout(db: DB, comp: Competition, cid: number, seedIds: number[]) {
  const advSet = new Set(seedIds);
  for (const cd of db.candidates) if (cd.competition_id === cid && cd.group_no != null && !advSet.has(cd.id)) cd.eliminated = true;
  comp.phase = "knockout"; comp.ko_round = 1;
  comp.group_round_ends_at = null; comp.group_ends_at = null;
  comp.ko_seed_ids = null; comp.playoff_slots = null;
  comp.ko_round_ends_at = comp.round_hours ? Date.now() + comp.round_hours * 3600_000 : null;
  const n = seedIds.length;
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
  for (const r of rows.slice(slots)) { const c = db.candidates.find((x) => x.id === r.id); if (c) c.eliminated = true; }
  const winners = rows.slice(0, slots).map((r) => r.id);
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
  const winners = cur.map((m) => m.winner_id!).filter((x) => x != null) as number[];

  for (const m of cur) {
    const loser = m.winner_id === m.a_id ? m.b_id : m.a_id;
    const lc = db.candidates.find((c) => c.id === loser);
    if (lc) lc.eliminated = true;
  }

  comp.ko_round = round + 1;
  if (winners.length <= 1) {
    comp.phase = "finished"; comp.champion_id = winners[0] ?? null;
    comp.ko_round_ends_at = null;
    writeDb(db);
    return;
  }
  comp.ko_round_ends_at = comp.round_hours ? Date.now() + comp.round_hours * 3600_000 : null;
  for (let i = 0; i < winners.length; i += 2)
    db.matchups.push({ id: ++db.seq.matchup, competition_id: cid, stage: "knockout", round_no: round + 1, group_no: null, slot: i / 2, a_id: winners[i], b_id: winners[i + 1], winner_id: null, decided: false });
  writeDb(db);
}

// ── scheduling ────────────────────────────────────────────────
export interface ScheduleOpts {
  nomEndsAt: number | null;      // epoch ms when nomination auto-closes
  autoSize: number; autoGroups?: number; autoAdvance?: number;
  groupHours: number | null;     // (legacy) whole group-stage duration
  roundHours: number | null;     // per knockout-round duration
  postponeDays: number;          // days to push back if the pool is short at the deadline
  groupPerRound?: number;        // matches per matchday per group (0 = auto)
  groupRoundDays?: number;       // days per group matchday
}

/** Arm the automatic schedule (only meaningful in the nomination phase). */
export function scheduleCompetition(cid: number, o: ScheduleOpts) {
  if (o.autoSize < 4) throw new Error("参赛人数至少 4 人。");
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return;
  comp.auto_size = o.autoSize; comp.auto_groups = o.autoGroups ?? null; comp.auto_advance = o.autoAdvance ?? null;
  comp.group_hours = o.groupHours; comp.round_hours = o.roundHours;
  comp.group_per_round = o.groupPerRound && o.groupPerRound > 0 ? o.groupPerRound : null;
  comp.group_round_days = o.groupRoundDays && o.groupRoundDays > 0 ? o.groupRoundDays : null;
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
  return readDb().candidates.filter((c) => c.competition_id === cid).length;
}

// ── undo / resettle ───────────────────────────────────────────

function dropMatchups(db: DB, cid: number, pred: (m: Matchup) => boolean): void {
  const removed = new Set(db.matchups.filter((m) => m.competition_id === cid && pred(m)).map((m) => m.id));
  db.matchups = db.matchups.filter((m) => !(m.competition_id === cid && pred(m)));
  db.matchVotes = db.matchVotes.filter((v) => !removed.has(v.matchup_id));
}

/** 撤回上一步阶段推进(仅一步):finished→knockout、knockout→上一轮/小组赛、小组赛→提名。 */
export function undoLastTransition(cid: number): string {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) throw new Error("比赛不存在。");
  if (comp.phase === "nomination") throw new Error("提名阶段没有可撤销的步骤。");

  if (comp.phase === "group") {
    dropMatchups(db, cid, (m) => m.stage === "group");
    for (const c of db.candidates) if (c.competition_id === cid) { c.group_no = null; c.seed = null; c.eliminated = false; }
    comp.phase = "nomination";
    comp.target_size = null; comp.groups_count = null; comp.advance_per_group = null;
    comp.group_ends_at = null;
    comp.group_matchday = null; comp.group_matchday_count = null; comp.group_round_ends_at = null;
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
  throw new Error("当前阶段没有可撤销的步骤。");
}

/** 按当前票数重算当前轮:group 锁定小组赛、knockout 结算当前轮、finished 重算决赛。 */
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
  throw new Error("当前阶段无需重算。");
}

/** 设置提名约束:每人提名上限(userLimit,0=不限)、进入小组赛的最低提名票(minVotes,0=不限)。 */
export function setNominationRules(cid: number, userLimit: number, minVotes: number) {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return;
  comp.nom_user_limit = Number.isFinite(userLimit) && userLimit > 0 ? Math.floor(userLimit) : 0;
  comp.nom_min_votes = Number.isFinite(minVotes) && minVotes > 0 ? Math.floor(minVotes) : 0;
  writeDb(db);
}

/** 直接设定/延长/清除当前阶段的截止时间(hours<=0 表示清除)。用于运营手动调度控制。 */
export function setPhaseDeadline(cid: number, hours: number) {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return;
  const at = hours > 0 ? Date.now() + Math.round(hours * 3600_000) : null;
  if (comp.phase === "nomination") comp.nom_ends_at = at;
  else if (comp.phase === "group") comp.group_round_ends_at = at;
  else if (comp.phase === "knockout") comp.ko_round_ends_at = at;
  writeDb(db);
}

/** 设置每比赛日最多对局数(0/负数 → 默认 4)。 */
export function setGroupDayCap(cid: number, cap: number): void {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return;
  comp.group_day_cap = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : null;
  writeDb(db);
}

/** 调整"节奏":后续小组赛比赛日的天数 / 后续淘汰赛每轮的小时数(0 表示不改)。 */
export function setPace(cid: number, groupRoundDays: number, roundHours: number) {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return;
  if (groupRoundDays > 0) comp.group_round_days = Math.floor(groupRoundDays);
  if (roundHours > 0) comp.round_hours = Math.floor(roundHours);
  writeDb(db);
}
