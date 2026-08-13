"use client";
import { useEffect, useState } from "react";
import { t, roundLabelT, LANGS, type Lang } from "@/lib/i18n";

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
  const set = (l: Lang) => { setLang(l); try { localStorage.setItem("saimoe_lang", l); } catch {} };
  return [lang, set];
}

type Side = { id: number; name: string; nameCn: string | null } | null;
type SMatch = { a: Side; b: Side; decided: boolean; winnerId: number | null };

export default function Rules() {
  const [lang, setLang] = useLang();
  const [comp, setComp] = useState<any>(null);
  const [sched, setSched] = useState<any>(null);
  useEffect(() => {
    fetch("/api/state", { cache: "no-store" }).then((r) => r.json()).then((d) => { setComp(d?.competition ?? null); setSched(d?.schedule ?? null); }).catch(() => {});
  }, []);
  const T = (k: string, p?: Record<string, string | number>) => t(lang, k, p);
  const name = comp?.shortName || T("title");

  const loc = lang === "zh" ? "zh-CN" : lang === "ja" ? "ja-JP" : "en-US";
  const f = (ms: number) => { try { return new Date(ms).toLocaleString(loc, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
  const fmtRange = (s: number | null, e: number | null): string =>
    s && e ? `${f(s)} → ${f(e)}` : e ? `→ ${f(e)}` : s ? `${f(s)} →` : T("sched.tbd");
  const side = (s: Side): string => (s ? (lang === "zh" ? (s.nameCn || s.name) : s.name) : "?");
  const winner = (m: SMatch): Side => (m.winnerId == null ? null : m.a?.id === m.winnerId ? m.a : m.b?.id === m.winnerId ? m.b : null);

  const known = !!sched?.known;

  return (
    <main className="wrap">
      <div className="langbar">{LANGS.map((L) => <button key={L.code} type="button" className={"lang" + (lang === L.code ? " on" : "")} onClick={() => setLang(L.code)}>{L.label}</button>)}</div>
      <h1 className="title" style={{ fontSize: 30 }}>{T("rules.title")}</h1>
      <p className="subtitle">{T("rules.subtitle", { name })}</p>

      {/* live schedule preview — synced with what the admin has configured */}
      <div className="card">
        <h3>{T("sched.h")}</h3>
        {sched?.planned ? (
          <>
            <p className="rules-p"><b>{T("sched.bracketG", { n: sched.targetSize ?? "?", g: sched.groups ?? "?", s: sched.groupSize ?? "?", k: sched.koTarget ?? "?" })}</b></p>
            <ul className="sched-list">
              <li><div className="sched-when">{T("sched.cadNom")}<span className="sched-time">{sched.plan?.nomEndsAt ? f(sched.plan.nomEndsAt) : T("sched.cadTbd")}</span></div></li>
              <li><div className="sched-when">{T("sched.cadGroup")}<span className="sched-time">{sched.plan?.groupRoundDays ? T("sched.cadGroupVal", { d: sched.plan.groupRoundDays, c: sched.plan.dayCap || 4 }) : T("sched.cadManual")}</span></div></li>
              <li><div className="sched-when">{T("sched.cadKo")}<span className="sched-time">{sched.plan?.roundHours ? T("sched.cadKoVal", { h: sched.plan.roundHours }) : T("sched.cadManual")}</span></div></li>
            </ul>
            <p className="rules-p" style={{ color: "var(--muted)" }}>{T("sched.plannedNote")}</p>
          </>
        ) : !known ? (
          <p className="rules-p" style={{ color: "var(--muted)" }}>{T("sched.pending")}</p>
        ) : (
          <>
            <p className="rules-p">
              <b>{T("sched.bracket", { n: sched.targetSize ?? "?", g: sched.groups ?? "?", k: sched.koTarget ?? "?" })}</b><br />
              {T("sched.advanceRule")}
            </p>

            {sched.group?.length > 0 && (
              <>
                <h4 className="sched-h">{T("sched.group.h")}</h4>
                <ul className="sched-list">
                  {sched.group.map((d: any) => (
                    <li key={"g" + d.matchday} className={d.current ? "cur" : ""}>
                      <div className="sched-when">{T("sched.md", { d: d.matchday, n: d.matchdayCount })}{d.current ? ` · ${T("sched.now")}` : ""}<span className="sched-time">{fmtRange(d.start, d.end)}</span></div>
                      <div className="sched-pairs">
                        {sched.mode === "approval"
                          ? (d.groups || []).map((g: any, i: number) => (
                            <span key={i} className="pair">{T("group.letter", { L: String.fromCharCode(65 + g.groupNo) })}: {g.members.join("、")}</span>
                          ))
                          : d.matches.map((m: SMatch, i: number) => (
                            <span key={i} className={"pair" + (m.decided ? " done" : "")}>
                              {side(m.a)} <i>{T("sched.vs")}</i> {side(m.b)}
                              {m.decided && winner(m) ? <b> · {side(winner(m))} {T("sched.won")}</b> : null}
                            </span>
                          ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {sched.knockout?.length > 0 && (
              <>
                <h4 className="sched-h">{T("sched.ko.h")}</h4>
                <ul className="sched-list">
                  {sched.knockout.map((r: any, i: number) => (
                    <li key={"k" + i}>
                      <div className="sched-when">{roundLabelT(lang, r.label)}<span className="sched-time">{fmtRange(r.start, r.end)}</span></div>
                      <div className="sched-pairs">
                        {r.pending ? (
                          <span className="tbd">{T("sched.pairTbd")}</span>
                        ) : (
                          r.matches.map((m: SMatch, j: number) => (
                            <span key={j} className={"pair" + (m.decided ? " done" : "")}>
                              {side(m.a)} <i>{T("sched.vs")}</i> {side(m.b)}
                              {m.decided && winner(m) ? <b> · {side(winner(m))} {T("sched.won")}</b> : null}
                            </span>
                          ))
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h3>{T("rules.s1.h")}</h3>
        <p className="rules-p">{T("rules.s1.p1")}</p>
        <p className="rules-p">{T("rules.s1.p2")}</p>
        <p className="rules-p">{T("rules.s1.p3")}</p>
      </div>

      <div className="card">
        <h3>{T("rules.s2.h")}</h3>
        <p className="rules-p">{T("rules.s2.p1")}</p>
        <p className="rules-p">{T("rules.s2.p2")}</p>
      </div>

      <div className="card">
        <h3>{T("rules.s3.h")}</h3>
        <p className="rules-p">{T("rules.s3.p1")}</p>
      </div>

      <div className="card">
        <h3>{T("rules.s4.h")}</h3>
        <p className="rules-p">{T("rules.s4.p1")}</p>
        <p className="rules-p">{T("rules.s4.p3")}</p>
        <p className="rules-p">{T("rules.s4.p2")}</p>
      </div>

      <div className="card">
        <h3>{T("rules.s5.h")}</h3>
        <p className="rules-p">{T("rules.s5.p1")}</p>
        <p className="rules-p">{T("rules.s5.p2")}</p>
        <p className="rules-p">{T("rules.s5.p3")}</p>
      </div>

      <div className="foot"><a href="/">{T("rules.back")}</a></div>
    </main>
  );
}
