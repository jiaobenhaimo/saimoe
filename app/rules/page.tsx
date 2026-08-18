"use client";
import { useEffect, useState } from "react";
import { t, roundLabelT, LANGS, groupLabel, type Lang } from "@/lib/i18n";

function useLang(): [Lang, (l: Lang) => void] {
  const [lang, setLang] = useState<Lang>("zh");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("saimoe_lang") as Lang | null;
      if (saved === "zh" || saved === "en" || saved === "ja") { setLang(saved); return; }
      const n = (navigator.language || "").toLowerCase();
      setLang(n.startsWith("ja") ? "ja" : n.startsWith("zh") ? "zh" : "en");
    } catch {}
  }, []);
  // 让 <html lang> 跟着界面语言走。这不只是无障碍问题：中日共用汉字的字形不同
  // （直/骨/今/令/雪…），浏览器要靠 lang 才能挑对字形，读屏也要靠它选对语音。
  useEffect(() => {
    try { document.documentElement.lang = lang === "zh" ? "zh-CN" : lang === "ja" ? "ja" : "en"; } catch {}
  }, [lang]);
  const set = (l: Lang) => { setLang(l); try { localStorage.setItem("saimoe_lang", l); } catch {} };
  return [lang, set];
}

type Side = { id: number; name: string; nameCn: string | null } | null;
type SMatch = { a: Side; b: Side; decided: boolean; winnerId: number | null };

// The three sponsor / community QR codes. Drop the images into /public and set src to show
// them; until then each renders a labelled placeholder. (kind is just for the caption key.)
export default function Rules() {
  const [lang, setLang] = useLang();
  const [comp, setComp] = useState<any>(null);
  const [sched, setSched] = useState<any>(null);
  // 联系方式 / 主办 / 鸣谢 / 二维码：来自服务器上未跟踪的 site.json（不进仓库）
  type SText = { zh?: string; en?: string; ja?: string };
  const [site, setSite] = useState<{ contact?: SText; host?: SText; thanks?: SText; qr?: { file: string; caption: SText }[] } | null>(null);
  const [qrBroke, setQrBroke] = useState<Set<string>>(new Set()); // 图片还没传到服务器时退回占位
  useEffect(() => {
    fetch("/api/state", { cache: "no-store" }).then((r) => r.json()).then((d) => { setComp(d?.competition ?? null); setSched(d?.schedule ?? null); setSite(d?.site ?? null); }).catch(() => {});
  }, []);
  const T = (k: string, p?: Record<string, string | number>) => t(lang, k, p);
  const name = (lang === "en" ? (comp?.shortEn || comp?.shortName) : lang === "ja" ? (comp?.shortJa || comp?.shortName) : comp?.shortName) || T("title");

  const loc = lang === "zh" ? "zh-CN" : lang === "ja" ? "ja-JP" : "en-US";
  const f = (ms: number) => { try { return new Date(ms).toLocaleString(loc, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
  const ft = (ms: number) => { try { return new Date(ms).toLocaleString(loc, { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
  /** 同一天就省掉第二个日期：`08/21 01:00-23:00`；跨天才写全两个日期。 */
  const fmtRange = (s: number | null, e: number | null): string => {
    if (s && e) {
      const a = new Date(s), b = new Date(e);
      const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
      return sameDay ? `${f(s)}-${ft(e)}` : `${f(s)} → ${f(e)}`;
    }
    return e ? `→ ${f(e)}` : s ? `${f(s)} →` : T("sched.tbd");
  };
  const side = (s: Side): string => (s ? (lang === "zh" ? (s.nameCn || s.name) : s.name) : "?");
  const known = !!sched?.known;
  /** 站点信息按当前语言取值，缺失时 日语 → 中文 → 英语 回退。 */
  const sT = (t?: SText): string => {
    const want = lang === "zh" ? t?.zh : lang === "en" ? t?.en : t?.ja;
    return (want || t?.ja || t?.zh || t?.en || "").trim();
  };
  const [hideDone, setHideDone] = useState(true);

  // Flatten the schedule into ordered timeline nodes: nomination close → each group matchday → each knockout round.
  type TLSeg = { t: string; b: boolean };
  type TLDetail = { segs: TLSeg[]; done: boolean };
  type TLNode = { label: string; start: number | null; end: number | null; state: "done" | "current" | "upcoming"; pending?: boolean; detail: TLDetail[] };
  const now = Date.now();
  const nodes: TLNode[] = [];
  if (sched && (known || sched.planned)) {
    const phase = sched.phase;
    const nomEnd = sched.plan?.nomEndsAt ?? null;
    if (nomEnd) nodes.push({ label: T("sched.nomEnd"), start: null, end: nomEnd, state: phase === "nomination" ? "current" : "done", detail: [] });
    for (const d of (sched.group || [])) {
      const detail: TLDetail[] = sched.mode === "approval"
        ? (d.groups || []).map((g: any) => {
            const adv = new Set<string>(g.advancers || []);
            const segs: TLSeg[] = [{ t: `${T("group.letter", { L: groupLabel(g.groupNo) })}: `, b: false }];
            if (!(g.members || []).length) segs.push({ t: T("sched.tbdMembers"), b: false }); // 提名阶段：抽签未进行
            (g.members || []).forEach((nm: string, k: number) => { if (k) segs.push({ t: "、", b: false }); segs.push({ t: nm, b: adv.has(nm) }); });
            return { segs, done: adv.size > 0 };
          })
        : (d.matches || []).map((m: SMatch) => {
            const wa = m.decided && m.winnerId != null && m.a?.id === m.winnerId;
            const wb = m.decided && m.winnerId != null && m.b?.id === m.winnerId;
            return { segs: [{ t: side(m.a), b: wa }, { t: ` ${T("sched.vs")} `, b: false }, { t: side(m.b), b: wb }], done: m.decided };
          });
      const state: TLNode["state"] = d.current ? "current" : d.end && d.end < now ? "done" : phase === "group" && d.matchday < (sched.groupMatchday ?? 0) ? "done" : "upcoming";
      const gList = sched.mode === "approval"
        ? (d.groups || []).map((g: any) => groupLabel(g.groupNo))
        : [...new Set((d.matches || []).map((m: any) => m.groupNo).filter((g: any) => g != null))].sort((a: any, b: any) => a - b).map((g: any) => groupLabel(g));
      const mdLabel = gList.length
        ? T("sched.mdGroups", { d: d.matchday, n: d.matchdayCount, g: gList.join("、") })
        : T("sched.md", { d: d.matchday, n: d.matchdayCount });
      nodes.push({ label: mdLabel, start: d.start, end: d.end, state, detail });
    }
    for (const r of (sched.knockout || [])) {
      const detail: TLDetail[] = (r.matches || []).map((m: SMatch) => {
        const wa = m.decided && m.winnerId != null && m.a?.id === m.winnerId;
        const wb = m.decided && m.winnerId != null && m.b?.id === m.winnerId;
        return { segs: [{ t: side(m.a), b: wa }, { t: ` ${T("sched.vs")} `, b: false }, { t: side(m.b), b: wb }], done: m.decided };
      });
      const allDone = r.matches?.length > 0 && r.matches.every((m: SMatch) => m.decided);
      const anyLive = r.matches?.some((m: SMatch) => !m.decided) && !r.pending && (r.start ? r.start <= now : false);
      const state: TLNode["state"] = r.pending ? "upcoming" : allDone ? "done" : anyLive ? "current" : (r.end && r.end < now ? "done" : "upcoming");
      nodes.push({ label: roundLabelT(lang, r.label), start: r.start, end: r.end, state, pending: r.pending, detail });
    }
    if (!nodes.some((n) => n.state === "current")) { const i = nodes.findIndex((n) => n.state === "upcoming"); if (i >= 0) nodes[i].state = "current"; }
  }

  return (
    <main className="wrap rules">
      <div className="langbar">{LANGS.map((L) => <button key={L.code} type="button" className={"lang" + (lang === L.code ? " on" : "")} onClick={() => setLang(L.code)}>{L.label}</button>)}</div>

      <header className="rules-hero">
        <h1 className="rules-title">{T("rules.title")}</h1>
        <p className="rules-lede">{T("rules.subtitle", { name })}</p>
      </header>

      {/* ── schedule preview: vertical timeline, finished nodes hideable (item 1) ── */}
      <section className="rules-sec">
        <div className="tl-head">
          <h2 className="rules-h" style={{ margin: 0 }}>{T("sched.h")}</h2>
          {known && nodes.some((n) => n.state === "done") && (
            <button type="button" className="tl-toggle" aria-pressed={hideDone} onClick={() => setHideDone((v) => !v)}>
              {hideDone ? T("sched.showDone") : T("sched.hideDone")}
            </button>
          )}
        </div>

        {sched?.planned ? (
          <>
            <p className="rules-p"><b>{T("sched.bracketG", { n: sched.targetSize ?? "?", g: sched.groups ?? "?", s: sched.groupSize ?? "?", k: sched.koTarget ?? "?" })}</b></p>
            {nodes.length > 0 ? (
              <>
                <ol className={"tl" + (hideDone ? " hide-done" : "")}>
                  {nodes.map((n, i) => (
                    <li key={i} className={"tl-node " + n.state + (i === nodes.length - 1 ? " last" : "")}>
                      <span className="tl-dot" />
                      <div className="tl-card">
                        <div className="tl-when">
                          <span className="tl-label">{n.label}</span>
                          <span className={"tl-tag " + n.state}>{n.state === "current" ? T("sched.now") : n.state === "done" ? T("sched.doneTag") : T("sched.upcomingTag")}</span>
                          <span className="tl-time">{fmtRange(n.start, n.end)}</span>
                        </div>
                        {n.detail.length > 0 && <div className="tl-body">{n.detail.map((d, j) => <span key={j} className={"pair" + (d.done ? " done" : "")}>{d.segs.map((s, k) => s.b ? <b key={k}>{s.t}</b> : <span key={k}>{s.t}</span>)}</span>)}</div>}
                      </div>
                    </li>
                  ))}
                </ol>
                <p className="rules-note">{T("sched.plannedNote")}</p>
              </>
            ) : (
              <>
                <ol className="tl">
                  <li className="tl-node upcoming"><span className="tl-dot" /><div className="tl-card"><div className="tl-when"><span className="tl-label">{T("sched.nomEnd")}</span><span className="tl-time">{sched.plan?.nomEndsAt ? f(sched.plan.nomEndsAt) : T("sched.cadTbd")}</span></div></div></li>
                  <li className="tl-node upcoming"><span className="tl-dot" /><div className="tl-card"><div className="tl-when"><span className="tl-label">{T("sched.cadGroup")}</span><span className="tl-time">{sched.plan?.groupRoundDays ? T("sched.cadGroupVal", { d: sched.plan.groupRoundDays, c: sched.plan.dayCap === 0 ? "∞" : (sched.plan.dayCap || 4) }) : T("sched.cadManual")}</span></div></div></li>
                  <li className="tl-node upcoming last"><span className="tl-dot" /><div className="tl-card"><div className="tl-when"><span className="tl-label">{T("sched.cadKo")}</span><span className="tl-time">{sched.plan?.roundHours ? T("sched.cadKoVal", { h: sched.plan.roundHours }) : T("sched.cadManual")}</span></div></div></li>
                </ol>
                <p className="rules-note">{T("sched.plannedNote")}</p>
              </>
            )}
          </>
        ) : !known ? (
          <p className="rules-note">{T("sched.pending")}</p>
        ) : (
          <>
            <p className="rules-p"><b>{T("sched.bracket", { n: sched.targetSize ?? "?", g: sched.groups ?? "?", k: sched.koTarget ?? "?" })}</b><br />{T((sched.groups && sched.koTarget && sched.koTarget <= 2 * sched.groups) ? "sched.advanceRule2" : "sched.advanceRule")}</p>
            <ol className={"tl" + (hideDone ? " hide-done" : "")}>
              {nodes.map((n, i) => (
                <li key={i} className={"tl-node " + n.state + (i === nodes.length - 1 ? " last" : "")}>
                  <span className="tl-dot" />
                  <div className="tl-card">
                    <div className="tl-when">
                      <span className="tl-label">{n.label}</span>
                      <span className={"tl-tag " + n.state}>{n.state === "current" ? T("sched.now") : n.state === "done" ? T("sched.doneTag") : T("sched.upcomingTag")}</span>
                      <span className="tl-time">{fmtRange(n.start, n.end)}</span>
                    </div>
                    {n.pending ? <div className="tl-body"><span className="tbd">{T("sched.pairTbd")}</span></div>
                      : n.detail.length > 0 ? <div className="tl-body">{n.detail.map((d, j) => <span key={j} className={"pair" + (d.done ? " done" : "")}>{d.segs.map((s, k) => s.b ? <b key={k}>{s.t}</b> : <span key={k}>{s.t}</span>)}</span>)}</div>
                      : null}
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      {/* ── the written rules ── */}
      <section className="rules-sec">
        <h2 className="rules-h"><span className="rules-no">1</span>{T("rules.s1.h").replace(/^[①-⑳]\s*/, "")}</h2>
        <p className="rules-p">{T("rules.s1.p1")}</p>
        <p className="rules-p">{T("rules.s1.p2")}</p>
        <p className="rules-note">{T("rules.s1.p3")}</p>
      </section>

      <section className="rules-sec">
        <h2 className="rules-h"><span className="rules-no">2</span>{T("rules.s2.h").replace(/^[①-⑳]\s*/, "")}</h2>
        <p className="rules-p">{T("rules.s2.p1")}</p>
        <p className="rules-p">{T("rules.s2.p2")}</p>
      </section>

      <section className="rules-sec">
        <h2 className="rules-h"><span className="rules-no">3</span>{T("rules.s3.h").replace(/^[①-⑳]\s*/, "")}</h2>
        <p className="rules-p">{T("rules.s3.p1")}</p>
      </section>

      <section className="rules-sec">
        <h2 className="rules-h">{T("rules.s4.h")}</h2>
        <p className="rules-p">{T("rules.s4.p1")}</p>
        <p className="rules-p">{T("rules.s4.p4")}</p>
        <p className="rules-p">{T("rules.s4.p3")}</p>
        <p className="rules-p">{T("rules.s4.p2")}</p>
      </section>

      <section className="rules-sec">
        <h2 className="rules-h">{T("rules.s5.h")}</h2>
        <ul className="rules-ul">
          <li>{T("rules.s5.p1")}</li>
          <li>{T("rules.s5.jp")}</li>
          <li>{T("rules.s5.p2")}</li>
          <li>{T("rules.s5.p3")}</li>
        </ul>
        {sT(site?.contact) && (
          <p className="rules-contact">{T("rules.contact.h")}{"\n"}{sT(site?.contact)}</p>
        )}
      </section>

      {/* ── 主办与鸣谢：内容来自服务器上的 site.json，仓库里没有；未配置则整节隐藏 ── */}
      {(sT(site?.host) || sT(site?.thanks) || (site?.qr?.length ?? 0) > 0) && (
        <section className="rules-sec rules-ack">
          <h2 className="rules-h">{T("rules.ack.h")}</h2>
          {sT(site?.host) && <p className="rules-p">{sT(site?.host)}</p>}
          {sT(site?.thanks) && <p className="rules-p">{sT(site?.thanks)}</p>}
          {(site?.qr?.length ?? 0) > 0 && (
            <div className="qr-grid">
              {site!.qr!.map((q, i) => (
                <figure className="qr" key={i}>
                  {q.file && !qrBroke.has(q.file)
                    ? <img src={`/api/site/${encodeURIComponent(q.file)}`} alt={sT(q.caption)} loading="lazy"
                        onError={() => setQrBroke((s2) => new Set(s2).add(q.file))} />
                    : <div className="qr-ph">{T("rules.ack.qr.pending")}</div>}
                  <figcaption>{sT(q.caption)}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="foot"><a href="/">{T("rules.back")}</a>
        <div className="foot-oss">
          {T("foot.oss", { repo: "%%REPO%%" }).split("%%REPO%%").map((seg, i) => (
            <span key={i}>{i > 0 && <a href="https://github.com/jiaobenhaimo/saimoe" target="_blank" rel="noopener noreferrer">jiaobenhaimo/saimoe</a>}{seg}</span>
          ))}
        </div>
      </div>
    </main>
  );
}
