"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { t, roundLabelT, LANGS, type Lang } from "@/lib/i18n";

type Slim = { id: number; name: string; nameCn: string | null; image: string | null };
type PoolItem = Slim & { votes: number; voted: boolean };
type Match = {
  id: number; stage: string; round: number; group: number | null; slot: number;
  a: Slim | null; b: Slim | null;
  votesA: number | null; votesB: number | null; total: number | null; rateA: number | null;
  winnerId: number | null; decided: boolean; myChoice: number | null; commentN: number;
  live?: boolean; matchday?: number;
};

// ── device fingerprint (sent as x-fp; dedups by device, not by public IP) ──
let FP = "";
async function sha256Hex(s: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // non-secure context fallback: two rolling 32-bit hashes → 16 hex chars
    let a = 2166136261, b = 5381;
    for (let i = 0; i < s.length; i++) { a = (a ^ s.charCodeAt(i)) * 16777619 >>> 0; b = ((b << 5) + b + s.charCodeAt(i)) >>> 0; }
    return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
  }
}
async function computeFp(): Promise<string> {
  try { const c = localStorage.getItem("saimoe_fp"); if (c) return c; } catch {}
  const parts = [
    navigator.userAgent, navigator.language, (navigator.languages || []).join(","),
    screen.width + "x" + screen.height, String(screen.colorDepth),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    String(navigator.hardwareConcurrency || 0), (navigator as any).platform || "",
    String(window.devicePixelRatio || 0), String((navigator as any).deviceMemory || 0),
    screen.availWidth + "x" + screen.availHeight, String(navigator.maxTouchPoints || 0),
  ];
  try {
    const cv = document.createElement("canvas"); const ctx = cv.getContext("2d");
    if (ctx) { ctx.textBaseline = "top"; ctx.font = "14px 'Arial'"; ctx.fillStyle = "#f60"; ctx.fillRect(0, 0, 60, 20); ctx.fillStyle = "#069"; ctx.fillText("saimoe🎌", 2, 2); parts.push(cv.toDataURL()); }
  } catch {}
  try {
    const gl: any = document.createElement("canvas").getContext("webgl");
    const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
    if (dbg) parts.push(String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)), String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)));
  } catch {}
  const hash = await sha256Hex(parts.join("|"));
  try { localStorage.setItem("saimoe_fp", hash); } catch {}
  return hash;
}
function api(path: string, opts: RequestInit = {}) {
  const headers = new Headers(opts.headers);
  if (FP) headers.set("x-fp", FP);
  return fetch(path, { ...opts, headers, cache: "no-store" });
}

// route Bangumi images through our proxy so hotlink protection doesn't blank them
function imgSrc(url?: string | null): string {
  if (!url) return "";
  try {
    const h = new URL(url).hostname;
    if (h === "bgm.tv" || h.endsWith(".bgm.tv")) return "/api/img?u=" + encodeURIComponent(url);
  } catch {}
  return url;
}

function initials(n?: string) { return n?.trim()?.[0]?.toUpperCase() || "?"; }

function Avatar({ c, lg }: { c: Slim | null; lg?: boolean }) {
  const [broke, setBroke] = useState(false);
  if (!c) return null;
  const src = imgSrc(c.image);
  if (!src || broke) return <div className={"av-ph" + (lg ? " lg" : "")}>{initials(c.name)}</div>;
  return <img className={"av" + (lg ? " lg" : "")} src={src} alt={c.name} referrerPolicy="no-referrer" loading="lazy" onError={() => setBroke(true)} />;
}

const label = (c: Slim | null) => (c ? (c.nameCn || c.name) : "—");
const sub = (c: Slim | null) => (c && c.nameCn && c.nameCn !== c.name ? c.name : "");

function fmtRemain(ms: number, lang: Lang): string {
  const U = (k: string) => t(lang, k);
  if (ms <= 0) return "0" + U("unit.min");
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (d > 0) return `${d}${U("unit.day")} ${h}${U("unit.hour")} ${m}${U("unit.min")}`;
  if (h > 0) return `${h}${U("unit.hour")} ${m}${U("unit.min")} ${s}${U("unit.sec")}`;
  return `${m}${U("unit.min")} ${s}${U("unit.sec")}`;
}
function fmtAbs(ms: number, lang: Lang): string {
  const loc = lang === "en" ? "en-US" : lang === "ja" ? "ja-JP" : "zh-CN";
  try {
    return new Date(ms).toLocaleString(loc, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

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

export default function Page() {
  const [state, setState] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<any[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState("");
  const [manual, setManual] = useState(false);
  const [mName, setMName] = useState("");
  const [mImg, setMImg] = useState("");
  const [subQ, setSubQ] = useState("");
  const [subHits, setSubHits] = useState<any[] | null>(null);
  const [subSearching, setSubSearching] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const busyRef = useRef(false);
  const [now, setNow] = useState(() => Date.now());
  const [sel, setSel] = useState<number | null>(null);
  const [nomErr, setNomErr] = useState("");
  const [lang, setLang] = useLang();
  const T = (k: string, p?: Record<string, string | number>) => t(lang, k, p);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api("/api/state");
      if (r.status === 503) { setState({ disabled: true }); setLoading(false); setLoadErr(false); return; }
      setState(await r.json());
      setLoading(false);
      setLoadErr(false);
    } catch {
      setLoading(false);
      setLoadErr(true);
    }
  }, []);

  useEffect(() => {
    (async () => { FP = await computeFp(); await load(); })();
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => { load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const search = async () => {
    const kw = q.trim(); if (!kw) return;
    setSearching(true); setSearchErr(""); setHits(null); setManual(false);
    try {
      const r = await api(`/api/bangumi/search?q=${encodeURIComponent(kw)}`);
      const j = await r.json();
      if (j.error) { setSearchErr(T("search.fail", { err: j.error })); setManual(true); setMName(kw); setHits(null); }
      else setHits(j.hits || []);
    } catch { setSearchErr(T("net.err")); setManual(true); setMName(kw); setHits(null); }
    finally { setSearching(false); }
  };

  const searchSubjects = async () => {
    const kw = subQ.trim(); if (!kw) return;
    setSubSearching(true); setImportMsg(""); setSubHits(null);
    try {
      const r = await api(`/api/bangumi/subjects?q=${encodeURIComponent(kw)}`);
      const j = await r.json();
      if (j.error) setImportMsg(T("subject.fail", { err: j.error }));
      setSubHits(j.hits || []);
    } catch { setImportMsg(T("subject.neterr")); }
    finally { setSubSearching(false); }
  };

  const post = async (body: any) => {
    if (busyRef.current) return null;
    busyRef.current = true;
    try {
      const r = await api("/api/nominate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return await r.json();
    } finally { busyRef.current = false; }
  };
  const nominate = async (bgmId: string) => { await post({ bgmId }); await load(); };
  const nominateManual = async () => {
    if (!mName.trim()) return;
    await post({ manual: { name: mName.trim(), image: mImg.trim() } });
    setMName(""); setMImg(""); setManual(false); setHits(null); await load();
  };
  const importSubject = async (subjectId: string, name: string) => {
    setImportMsg(T("import.progress", { name }));
    const j = await post({ subject: subjectId });
    setImportMsg(j?.error ? T("import.fail", { err: j.error }) : T("import.done", { name, added: j?.added ?? 0, imported: j?.imported ?? 0 }));
    await load();
  };

  const nomVote = async (candidateId: number) => {
    setNomErr("");
    const r = await api("/api/vote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "nominate", candidateId }) });
    const j = await r.json().catch(() => ({}));
    if (j?.error) setNomErr(j.error);
    await load();
  };
  const matchVote = async (matchupId: number, choiceId: number) => {
    await api("/api/vote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "match", matchupId, choiceId }) });
    await load();
  };

  const comp = state?.competition;
  const phase: string = comp?.phase ?? "nomination";

  const phases: [string, string][] = [["nomination", T("phase.nomination")], ["group", T("phase.group")], ["knockout", T("phase.knockout")], ["finished", T("phase.finished")]];

  const deadline: number | null =
    phase === "nomination" ? comp?.nomEndsAt ?? null :
    phase === "group" ? comp?.groupRoundEndsAt ?? null :
    phase === "knockout" ? comp?.koRoundEndsAt ?? null : null;
  const deadlineLabel =
    phase === "nomination" ? T("dl.nomination") : phase === "group" ? T("dl.group") : phase === "knockout" ? T("dl.knockout") : "";

  const koRounds: any[] = state?.knockout?.rounds || [];
  const selMatch: Match | null = sel != null ? (koRounds.flatMap((r: any) => r.matchups).find((m: Match) => m.id === sel) || null) : null;

  return (
    <main className="wrap">
      <div className="langbar">{LANGS.map((L) => <button key={L.code} type="button" className={"lang" + (lang === L.code ? " on" : "")} onClick={() => setLang(L.code)}>{L.label}</button>)}</div>
      <h1 className="title">{comp?.title || T("title")}</h1>
      <p className="subtitle">{comp?.description || T("subtitle")}</p>
      <div className="phasebar">
        {phases.map(([p, name]) => <span key={p} className={"chip" + (comp && p === phase ? " on" : "")}>{name}</span>)}
      </div>
      <div className="hint" style={{ marginTop: 6 }}><a href="/rules">{T("rulesLink")}</a></div>

      {!loading && comp && deadline && phase !== "finished" && (
        <div className="deadline">
          <span className="dl-label">{deadlineLabel}</span>
          <span className="dl-time">{fmtAbs(deadline, lang)}</span>
          <span className="dl-remain">{deadline > now ? T("dl.remain", { t: fmtRemain(deadline - now, lang) }) : T("dl.over")}</span>
        </div>
      )}

      {loading && (
        <div className="skel-wrap">
          {[0, 1, 2, 3].map((i) => <div className="skel-row" key={i}><div className="skel av" /><div className="skel line" /></div>)}
        </div>
      )}

      {!loading && loadErr && (
        <div className="empty"><div className="big">📡</div>
          <p style={{ color: "var(--ink)", fontWeight: 700 }}>{T("err.load.title")}</p>
          <p>{T("err.load.body")}</p>
          <button className="btn solid" onClick={load}>{T("common.retry")}</button></div>
      )}

      {!loading && !loadErr && state?.disabled && (
        <div className="empty"><div className="big">🚧</div>
          <p style={{ color: "var(--ink)", fontWeight: 700 }}>{T("disabled.title")}</p>
          <p>{T("disabled.body")}</p></div>
      )}

      {!loading && !state?.disabled && !comp && (
        <div className="empty"><div className="big">🎬</div>
          <p style={{ color: "var(--ink)", fontWeight: 700 }}>{T("nocomp.title")}</p>
          <p>{T("nocomp.body")}</p></div>
      )}

      {/* ── NOMINATION ── */}
      {!loading && comp && phase === "nomination" && (
        <>
          <div className="sectlabel">{T("nom.section")}</div>
          <div className="searchbox">
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} placeholder={T("nom.ph.char")} />
            <button onClick={search} disabled={searching || !q.trim()}>{searching ? T("common.searching") : T("nom.searchChar")}</button>
          </div>
          <div className="searchbox">
            <input value={subQ} onChange={(e) => setSubQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && searchSubjects()} placeholder={T("nom.ph.subject")} />
            <button onClick={searchSubjects} disabled={subSearching || !subQ.trim()}>{subSearching ? T("common.searching") : T("nom.searchSubject")}</button>
          </div>
          {importMsg && <div className="hint">{importMsg}</div>}
          <div className="hint">{T("nom.notFoundQ")}<a onClick={() => { setManual(true); setHits(null); }}>{T("nom.manualAdd")}</a></div>
          {searchErr && <div className="hint" style={{ color: "var(--rose-deep)" }}>{searchErr}</div>}

          {subHits && (
            <div className="results">
              {subHits.length === 0 && <div className="rrow"><span className="hint">{T("nom.noSubject")}</span></div>}
              {subHits.map((s) => (
                <div className="rrow" key={s.subjectId}>
                  <Avatar c={{ id: 0, name: s.nameCn || s.name, nameCn: null, image: s.image }} />
                  <div className="meta"><div className="nm">{s.nameCn || s.name}</div><div className="sub">{s.nameCn && s.nameCn !== s.name ? s.name + " · " : ""}{T("nom.subjectTag")} · #{s.subjectId}</div></div>
                  <button className="btn" onClick={() => importSubject(s.subjectId, s.nameCn || s.name)}>{T("nom.importAll")}</button>
                </div>
              ))}
            </div>
          )}

          {hits && (
            <div className="results">
              {hits.length === 0 && <div className="rrow"><span className="hint">{T("nom.noChar")}</span></div>}
              {hits.map((h) => (
                <div className="rrow" key={h.bgmId}>
                  <Avatar c={{ id: 0, name: h.name, nameCn: null, image: h.image }} />
                  <div className="meta"><div className="nm">{h.name}</div><div className="sub">{T("nom.charTag")} · #{h.bgmId}</div></div>
                  <button className="btn" onClick={() => nominate(h.bgmId)}>{T("nom.plus")}</button>
                </div>
              ))}
            </div>
          )}

          {manual && (
            <div className="card" style={{ marginTop: 14 }}>
              <h3>{T("nom.manualTitle")}</h3>
              <div className="field"><label>{T("nom.nameRequired")}</label><input value={mName} onChange={(e) => setMName(e.target.value)} /></div>
              <div className="field"><label>{T("nom.imgOptional")}</label><input value={mImg} onChange={(e) => setMImg(e.target.value)} /></div>
              <button className="btn solid" onClick={nominateManual} disabled={!mName.trim()}>{T("nom.addToPool")}</button>
            </div>
          )}

          <div className="sec"><h2>{T("nom.poolTitle")}</h2><div className="meta2"><b>{state.nomination.pool.length}</b> {T("nom.countSuffix")}</div></div>
          <div className="hint">
            {state.nomination.userLimit > 0 ? T("nom.limitOn", { n: state.nomination.userLimit, x: state.nomination.myCount }) : T("nom.limitOff")}
            {state.nomination.minVotes > 0 ? T("nom.minVotes", { n: state.nomination.minVotes }) : ""}
          </div>
          {nomErr && <div className="hint" style={{ color: "var(--rose-deep)" }}>{nomErr}</div>}
          {state.nomination.pool.length === 0 ? (
            <div className="empty">{T("nom.empty")}</div>
          ) : (
            <div className="results">
              {state.nomination.pool.map((p: PoolItem, i: number) => (
                <div className="prow" key={p.id}>
                  <div className="rankn num">{i + 1}</div>
                  <Avatar c={p} />
                  <div className="meta"><div className="nm">{label(p)}</div><div className="sub">{sub(p)}</div></div>
                  <div className="votecell num"><div className="c">{p.votes}</div><div className="l">{T("nom.voteLabel")}</div></div>
                  <button className={"btn" + (p.voted ? " solid" : "")} onClick={() => nomVote(p.id)}>{p.voted ? T("nom.voted") : T("nom.vote")}</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── GROUP ── */}
      {!loading && comp && phase === "group" && (
        <>
          <div className="sec"><h2>{T("group.title")}</h2><div className="meta2">{T("group.advance", { n: comp.advancePerGroup })}</div></div>
          {state.group.matchdayCount > 1 && <div className="hint">{T("group.matchday", { d: state.group.matchday, n: state.group.matchdayCount })}</div>}
          <div className="groupwrap">
            {state.group.groups.map((g: any) => (
              <div className="group" key={g.group}>
                <h3>{T("group.letter", { L: String.fromCharCode(65 + g.group) })}</h3>
                <table className="stand">
                  <thead><tr><th>{T("th.rank")}</th><th>{T("th.char")}</th><th style={{ textAlign: "right" }}>{T("th.win")}</th><th style={{ textAlign: "right" }}>{T("th.votes")}</th></tr></thead>
                  <tbody>
                    {g.standings.map((s: any, i: number) => (
                      <tr key={s.id} className={i < comp.advancePerGroup ? "adv" : ""}>
                        <td>{i + 1}</td><td>{label(s)}</td><td className="n num">{s.wins}</td><td className="n num">{s.votesFor ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {g.matchups.map((m: Match) => <MatchCard key={m.id} m={m} onVote={matchVote} lang={lang} />)}
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── KNOCKOUT / FINISHED ── */}
      {!loading && comp && (phase === "knockout" || phase === "finished") && (
        <>
          {state.knockout.champion && (
            <div className="champ">
              <div className="crown">👑</div>
              <div className="who">{label(state.knockout.champion)}</div>
              {sub(state.knockout.champion) && <div className="cn">{sub(state.knockout.champion)}</div>}
              <div className="champ-tag">{T("champ.tag")}</div>
            </div>
          )}
          <div className="sec"><h2>{T("ko.title")}</h2><div className="meta2">{T("ko.hint")}</div></div>
          <div className="bracket">
            {state.knockout.rounds.map((r: any) => (
              <div className="bcol" key={r.round}>
                <div className="bcol-h">{roundLabelT(lang, r.label)}</div>
                <div className="bcol-cells">
                  {r.matchups.map((m: Match) => (
                    <BracketCell key={m.id} m={m} active={sel === m.id} onOpen={() => setSel(sel === m.id ? null : m.id)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          {selMatch && (
            <div className="bracket-detail">
              <div className="sectlabel">{T("ko.detail")}</div>
              <MatchCard m={selMatch} onVote={matchVote} ko lang={lang} />
            </div>
          )}
        </>
      )}

      <div className="foot">
        {T("dataFrom")}<br />
        <a href="/rules">{T("rules")}</a>
      </div>
    </main>
  );
}

function MatchCard({ m, onVote, ko, lang }: { m: Match; onVote: (mid: number, cid: number) => void; ko?: boolean; lang: Lang }) {
  const T = (k: string, p?: Record<string, string | number>) => t(lang, k, p);
  const revealed = m.decided;
  const pa = revealed && m.total ? ((m.votesA || 0) / m.total) * 100 : (m.rateA ?? 50);
  const live = m.live ?? true;
  const clickable = live && !m.decided && m.a && m.b;
  const sideCls = (id: number | undefined) =>
    "side" + (m.myChoice === id ? " picked" : "") + (m.decided && m.winnerId === id ? " win" : "");
  // 赛中只显示得票率;结算后显示绝对票数
  const numA = revealed ? String(m.votesA ?? 0) : m.rateA == null ? "—" : `${m.rateA}%`;
  const numB = revealed ? String(m.votesB ?? 0) : m.rateA == null ? "—" : `${100 - m.rateA}%`;

  return (
    <div className={"match" + (ko ? " ko" : "")}>
      <div className="versus">
        <button type="button" className={sideCls(m.a?.id)} onClick={() => clickable && m.a && onVote(m.id, m.a.id)} disabled={!m.a}>
          <Avatar c={m.a} lg />
          <span className="nm">{label(m.a)}</span>{sub(m.a) && <span className="cn">{sub(m.a)}</span>}
          <span className="v num">{numA}</span>
          {m.decided && m.winnerId === m.a?.id && <span className="adv-tag">{T("match.advance")}</span>}
        </button>
        <div className="vs">VS</div>
        <button type="button" className={sideCls(m.b?.id)} onClick={() => clickable && m.b && onVote(m.id, m.b.id)} disabled={!m.b}>
          <Avatar c={m.b} lg />
          <span className="nm">{label(m.b)}</span>{sub(m.b) && <span className="cn">{sub(m.b)}</span>}
          <span className="v num">{numB}</span>
          {m.decided && m.winnerId === m.b?.id && <span className="adv-tag">{T("match.advance")}</span>}
        </button>
      </div>
      <div className="share"><div className="a" style={{ width: pa + "%" }} /><div className="b" style={{ width: 100 - pa + "%" }} /></div>
      <div className="match-foot">
        <span className="rate-note">{revealed ? T("match.settled") : live ? T("match.rateNote") : T("match.upcoming")}</span>
      </div>
      {m.a && m.b && <Comments matchId={m.id} count={m.commentN} lang={lang} />}
    </div>
  );
}

function Comments({ matchId, count, lang }: { matchId: number; count: number; lang: Lang }) {
  const T = (k: string, p?: Record<string, string | number>) => t(lang, k, p);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<any[] | null>(null);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const fetchList = async () => {
    try { const r = await api(`/api/comments?matchupId=${matchId}`); const j = await r.json(); setList(j.comments || []); }
    catch { setList([]); }
  };
  const toggle = () => { const nx = !open; setOpen(nx); if (nx && list === null) fetchList(); };
  const send = async () => {
    const t = text.trim(); if (!t || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await api("/api/comments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ matchupId: matchId, text: t, name: name.trim() }) });
      const j = await r.json();
      if (j.error) setErr(j.error);
      else { setText(""); await fetchList(); }
    } catch { setErr(T("cmt.sendFail")); }
    finally { setBusy(false); }
  };

  return (
    <div className="cmts">
      <button type="button" className="cmt-toggle" onClick={toggle}>💬 {open ? T("cmt.collapse") : T("cmt.open") + (count ? " " + count : "")}</button>
      {open && (
        <div className="cmt-body">
          <div className="cmt-post">
            <input className="cmt-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={T("cmt.name")} maxLength={24} />
            <div className="cmt-row">
              <input className="cmt-text" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder={T("cmt.text")} maxLength={300} />
              <button className="btn solid" onClick={send} disabled={busy || !text.trim()}>{T("cmt.send")}</button>
            </div>
            {err && <div className="hint" style={{ color: "var(--rose-deep)" }}>{err}</div>}
          </div>
          {list === null ? <div className="hint">{T("cmt.loading")}</div>
            : list.length === 0 ? <div className="hint">{T("cmt.empty")}</div>
            : <ul className="cmt-list">{list.map((c) => (
                <li key={c.id}><span className="cmt-who">{c.name || T("cmt.anon")}</span><span className="cmt-t">{c.text}</span></li>
              ))}</ul>}
        </div>
      )}
    </div>
  );
}

function BracketCell({ m, active, onOpen }: { m: Match; active: boolean; onOpen: () => void }) {
  const revealed = m.decided;
  const cell = (c: Slim | null, id: number | undefined, right: boolean) => {
    const num = revealed ? (right ? m.votesB ?? 0 : m.votesA ?? 0) : m.rateA == null ? "" : (right ? 100 - m.rateA : m.rateA) + "%";
    const win = m.decided && m.winnerId === id;
    const pick = m.myChoice === id;
    return (
      <div className={"bside" + (win ? " win" : "") + (pick ? " picked" : "")}>
        <Avatar c={c} />
        <span className="bnm">{label(c)}</span>
        <span className="bnum num">{num}</span>
      </div>
    );
  };
  return (
    <button type="button" className={"bcell" + (active ? " active" : "")} onClick={onOpen}>
      {cell(m.a, m.a?.id, false)}
      {cell(m.b, m.b?.id, true)}
    </button>
  );
}
