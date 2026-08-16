import { readDb } from "./db";
import { groupLabel } from "./i18n";
import { getActiveCompetition, projectSchedule, type SchedMatch } from "./engine";

/**
 * Builds the plain-text reminder that the 公众号 sends about the CURRENT round.
 *
 * Two delivery modes share this one generator:
 *  - Manual mass-send (群发, 1/day, no cert): one text for everyone → it can't carry a
 *    per-user link, so it ends with a call-to-action to reply「投票」and get one.
 *  - Pull-style passive reply (被动回复): we know the sender's openid, so pass `voteUrl`
 *    (a per-user tokenised link) and it's embedded directly.
 *
 * Content: ① current round (pairings) ② preview of upcoming rounds ③ vote link / CTA.
 * WeChat messages are plain text (no markdown), so this returns newline-joined text.
 */
function pad(n: number): string { return String(n).padStart(2, "0"); }
function fmt(ms: number | null | undefined): string {
  if (!ms) return "待定";
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const nm = (s: SchedMatch["a"]): string => (s ? (s.nameCn || s.name) : "?");
function koZh(label: string): string {
  return label === "bronze" ? "季军战"
    : label === "final" ? "决赛"
    : label === "semi" ? "半决赛"
    : label === "quarter" ? "1/4 决赛"
    : label.startsWith("top:") ? `${label.slice(4)} 强`
    : label;
}

export interface ReminderOpts {
  voteUrl?: string;   // per-user link (pull-style). Omit for mass-send → CTA instead.
  upcoming?: number;  // how many upcoming rounds to preview (default 3)
}

export function buildRoundReminder(opts: ReminderOpts = {}): { text: string; hasRound: boolean; phase: string } {
  const comp = getActiveCompetition();
  if (!comp) return { text: "当前没有进行中的比赛。", hasRound: false, phase: "none" };
  const db = readDb();
  const sc = projectSchedule(db, comp);
  const upN = Math.max(0, opts.upcoming ?? 3);
  const name = comp.short_name || comp.title || "SML";
  const L: string[] = [];
  let hasRound = false;

  if (comp.phase === "group") {
    const cur = sc.group.find((d) => d.current) || sc.group[0];
    if (cur) {
      hasRound = true;
      L.push(`【${name}】小组赛 第 ${cur.matchday}/${cur.matchdayCount} 比赛日`);
      if (cur.end) L.push(`投票截止:${fmt(cur.end)}`);
      if (sc.mode === "approval") {
        L.push("", "本轮开放投票的组(每人每组 2 票,取前二晋级):");
        for (const g of (cur.groups || [])) L.push(`· ${groupLabel(g.groupNo)} 组:${g.members.join("、")}`);
      } else {
        L.push("", "本轮对阵:");
        for (const m of cur.matches) L.push(`· ${nm(m.a)} vs ${nm(m.b)}`);
      }
      const up: string[] = [];
      for (const d of sc.group.filter((d) => d.matchday > cur.matchday)) up.push(`· 第 ${d.matchday} 比赛日(${fmt(d.start)} 起)`);
      for (const r of sc.knockout) up.push(`· ${koZh(r.label)}(${r.start ? fmt(r.start) : "待定"} 起)`);
      if (up.length && upN) { L.push("", "接下来:"); L.push(...up.slice(0, upN)); }
    }
  } else if (comp.phase === "knockout") {
    const nonPending = sc.knockout.filter((r) => !r.pending);
    const cur = nonPending.find((r) => r.matches.some((m) => !m.decided)) || nonPending[nonPending.length - 1];
    if (cur) {
      hasRound = true;
      L.push(`【${name}】淘汰赛 · ${koZh(cur.label)}`);
      if (cur.end) L.push(`投票截止:${fmt(cur.end)}`);
      L.push("", "本轮对阵:");
      for (const m of cur.matches) L.push(`· ${nm(m.a)} vs ${nm(m.b)}`);
      const later = sc.knockout.filter((r) => r.contestants < cur.contestants);
      if (later.length && upN) { L.push("", "接下来:"); L.push(...later.slice(0, upN).map((r) => `· ${koZh(r.label)}(${r.start ? fmt(r.start) : "待定"} 起)`)); }
    }
  } else if (comp.phase === "playoff") {
    hasRound = true;
    L.push(`【${name}】第三名加赛进行中`);
    L.push("并列者循环赛,争夺最后的晋级名额。");
  } else if (comp.phase === "nomination") {
    L.push(`【${name}】提名进行中`);
    if (comp.nom_ends_at) L.push(`提名截止:${fmt(comp.nom_ends_at)}`);
    L.push("快来把你喜欢的角色加入提名池!");
  } else if (comp.phase === "finished") {
    L.push(`【${name}】本届已结束,感谢参与!`);
  }

  L.push("");
  L.push(opts.voteUrl ? `👉 点此投票:${opts.voteUrl}` : "👉 在本公众号回复「投票」获取你的专属投票链接");
  return { text: L.join("\n"), hasRound, phase: comp.phase };
}
