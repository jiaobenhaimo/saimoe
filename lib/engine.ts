import { readDb, writeDb, type DB, type Competition, type Candidate, type Matchup } from "./db";

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
    c ? { id: c.id, name: c.name, nameCn: c.name_cn, image: c.image } : null;

  const base = {
    competition: {
      id: comp.id, title: comp.title, description: comp.description, phase: comp.phase,
      groupsCount: comp.groups_count, advancePerGroup: comp.advance_per_group, championId: comp.champion_id,
      nomEndsAt: comp.nom_ends_at ?? null, groupEndsAt: comp.group_ends_at ?? null, koRoundEndsAt: comp.ko_round_ends_at ?? null,
      postponeDays: comp.postpone_days ?? null,
    },
  };

  if (comp.phase === "nomination") {
    const nomCount = new Map<number, number>();
    for (const v of db.nominationVotes) if (v.competition_id === comp.id) nomCount.set(v.candidate_id, (nomCount.get(v.candidate_id) || 0) + 1);
    const myNomSet = new Set(db.nominationVotes.filter((v) => v.competition_id === comp.id && v.voter_id === voterId).map((v) => v.candidate_id));
    const pool = cands
      .map((c) => ({ ...slim(c)!, votes: nomCount.get(c.id) || 0, voted: myNomSet.has(c.id) }))
      .sort((x, y) => y.votes - x.votes || x.name.localeCompare(y.name));
    return { ...base, nomination: { pool } };
  }

  const ms = db.matchups.filter((m) => m.competition_id === comp.id);
  const cmap = new Map(cands.map((c) => [c.id, c]));
  const counts = matchCounts(db, comp.id);
  const myChoice = new Map<number, number>();
  const compMatchIds = new Set(ms.map((m) => m.id));
  for (const v of db.matchVotes) if (v.voter_id === voterId && compMatchIds.has(v.matchup_id)) myChoice.set(v.matchup_id, v.choice_id);

  const votesA = (m: Matchup) => counts.get(m.id + ":" + m.a_id) || 0;
  const votesB = (m: Matchup) => counts.get(m.id + ":" + m.b_id) || 0;
  const liveWinner = (m: Matchup): number | null => {
    if (m.decided) return m.winner_id;
    const a = votesA(m), b = votesB(m);
    // 与结算规则 decide() 一致:平票判 A 方,避免「实时排名」与「结算排名」不一致
    return a === b ? m.a_id : a > b ? m.a_id : m.b_id;
  };
  const shapeMatch = (m: Matchup) => ({
    id: m.id, stage: m.stage, round: m.round_no, group: m.group_no, slot: m.slot,
    a: slim(cmap.get(m.a_id)), b: slim(cmap.get(m.b_id)),
    votesA: votesA(m), votesB: votesB(m),
    winnerId: liveWinner(m), decided: m.decided, myChoice: myChoice.get(m.id) ?? null,
  });

  if (comp.phase === "group") {
    const groupMs = ms.filter((m) => m.stage === "group");
    const byGroup = new Map<number, Matchup[]>();
    for (const m of groupMs) {
      const g = m.group_no ?? 0;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(m);
    }
    const groups = [...byGroup.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([g, list]) => {
        list.sort((a, b) => a.slot - b.slot);
        const members = cands.filter((c) => c.group_no === g);
        const stand = members.map((c) => {
          let wins = 0, vf = 0;
          for (const m of list) {
            if (m.a_id === c.id) vf += votesA(m);
            if (m.b_id === c.id) vf += votesB(m);
            if (liveWinner(m) === c.id) wins++;
          }
          return { ...slim(c)!, wins, votesFor: vf };
        });
        stand.sort((x, y) => y.wins - x.wins || y.votesFor - x.votesFor);
        return { group: g, standings: stand, matchups: list.map(shapeMatch) };
      });
    return { ...base, group: { groups } };
  }

  // knockout / finished
  const koMs = ms.filter((m) => m.stage === "knockout");
  const roundNos = [...new Set(koMs.map((m) => m.round_no))].sort((a, b) => a - b);
  const rounds = roundNos.map((r) => {
    const list = koMs.filter((m) => m.round_no === r).sort((a, b) => a.slot - b.slot);
    return { round: r, label: roundLabel(list.length * 2), matchups: list.map(shapeMatch) };
  });
  const champion = comp.champion_id ? slim(cmap.get(comp.champion_id)) : null;
  return { ...base, knockout: { rounds, champion, finished: comp.phase === "finished" } };
}

function roundLabel(contestants: number): string {
  if (contestants <= 2) return "决赛";
  if (contestants === 4) return "半决赛";
  if (contestants === 8) return "四分之一决赛";
  return `${contestants} 强`;
}

// ── helpers ───────────────────────────────────────────────────
function isPow2(n: number) { return n >= 2 && (n & (n - 1)) === 0; }

function decide(m: Matchup, counts: Map<string, number>) {
  const a = counts.get(m.id + ":" + m.a_id) || 0;
  const b = counts.get(m.id + ":" + m.b_id) || 0;
  // tie / zero-vote matchups resolve deterministically to the A side
  m.winner_id = a === b ? m.a_id : a > b ? m.a_id : m.b_id;
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
export function startGroups(cid: number, size: number, groupsCount: number, advancePerGroup: number) {
  const qualifiers = groupsCount * advancePerGroup;
  if (!isPow2(qualifiers)) throw new Error(`晋级总数 ${qualifiers}（小组数×每组晋级）必须是 2 的幂，淘汰赛才不会有轮空。当前不是。`);
  if (size < groupsCount * 2) throw new Error("参赛人数太少，无法组成每组至少 2 人的小组。");
  const minGroupSize = Math.floor(size / groupsCount);
  if (advancePerGroup > minGroupSize) throw new Error(`每组约 ${minGroupSize} 人，每组晋级 ${advancePerGroup} 人会导致人数不足、赛程卡死。请把「每组晋级」改为 ≤ ${minGroupSize}。`);

  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp || comp.phase !== "nomination") return; // idempotent: already started

  const nomCount = new Map<number, number>();
  for (const v of db.nominationVotes) if (v.competition_id === cid) nomCount.set(v.candidate_id, (nomCount.get(v.candidate_id) || 0) + 1);
  const compCands = db.candidates.filter((c) => c.competition_id === cid);
  const ranked = compCands
    .map((c) => ({ id: c.id, votes: nomCount.get(c.id) || 0 }))
    .sort((a, b) => b.votes - a.votes || a.id - b.id)
    .slice(0, size);
  if (ranked.length < size) throw new Error(`提名池只有 ${ranked.length} 个角色，不足 ${size} 个。`);

  comp.phase = "group"; comp.target_size = size; comp.groups_count = groupsCount; comp.advance_per_group = advancePerGroup;
  comp.nom_ends_at = null;
  comp.group_ends_at = comp.group_hours ? Date.now() + comp.group_hours * 3600_000 : null;

  const chosen = new Set(ranked.map((r) => r.id));
  for (const c of compCands) if (!chosen.has(c.id)) { c.group_no = null; c.eliminated = true; }
  ranked.forEach((r, i) => {
    const c = db.candidates.find((x) => x.id === r.id)!;
    c.group_no = i % groupsCount; c.seed = i; c.eliminated = false;
  });

  const grp: number[][] = Array.from({ length: groupsCount }, () => []);
  ranked.forEach((r, i) => grp[i % groupsCount].push(r.id));
  for (let g = 0; g < groupsCount; g++) {
    let slot = 0;
    const arr = grp[g];
    for (let i = 0; i < arr.length; i++)
      for (let j = i + 1; j < arr.length; j++)
        db.matchups.push({ id: ++db.seq.matchup, competition_id: cid, stage: "group", round_no: 1, group_no: g, slot: slot++, a_id: arr[i], b_id: arr[j], winner_id: null, decided: false });
  }
  writeDb(db);
}

/** group → knockout: lock group results, take top N per group, seed the bracket. */
export function startKnockout(cid: number) {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp || comp.phase !== "group") throw new Error("当前不在小组赛阶段。");
  const advance = comp.advance_per_group as number;
  const groupsCount = comp.groups_count as number;
  const counts = matchCounts(db, cid);

  // lock all group matchups (deterministic → safe to re-run)
  for (const m of db.matchups) if (m.competition_id === cid && m.stage === "group") decide(m, counts);

  // standings per group; compute + validate BEFORE mutating phase (no stuck state)
  const perGroupOrdered: number[][] = [];
  const eliminatedIds: number[] = [];
  for (let g = 0; g < groupsCount; g++) {
    const ms = db.matchups.filter((m) => m.competition_id === cid && m.stage === "group" && m.group_no === g);
    const members = db.candidates.filter((c) => c.competition_id === cid && c.group_no === g);
    const stats = members.map((mem) => {
      let wins = 0, vf = 0;
      for (const mm of ms) {
        const va = counts.get(mm.id + ":" + mm.a_id) || 0;
        const vb = counts.get(mm.id + ":" + mm.b_id) || 0;
        if (mm.a_id === mem.id) vf += va;
        if (mm.b_id === mem.id) vf += vb;
        if (mm.winner_id === mem.id) wins++;
      }
      return { id: mem.id, wins, vf };
    });
    stats.sort((x, y) => y.wins - x.wins || y.vf - x.vf);
    perGroupOrdered.push(stats.slice(0, advance).map((s) => s.id));
    for (const s of stats.slice(advance)) eliminatedIds.push(s.id);
  }
  const qualifiersBySeed: number[] = [];
  for (let rank = 0; rank < advance; rank++)
    for (let g = 0; g < groupsCount; g++)
      if (perGroupOrdered[g][rank] != null) qualifiersBySeed.push(perGroupOrdered[g][rank]);

  const n = qualifiersBySeed.length;
  if (!isPow2(n)) throw new Error(`晋级人数 ${n} 不是 2 的幂，无法生成干净的淘汰赛（检查每组人数是否够 ${advance} 名晋级）。`);

  comp.phase = "knockout"; comp.ko_round = 1;
  comp.group_ends_at = null;
  comp.ko_round_ends_at = comp.round_hours ? Date.now() + comp.round_hours * 3600_000 : null;
  for (const id of eliminatedIds) { const c = db.candidates.find((x) => x.id === id); if (c) c.eliminated = true; }

  const order = bracketSeedOrder(n);
  const placed = order.map((seed) => qualifiersBySeed[seed - 1]);
  for (let i = 0; i < placed.length; i += 2) {
    db.matchups.push({ id: ++db.seq.matchup, competition_id: cid, stage: "knockout", round_no: 1, group_no: null, slot: i / 2, a_id: placed[i], b_id: placed[i + 1], winner_id: null, decided: false });
    const ca = db.candidates.find((x) => x.id === placed[i]); if (ca) ca.seed = order[i];
    const cb = db.candidates.find((x) => x.id === placed[i + 1]); if (cb) cb.seed = order[i + 1];
  }
  writeDb(db);
}

/** Resolve the current knockout round; build the next one, or finish. */
export function advanceKnockout(cid: number) {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp || comp.phase !== "knockout") throw new Error("当前不在淘汰赛阶段。");

  const koMs = db.matchups.filter((m) => m.competition_id === cid && m.stage === "knockout");
  const round = comp.ko_round ?? (koMs.length ? Math.max(...koMs.map((m) => m.round_no)) : 1);
  const counts = matchCounts(db, cid);

  const cur = koMs.filter((m) => m.round_no === round).sort((a, b) => a.slot - b.slot);
  for (const m of cur) decide(m, counts);
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
  autoSize: number; autoGroups: number; autoAdvance: number;
  groupHours: number | null;     // group-stage duration
  roundHours: number | null;     // per knockout-round duration
  postponeDays: number;          // days to push back if the pool is short at the deadline
}

/** Arm the automatic schedule (only meaningful in the nomination phase). */
export function scheduleCompetition(cid: number, o: ScheduleOpts) {
  const qualifiers = o.autoGroups * o.autoAdvance;
  if (!isPow2(qualifiers)) throw new Error(`晋级总数 ${qualifiers}（小组数×每组晋级）必须是 2 的幂。`);
  if (o.autoSize < o.autoGroups * 2) throw new Error("参赛人数太少，无法组成每组至少 2 人的小组。");
  const minGroupSize = Math.floor(o.autoSize / o.autoGroups);
  if (o.autoAdvance > minGroupSize) throw new Error(`每组约 ${minGroupSize} 人，每组晋级 ${o.autoAdvance} 人会导致人数不足。请把每组晋级改为 ≤ ${minGroupSize}。`);
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return;
  comp.auto_size = o.autoSize; comp.auto_groups = o.autoGroups; comp.auto_advance = o.autoAdvance;
  comp.group_hours = o.groupHours; comp.round_hours = o.roundHours;
  comp.postpone_days = o.postponeDays > 0 ? o.postponeDays : 1;
  comp.nom_ends_at = o.nomEndsAt && o.nomEndsAt > Date.now() ? o.nomEndsAt : null;
  writeDb(db);
}

/** Clear the automatic schedule (revert to manual control). */
export function clearSchedule(cid: number) {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return;
  comp.nom_ends_at = null; comp.group_ends_at = null; comp.ko_round_ends_at = null;
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
    for (const m of db.matchups) if (m.competition_id === cid && m.stage === "group") decide(m, counts);
    writeDb(db);
    return "已重算：小组赛全部对战按当前票数结算。";
  }
  if (comp.phase === "knockout") {
    const round = comp.ko_round as number;
    for (const m of db.matchups) if (m.competition_id === cid && m.stage === "knockout" && m.round_no === round) decide(m, counts);
    writeDb(db);
    return `已重算：第 ${round} 轮按当前票数结算。`;
  }
  if (comp.phase === "finished") {
    const last = (comp.ko_round as number) - 1;
    const ms = db.matchups.filter((m) => m.competition_id === cid && m.stage === "knockout" && m.round_no === last);
    for (const m of ms) decide(m, counts);
    const winners = ms.map((m) => m.winner_id!).filter((x) => x != null);
    comp.champion_id = winners[0] ?? null;
    writeDb(db);
    return "已重算：决赛按当前票数结算。";
  }
  throw new Error("当前阶段无需重算。");
}
