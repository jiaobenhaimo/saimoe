"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Slim = { id: number; name: string; nameCn: string | null; image: string | null };
type PoolItem = Slim & { votes: number; voted: boolean };
type Match = {
  id: number; stage: string; round: number; group: number | null; slot: number;
  a: Slim | null; b: Slim | null; votesA: number; votesB: number;
  winnerId: number | null; decided: boolean; myChoice: number | null;
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

function fmtRemain(ms: number): string {
  if (ms <= 0) return "0 分";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (d > 0) return `${d} 天 ${h} 小时 ${m} 分`;
  if (h > 0) return `${h} 小时 ${m} 分 ${s} 秒`;
  return `${m} 分 ${s} 秒`;
}
function fmtAbs(ms: number): string {
  try {
    return new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

export default function Page() {
  const [state, setState] = useState<any>(null);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    const r = await api("/api/state");
    if (r.status === 503) { setState({ disabled: true }); setLoading(false); return; }
    setState(await r.json());
    setLoading(false);
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
      if (j.error) { setSearchErr(`在线搜索失败（${j.error}），可手动添加。`); setManual(true); setMName(kw); }
      setHits(j.hits || []);
    } catch { setSearchErr("网络错误，可手动添加。"); setManual(true); setMName(kw); }
    finally { setSearching(false); }
  };

  const searchSubjects = async () => {
    const kw = subQ.trim(); if (!kw) return;
    setSubSearching(true); setImportMsg(""); setSubHits(null);
    try {
      const r = await api(`/api/bangumi/subjects?q=${encodeURIComponent(kw)}`);
      const j = await r.json();
      if (j.error) setImportMsg(`作品搜索失败：${j.error}`);
      setSubHits(j.hits || []);
    } catch { setImportMsg("作品搜索网络错误。"); }
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
    setImportMsg(`正在导入《${name}》的角色…`);
    const j = await post({ subject: subjectId });
    setImportMsg(j?.error ? `导入失败：${j.error}` : `《${name}》导入完成：新增 ${j?.added ?? 0} / 共 ${j?.imported ?? 0} 个角色`);
    await load();
  };

  const nomVote = async (candidateId: number) => {
    await api("/api/vote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "nominate", candidateId }) });
    await load();
  };
  const matchVote = async (matchupId: number, choiceId: number) => {
    await api("/api/vote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "match", matchupId, choiceId }) });
    await load();
  };

  const comp = state?.competition;
  const phase: string = comp?.phase ?? "nomination";

  const phases = [["nomination", "预选提名"], ["group", "小组赛"], ["knockout", "淘汰赛"], ["finished", "冠军"]] as const;

  const deadline: number | null =
    phase === "nomination" ? comp?.nomEndsAt ?? null :
    phase === "group" ? comp?.groupEndsAt ?? null :
    phase === "knockout" ? comp?.koRoundEndsAt ?? null : null;
  const deadlineLabel =
    phase === "nomination" ? "提名截止" : phase === "group" ? "小组赛截止" : phase === "knockout" ? "本轮截止" : "";

  return (
    <main className="wrap">
      <h1 className="title">{comp?.title || "世萌大会"}</h1>
      <p className="subtitle">{comp?.description || "为你喜爱的角色提名助威，从提名池一路投到总决赛。提名阶段可支持任意多个角色（每个角色一票）；对战阶段每场一票，均可随时改投或撤回。"}</p>
      <div className="phasebar">
        {phases.map(([p, name]) => <span key={p} className={"chip" + (p === phase ? " on" : "")}>{name}</span>)}
      </div>
      <div className="hint" style={{ marginTop: 6 }}><a href="/rules">赛制介绍 →</a></div>

      {!loading && comp && deadline && phase !== "finished" && (
        <div className="deadline">
          <span className="dl-label">{deadlineLabel}</span>
          <span className="dl-time">{fmtAbs(deadline)}</span>
          <span className="dl-remain">{deadline > now ? "剩 " + fmtRemain(deadline - now) : "已到时，正在处理…"}</span>
        </div>
      )}

      {loading && (
        <div className="skel-wrap">
          {[0, 1, 2, 3].map((i) => <div className="skel-row" key={i}><div className="skel av" /><div className="skel line" /></div>)}
        </div>
      )}

      {!loading && state?.disabled && (
        <div className="empty"><div className="big">🚧</div>
          <p style={{ color: "var(--ink)", fontWeight: 700 }}>服务暂未开放</p>
          <p>API 当前已禁用。请管理员设置环境变量 <code>API_ENABLED=true</code> 后重新部署。</p></div>
      )}

      {!loading && !state?.disabled && !comp && (
        <div className="empty"><div className="big">🎬</div>
          <p style={{ color: "var(--ink)", fontWeight: 700 }}>比赛还没开始</p>
          <p>比赛尚未开始，敬请期待。</p></div>
      )}

      {/* ── NOMINATION ── */}
      {!loading && comp && phase === "nomination" && (
        <>
          <div className="sectlabel">提名角色</div>
          <div className="searchbox">
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} placeholder="输入角色名，提名单个角色" />
            <button onClick={search} disabled={searching || !q.trim()}>{searching ? "搜索中" : "搜角色"}</button>
          </div>
          <div className="searchbox">
            <input value={subQ} onChange={(e) => setSubQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && searchSubjects()} placeholder="输入作品名，批量导入其全部角色" />
            <button onClick={searchSubjects} disabled={subSearching || !subQ.trim()}>{subSearching ? "搜索中" : "搜作品"}</button>
          </div>
          {importMsg && <div className="hint">{importMsg}</div>}
          <div className="hint">没有找到？<a onClick={() => { setManual(true); setHits(null); }}>手动添加角色</a></div>
          {searchErr && <div className="hint" style={{ color: "var(--rose-deep)" }}>{searchErr}</div>}

          {subHits && (
            <div className="results">
              {subHits.length === 0 && <div className="rrow"><span className="hint">没搜到作品，换个关键词。</span></div>}
              {subHits.map((s) => (
                <div className="rrow" key={s.subjectId}>
                  <Avatar c={{ id: 0, name: s.nameCn || s.name, nameCn: null, image: s.image }} />
                  <div className="meta"><div className="nm">{s.nameCn || s.name}</div><div className="sub">{s.nameCn && s.nameCn !== s.name ? s.name + " · " : ""}作品 · #{s.subjectId}</div></div>
                  <button className="btn" onClick={() => importSubject(s.subjectId, s.nameCn || s.name)}>导入全体角色</button>
                </div>
              ))}
            </div>
          )}

          {hits && (
            <div className="results">
              {hits.length === 0 && <div className="rrow"><span className="hint">没搜到角色，换个词或手动添加。</span></div>}
              {hits.map((h) => (
                <div className="rrow" key={h.bgmId}>
                  <Avatar c={{ id: 0, name: h.name, nameCn: null, image: h.image }} />
                  <div className="meta"><div className="nm">{h.name}</div><div className="sub">角色 · #{h.bgmId}</div></div>
                  <button className="btn" onClick={() => nominate(h.bgmId)}>＋ 提名</button>
                </div>
              ))}
            </div>
          )}

          {manual && (
            <div className="card" style={{ marginTop: 14 }}>
              <h3>手动添加角色</h3>
              <div className="field"><label>角色名（必填）</label><input value={mName} onChange={(e) => setMName(e.target.value)} /></div>
              <div className="field"><label>图片链接（可选）</label><input value={mImg} onChange={(e) => setMImg(e.target.value)} /></div>
              <button className="btn solid" onClick={nominateManual} disabled={!mName.trim()}>加入提名池</button>
            </div>
          )}

          <div className="sec"><h2>提名池 · 人气预选</h2><div className="meta2"><b>{state.nomination.pool.length}</b> 个角色</div></div>
          {state.nomination.pool.length === 0 ? (
            <div className="empty">还没有提名，添加一个角色开个头吧。</div>
          ) : (
            <div className="results">
              {state.nomination.pool.map((p: PoolItem, i: number) => (
                <div className="prow" key={p.id}>
                  <div className="rankn num">{i + 1}</div>
                  <Avatar c={p} />
                  <div className="meta"><div className="nm">{label(p)}</div><div className="sub">{sub(p)}</div></div>
                  <div className="votecell num"><div className="c">{p.votes}</div><div className="l">提名</div></div>
                  <button className={"btn" + (p.voted ? " solid" : "")} onClick={() => nomVote(p.id)}>{p.voted ? "已投" : "投一票"}</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── GROUP ── */}
      {!loading && comp && phase === "group" && (
        <>
          <div className="sec"><h2>小组赛 · 循环对战</h2><div className="meta2">每组前 <b>{comp.advancePerGroup}</b> 名晋级</div></div>
          <div className="groupwrap">
            {state.group.groups.map((g: any) => (
              <div className="group" key={g.group}>
                <h3>{String.fromCharCode(65 + g.group)} 组</h3>
                <table className="stand">
                  <thead><tr><th>#</th><th>角色</th><th style={{ textAlign: "right" }}>胜</th><th style={{ textAlign: "right" }}>得票</th></tr></thead>
                  <tbody>
                    {g.standings.map((s: any, i: number) => (
                      <tr key={s.id} className={i < comp.advancePerGroup ? "adv" : ""}>
                        <td>{i + 1}</td><td>{label(s)}</td><td className="n num">{s.wins}</td><td className="n num">{s.votesFor}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {g.matchups.map((m: Match) => <MatchCard key={m.id} m={m} onVote={matchVote} />)}
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
              <div className="champ-tag">本届世萌总冠军</div>
            </div>
          )}
          <div className="sec"><h2>淘汰赛 · 单败晋级</h2><div className="meta2">点角色投票 · 一场一票</div></div>
          <div className="rounds">
            {state.knockout.rounds.map((r: any) => (
              <div className="round" key={r.round}>
                <h3>{r.label}</h3>
                {r.matchups.map((m: Match) => <MatchCard key={m.id} m={m} onVote={matchVote} ko />)}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="foot">
        数据来自 Bangumi<br />
        <a href="/rules">赛制介绍</a>
      </div>
    </main>
  );
}

function MatchCard({ m, onVote, ko }: { m: Match; onVote: (mid: number, cid: number) => void; ko?: boolean }) {
  const total = m.votesA + m.votesB;
  const pa = total ? (m.votesA / total) * 100 : 50;
  const clickable = !m.decided && m.a && m.b;
  const sideCls = (id: number | undefined) =>
    "side" + (m.myChoice === id ? " picked" : "") + (m.decided && m.winnerId === id ? " win" : "");
  return (
    <div className={"match" + (ko ? " ko" : "")}>
      <div className="versus">
        <div className={sideCls(m.a?.id)} onClick={() => clickable && m.a && onVote(m.id, m.a.id)}>
          <Avatar c={m.a} lg />
          <div className="nm">{label(m.a)}</div>{sub(m.a) && <div className="cn">{sub(m.a)}</div>}
          <div className="v num">{m.votesA}</div>
          {m.decided && m.winnerId === m.a?.id && <div className="adv-tag">晋级</div>}
        </div>
        <div className="vs">VS</div>
        <div className={sideCls(m.b?.id)} onClick={() => clickable && m.b && onVote(m.id, m.b.id)}>
          <Avatar c={m.b} lg />
          <div className="nm">{label(m.b)}</div>{sub(m.b) && <div className="cn">{sub(m.b)}</div>}
          <div className="v num">{m.votesB}</div>
          {m.decided && m.winnerId === m.b?.id && <div className="adv-tag">晋级</div>}
        </div>
      </div>
      <div className="share"><div className="a" style={{ width: pa + "%" }} /><div className="b" style={{ width: 100 - pa + "%" }} /></div>
      {m.decided && <div className="decided-tag">本场已结算</div>}
    </div>
  );
}
