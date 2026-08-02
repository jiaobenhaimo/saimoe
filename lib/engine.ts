import { sql } from "./db";
import { bangumiApiEnabled } from "./flags";

// ── row shapes ────────────────────────────────────────────────
export type Competition = {
  id: number;
  title: string;
  description: string | null;
  phase: "nomination" | "group" | "knockout" | "finished";
  target_size: number | null;
  groups_count: number | null;
  advance_per_group: number | null;
  champion_id: number | null;
  ko_round: number | null;
};

export type Candidate = {
  id: number;
  bgm_id: string;
  name: string;
  name_cn: string | null;
  image: string | null;
  group_no: number | null;
  seed: number | null;
  eliminated: boolean;
};

export type Matchup = {
  id: number;
  stage: "group" | "knockout";
  round_no: number;
  group_no: number | null;
  slot: number;
  a_id: number;
  b_id: number;
  winner_id: number | null;
  decided: boolean;
};

// ── read helpers ──────────────────────────────────────────────
export async function getActiveCompetition(): Promise<Competition | null> {
  const rows = (await sql`SELECT * FROM competition ORDER BY id DESC LIMIT 1`) as any[];
  return (rows[0] as Competition) ?? null;
}

async function candidates(cid: number): Promise<Candidate[]> {
  return (await sql`SELECT * FROM candidate WHERE competition_id=${cid} ORDER BY id`) as any[];
}

async function matchups(cid: number): Promise<Matchup[]> {
  return (await sql`SELECT * FROM matchup WHERE competition_id=${cid}
                    ORDER BY stage, round_no, group_no, slot`) as any[];
}

// ── full state for the UI, personalised to one voter ─────────
export async function getState(voterId: string) {
  const comp = await getActiveCompetition();
  const apiEnabled = bangumiApiEnabled();
  if (!comp) return { competition: null, apiEnabled };

  const slim = (c: Candidate | undefined) =>
    c ? { id: c.id, name: c.name, nameCn: c.name_cn, image: c.image } : null;

  const base = {
    apiEnabled,
    competition: {
      id: comp.id,
      title: comp.title,
      description: comp.description,
      phase: comp.phase,
      groupsCount: comp.groups_count,
      advancePerGroup: comp.advance_per_group,
      championId: comp.champion_id,
    },
  };

  // ── NOMINATION: only candidates + nomination tallies are needed ──
  if (comp.phase === "nomination") {
    const [cands, nomCounts, myNom] = await Promise.all([
      candidates(comp.id),
      sql`SELECT candidate_id, COUNT(*) AS n FROM nomination_vote
          WHERE competition_id=${comp.id} GROUP BY candidate_id` as Promise<any[]>,
      sql`SELECT candidate_id FROM nomination_vote
          WHERE competition_id=${comp.id} AND voter_id=${voterId}` as Promise<any[]>,
    ]);
    const nomCount = new Map<number, number>(nomCounts.map((r) => [r.candidate_id, r.n]));
    const myNomSet = new Set<number>(myNom.map((r) => r.candidate_id));
    const pool = cands
      .map((c) => ({ ...slim(c)!, votes: nomCount.get(c.id) ?? 0, voted: myNomSet.has(c.id) }))
      .sort((x, y) => y.votes - x.votes || x.name.localeCompare(y.name));
    return { ...base, nomination: { pool } };
  }

  // ── GROUP / KNOCKOUT / FINISHED: candidates + matchups + match-vote tallies ──
  const [cands, ms, mvCounts, myMv] = await Promise.all([
    candidates(comp.id),
    matchups(comp.id),
    sql`SELECT mv.matchup_id, mv.choice_id, COUNT(*) AS n
        FROM match_vote mv JOIN matchup m ON m.id=mv.matchup_id
        WHERE m.competition_id=${comp.id}
        GROUP BY mv.matchup_id, mv.choice_id` as Promise<any[]>,
    sql`SELECT mv.matchup_id, mv.choice_id FROM match_vote mv
        JOIN matchup m ON m.id=mv.matchup_id
        WHERE m.competition_id=${comp.id} AND mv.voter_id=${voterId}` as Promise<any[]>,
  ]);
  const cmap = new Map(cands.map((c) => [c.id, c]));
  const countOf = new Map<string, number>();
  for (const r of mvCounts) countOf.set(`${r.matchup_id}:${r.choice_id}`, r.n);
  const myChoice = new Map<number, number>(myMv.map((r) => [r.matchup_id, r.choice_id]));

  const votesA = (m: Matchup) => countOf.get(`${m.id}:${m.a_id}`) ?? 0;
  const votesB = (m: Matchup) => countOf.get(`${m.id}:${m.b_id}`) ?? 0;
  const liveWinner = (m: Matchup): number | null => {
    if (m.decided) return m.winner_id;
    const a = votesA(m), b = votesB(m);
    if (a === b) return null;
    return a > b ? m.a_id : m.b_id;
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

// ── admin transitions ─────────────────────────────────────────
function isPow2(n: number) {
  return n >= 2 && (n & (n - 1)) === 0;
}

/** Edit the competition's display info. Allowed in any phase. */
export async function updateCompetition(
  cid: number,
  title: string,
  description: string | null
) {
  const t = title.trim();
  if (!t) throw new Error("标题不能为空。");
  await sql`UPDATE competition SET title=${t}, description=${description?.trim() || null} WHERE id=${cid}`;
}

/** nomination → group: keep top `size` candidates, split into groups, build round-robin. */
export async function startGroups(
  cid: number,
  size: number,
  groupsCount: number,
  advancePerGroup: number
) {
  const qualifiers = groupsCount * advancePerGroup;
  if (!isPow2(qualifiers)) {
    throw new Error(
      `晋级总数 ${qualifiers}(小组数×每组晋级)必须是 2 的幂,淘汰赛才不会有轮空。当前不是。`
    );
  }
  if (size < groupsCount * 2) throw new Error("参赛人数太少,无法组成每组至少 2 人的小组。");

  const ranked = (await sql`
    SELECT c.id, COALESCE(COUNT(nv.voter_id),0) AS votes
    FROM candidate c
    LEFT JOIN nomination_vote nv ON nv.candidate_id=c.id
    WHERE c.competition_id=${cid}
    GROUP BY c.id ORDER BY votes DESC, c.id ASC LIMIT ${size}`) as any[];
  if (ranked.length < size) throw new Error(`提名池只有 ${ranked.length} 个角色,不足 ${size} 个。`);

  // Atomically claim the transition: only the request that flips nomination→group
  // proceeds. A concurrent/double-clicked call gets affectedRows=0 and bails out,
  // so we never double-build the groups.
  const cas = (await sql`UPDATE competition SET phase='group', target_size=${size},
    groups_count=${groupsCount}, advance_per_group=${advancePerGroup}
    WHERE id=${cid} AND phase='nomination'`) as any;
  if (!cas.affectedRows) return;

  // snake distribution keeps groups balanced by nomination strength
  for (let i = 0; i < ranked.length; i++) {
    const g = i % groupsCount;
    await sql`UPDATE candidate SET group_no=${g}, seed=${i}, eliminated=false WHERE id=${ranked[i].id}`;
  }
  // characters not selected are dropped from this competition run
  await sql`UPDATE candidate SET eliminated=true WHERE competition_id=${cid} AND group_no IS NULL`;

  // round-robin matchups within each group
  const chosen = ranked.map((r) => r.id);
  const groups: number[][] = Array.from({ length: groupsCount }, () => []);
  chosen.forEach((id, i) => groups[i % groupsCount].push(id));
  for (let g = 0; g < groupsCount; g++) {
    let slot = 0;
    const arr = groups[g];
    for (let i = 0; i < arr.length; i++)
      for (let j = i + 1; j < arr.length; j++) {
        await sql`INSERT INTO matchup (competition_id, stage, round_no, group_no, slot, a_id, b_id)
                  VALUES (${cid}, 'group', 1, ${g}, ${slot++}, ${arr[i]}, ${arr[j]})`;
      }
  }
}

/** group → knockout: lock group results, take top N per group, seed bracket. */
export async function startKnockout(cid: number) {
  const comp = (await sql`SELECT * FROM competition WHERE id=${cid}`) as any[];
  const c = comp[0];
  if (!c || c.phase !== "group") throw new Error("当前不在小组赛阶段。");
  const advance = c.advance_per_group as number;
  const groupsCount = c.groups_count as number;

  // Atomically claim the group→knockout transition; also init ko_round=1.
  const cas = (await sql`UPDATE competition SET phase='knockout', ko_round=1
    WHERE id=${cid} AND phase='group'`) as any;
  if (!cas.affectedRows) return;

  await lockStage(cid, "group");

  // standings per group (from decided winners + total votes)
  const qualifiersBySeed: number[] = []; // group winners first, then runners-up, ...
  const perGroupOrdered: number[][] = [];
  for (let g = 0; g < groupsCount; g++) {
    const ms = (await sql`SELECT * FROM matchup
      WHERE competition_id=${cid} AND stage='group' AND group_no=${g}`) as Matchup[];
    const members = (await sql`SELECT * FROM candidate
      WHERE competition_id=${cid} AND group_no=${g}`) as Candidate[];
    const stats = members.map((m) => {
      let wins = 0, vf = 0;
      for (const mm of ms) {
        const va = voteCache.get(`${mm.id}:${mm.a_id}`) ?? 0;
        const vb = voteCache.get(`${mm.id}:${mm.b_id}`) ?? 0;
        if (mm.a_id === m.id) vf += va;
        if (mm.b_id === m.id) vf += vb;
        if (mm.winner_id === m.id) wins++;
      }
      return { id: m.id, wins, vf };
    });
    stats.sort((x, y) => y.wins - x.wins || y.vf - x.vf);
    perGroupOrdered.push(stats.slice(0, advance).map((s) => s.id));
    // mark eliminated
    for (const s of stats.slice(advance)) await sql`UPDATE candidate SET eliminated=true WHERE id=${s.id}`;
  }
  // seed order: all 1st places, then all 2nd places, ...
  for (let rank = 0; rank < advance; rank++)
    for (let g = 0; g < groupsCount; g++)
      if (perGroupOrdered[g][rank] != null) qualifiersBySeed.push(perGroupOrdered[g][rank]);

  const n = qualifiersBySeed.length;
  if (!isPow2(n)) throw new Error(`晋级人数 ${n} 不是 2 的幂,无法生成干净的淘汰赛。`);

  // standard bracket placement so adjacent pairs are the round-1 matchups
  const order = bracketSeedOrder(n); // 1-indexed seeds
  const placed = order.map((seed) => qualifiersBySeed[seed - 1]);
  for (let i = 0; i < placed.length; i += 2) {
    await sql`INSERT INTO matchup (competition_id, stage, round_no, slot, a_id, b_id)
              VALUES (${cid}, 'knockout', 1, ${i / 2}, ${placed[i]}, ${placed[i + 1]})`;
    await sql`UPDATE candidate SET seed=${order[i]} WHERE id=${placed[i]}`;
    await sql`UPDATE candidate SET seed=${order[i + 1]} WHERE id=${placed[i + 1]}`;
  }
}

/** Resolve the current knockout round; build the next one, or finish. */
export async function advanceKnockout(cid: number) {
  const comp = (await sql`SELECT * FROM competition WHERE id=${cid}`) as any[];
  if (!comp[0] || comp[0].phase !== "knockout") throw new Error("当前不在淘汰赛阶段。");

  // Current round: prefer the ko_round counter; fall back to MAX(round_no).
  let round = comp[0].ko_round as number | null;
  if (round == null) {
    const maxRow = (await sql`SELECT MAX(round_no) AS r FROM matchup
                              WHERE competition_id=${cid} AND stage='knockout'`) as any[];
    round = (maxRow[0].r as number) || 1;
  }

  // Atomically claim advancing THIS round. A concurrent/double call sees
  // affectedRows=0 and bails, so we never resolve a round or build the next twice.
  const cas = (await sql`UPDATE competition SET ko_round=${round + 1}
    WHERE id=${cid} AND phase='knockout' AND ko_round=${round}`) as any;
  if (!cas.affectedRows) return;

  await lockRound(cid, round);

  const cur = (await sql`SELECT * FROM matchup
    WHERE competition_id=${cid} AND stage='knockout' AND round_no=${round}
    ORDER BY slot`) as Matchup[];
  const winners = cur.map((m) => m.winner_id!).filter((x) => x != null);

  // mark round losers eliminated
  for (const m of cur) {
    const loser = m.winner_id === m.a_id ? m.b_id : m.a_id;
    await sql`UPDATE candidate SET eliminated=true WHERE id=${loser}`;
  }

  if (winners.length <= 1) {
    await sql`UPDATE competition SET phase='finished', champion_id=${winners[0] ?? null} WHERE id=${cid}`;
    return;
  }
  const next = round + 1;
  for (let i = 0; i < winners.length; i += 2) {
    await sql`INSERT INTO matchup (competition_id, stage, round_no, slot, a_id, b_id)
              VALUES (${cid}, 'knockout', ${next}, ${i / 2}, ${winners[i]}, ${winners[i + 1]})`;
  }
}

// vote cache shared between lock + seeding within one request
const voteCache = new Map<string, number>();

async function loadVoteCounts(cid: number) {
  voteCache.clear();
  const rows = (await sql`
    SELECT mv.matchup_id, mv.choice_id, COUNT(*) AS n
    FROM match_vote mv JOIN matchup m ON m.id=mv.matchup_id
    WHERE m.competition_id=${cid} GROUP BY mv.matchup_id, mv.choice_id`) as any[];
  for (const r of rows) voteCache.set(`${r.matchup_id}:${r.choice_id}`, r.n);
}

async function lockStage(cid: number, stage: "group" | "knockout") {
  await loadVoteCounts(cid);
  const ms = (await sql`SELECT * FROM matchup
    WHERE competition_id=${cid} AND stage=${stage}`) as Matchup[];
  for (const m of ms) await decide(m);
}

async function lockRound(cid: number, round: number) {
  await loadVoteCounts(cid);
  const ms = (await sql`SELECT * FROM matchup
    WHERE competition_id=${cid} AND stage='knockout' AND round_no=${round}`) as Matchup[];
  for (const m of ms) await decide(m);
}

async function decide(m: Matchup) {
  const a = voteCache.get(`${m.id}:${m.a_id}`) ?? 0;
  const b = voteCache.get(`${m.id}:${m.b_id}`) ?? 0;
  // tie / zero-vote matchups resolve deterministically to the A side
  const winner = a === b ? m.a_id : a > b ? m.a_id : m.b_id;
  await sql`UPDATE matchup SET winner_id=${winner}, decided=true WHERE id=${m.id}`;
}

/** Standard single-elimination seed placement (1-indexed), length n (power of two). */
function bracketSeedOrder(n: number): number[] {
  let rounds = [1, 2];
  while (rounds.length < n) {
    const m = rounds.length * 2 + 1;
    const next: number[] = [];
    for (const r of rounds) {
      next.push(r);
      next.push(m - r);
    }
    rounds = next;
  }
  return rounds;
}
