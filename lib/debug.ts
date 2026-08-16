// Debug helpers — gated behind ADMIN_TOKEN + DEBUG_MODE=true (see route).
// Purpose: exercise the whole tournament flow in seconds without Bangumi or waiting.
import { readDb, writeDb, createCompetition, addCandidate } from "./db";
import { getActiveCompetition, startGroups, startKnockout, advanceKnockout, advanceGroupMatchday, resolvePlayoff } from "./engine";

/** Create a fresh competition + N fake candidates (no Bangumi needed). */
export function debugSeed(count = 16, title = "调试赛 · Debug"): { id: number; added: number } {
  const id = createCompetition(title);
  let added = 0;
  for (let i = 0; i < Math.max(2, count); i++) {
    const n = String(i + 1).padStart(2, "0");
    if (addCandidate(id, `dbg-${id}-${i}`, `测试角色 ${n}`, `测试角色 ${n}`, "")) added++;
  }
  return { id, added };
}

/** Add fake nomination votes (skewed so ranking/seeding is non-uniform). */
export function debugNominate(votes = 200): { added: number } {
  const db = readDb();
  const comp = getActiveCompetition();
  if (!comp || comp.phase !== "nomination") throw new Error("需在提名阶段。");
  const cands = db.candidates.filter((c) => c.competition_id === comp.id);
  if (!cands.length) throw new Error("没有候选角色。");
  let added = 0;
  for (let i = 0; i < votes; i++) {
    const idx = Math.min(cands.length - 1, Math.floor(Math.pow(Math.random(), 1.7) * cands.length));
    const cand = cands[idx];
    const voter = `dbgn-${i}`;
    if (!db.nominationVotes.some((v) => v.competition_id === comp.id && v.candidate_id === cand.id && v.voter_id === voter)) {
      db.nominationVotes.push({ competition_id: comp.id, candidate_id: cand.id, voter_id: voter, created_at: Date.now(), device_bucket: `dbg-bkt-${i % 5}`, ip: `10.0.1.${i % 8}` });
      added++;
    }
  }
  writeDb(db);
  return { added };
}

/** Cast fake votes for every currently-open match (current group matchday, or current KO round). */
export function debugVote(voters = 40): { matches: number; votes: number } {
  const db = readDb();
  const comp = getActiveCompetition();
  if (!comp) throw new Error("没有比赛。");
  let open = [] as typeof db.matchups;
  if (comp.phase === "group") {
    // approval mode has no matchups — cast fake group ballots (≤2 per voter per open group)
    if ((comp.group_mode ?? "approval") === "approval") {
      const perDay = comp.groups_per_day && comp.groups_per_day > 0 ? comp.groups_per_day : 2;
      const cur = comp.group_matchday ?? 1;
      const openGroups = [...new Set(db.candidates.filter((c) => c.competition_id === comp.id && c.group_no != null).map((c) => c.group_no!))]
        .filter((g) => Math.floor(g / Math.max(1, perDay)) + 1 === cur);
      let av = 0;
      for (let v = 0; v < voters; v++) {
        const voter = `dbgv-${v}`;
        for (const g of openGroups) {
          const members = db.candidates.filter((c) => c.competition_id === comp.id && c.group_no === g);
          if (!members.length) continue;
          const picks = [...members].sort(() => Math.random() - 0.5).slice(0, 2); // up to 2 random picks
          for (const p of picks) {
            const exists = db.approvalVotes.find((x) => x.competition_id === comp.id && x.group_no === g && x.voter_id === voter && x.candidate_id === p.id);
            if (!exists) { db.approvalVotes.push({ competition_id: comp.id, group_no: g, candidate_id: p.id, voter_id: voter, created_at: Date.now(), device_bucket: `dbg-bkt-${v % 5}`, ip: `10.0.0.${v % 8}` }); av++; }
          }
        }
      }
      writeDb(db);
      return { matches: openGroups.length, votes: av };
    }
    const cur = comp.group_matchday ?? 1;
    open = db.matchups.filter((m) => m.competition_id === comp.id && m.stage === "group" && (m.matchday ?? 1) === cur && !m.decided);
  } else if (comp.phase === "knockout") {
    const r = comp.ko_round ?? 1;
    open = db.matchups.filter((m) => m.competition_id === comp.id && m.stage === "knockout" && m.round_no === r && !m.decided);
  } else if (comp.phase === "playoff") {
    open = db.matchups.filter((m) => m.competition_id === comp.id && m.stage === "playoff" && !m.decided);
  } else {
    throw new Error("当前阶段没有开放的对战(需小组赛/加赛/淘汰赛)。");
  }
  let votes = 0;
  for (let v = 0; v < voters; v++) {
    const voter = `dbgv-${v}`;
    for (const m of open) {
      const pick = Math.random() < 0.5 ? m.a_id : m.b_id;
      const cur = db.matchVotes.find((x) => x.matchup_id === m.id && x.voter_id === voter);
      if (cur) cur.choice_id = pick;
      else { db.matchVotes.push({ matchup_id: m.id, voter_id: voter, choice_id: pick, created_at: Date.now(), device_bucket: `dbg-bkt-${v % 5}`, ip: `10.0.0.${v % 8}` }); votes++; }
    }
  }
  writeDb(db);
  return { matches: open.length, votes };
}

/** One click: seed → nominate → group (all matchdays) → knockout → champion. */
export function debugSimulate(o: { count?: number; groups?: number; advance?: number; perRound?: number; voters?: number; mode?: "approval" | "rr"; groupSize?: number; groupsPerDay?: number } = {}): { log: string[] } {
  const count = o.count ?? 8;
  const perRound = o.perRound ?? 0, voters = o.voters ?? 30;
  const mode: "approval" | "rr" = o.mode === "rr" ? "rr" : "approval";
  const groupSize = o.groupSize && o.groupSize > 0 ? o.groupSize : 4;
  const groupsPerDay = o.groupsPerDay && o.groupsPerDay > 0 ? o.groupsPerDay : 2;
  const unit = mode === "approval" ? "组" : "场";
  const log: string[] = [];

  const seeded = debugSeed(count, "模拟赛 · Simulate");
  log.push(`创建模拟赛(#${seeded.id}),角色 ${seeded.added} 个`);
  debugNominate(count * 20);
  log.push(`灌入提名票(约 ${count * 20} 张)`);

  startGroups(seeded.id, count, perRound, 0, groupSize, mode, groupsPerDay);
  const gc = getActiveCompetition();
  log.push(`开小组赛(${mode === "approval" ? "投票晋级" : "循环赛"};${gc?.groups_count ?? "?"} 个 ${groupSize} 人组${mode === "approval" ? `,每天 ${groupsPerDay} 组` : ""})`);

  let guard = 0;
  while (guard++ < 60) {
    const c = getActiveCompetition();
    if (!c || c.phase !== "group") break;
    const vr = debugVote(voters);
    const r = advanceGroupMatchday(seeded.id);
    log.push(`比赛日投票(${vr.matches} ${unit})→ ${r.message}`);
    if (r.done) { startKnockout(seeded.id); log.push("小组赛结束 → 生成淘汰赛"); break; }
  }

  {
    const cp = getActiveCompetition();
    if (cp && cp.phase === "playoff") { const vr = debugVote(voters); resolvePlayoff(seeded.id); log.push(`加赛投票(${vr.matches} 场)→ 结算 → 生成淘汰赛`); }
  }

  guard = 0;
  while (guard++ < 20) {
    const c = getActiveCompetition();
    if (!c || c.phase !== "knockout") break;
    const vr = debugVote(voters);
    advanceKnockout(seeded.id);
    log.push(`淘汰赛投票(${vr.matches} 场)→ 推进一轮`);
  }

  const c = getActiveCompetition();
  log.push(c?.phase === "finished" ? "✅ 已决出冠军" : `结束于阶段:${c?.phase}`);
  return { log };
}
