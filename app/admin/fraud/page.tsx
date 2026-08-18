"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** epoch ms → 本地时间，带秒（时间线要让 burst 间隔一眼可见）。 */
function fmt(ms?: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function shortVid(v: string): string {
  const core = v.replace(/^sid_/, "");
  return core.slice(0, 8);
}

const KIND_ZH: Record<string, string> = {
  identity_churn: "指纹内身份更替",
  duplicate_ballot: "票单重复",
  same_ip_cross_device: "同网络跨设备",
  max_ballot_stacking: "顶满上限堆叠",
};
const LEVEL_ZH: Record<string, string> = { high: "高危", medium: "可疑", low: "关注" };

interface Cluster {
  id: string; kind: string; score: number; level: "high" | "medium" | "low";
  deviceBuckets: string[]; ipsNorm: string[]; totalVotes: number;
  identities: { voterId: string; votes: number; firstAt: number; lastAt: number; candidates: number[]; ipsFull: string[] }[];
  signals: { code: string; strength: number; weight: number; evidence: string }[];
  reverse: { code: string; evidence: string }[];
  timeline: { at: number; voterId: string; candidate: string; ip: string }[];
  impact: {
    cutLine: number; tiedAtCutLine: number;
    affected: { candidateId: number; nameCn: string; votesBefore: number; rankBefore: number; votesAfter: number; rankAfter: number; crossesCut: string }[];
    scope?: "nomination" | "approval" | "match";
    groupFlips?: { groupNo: number; inOut: string[]; outIn: string[] }[];
    matchFlips?: { matchupId: number; before: string; after: string; decided: boolean }[];
  };
  reviewed: boolean;
}
interface Report {
  generatedAt: number;
  params: { competitionId: number; phase: string; windowMs: number; minScore: number };
  baseline: { buckets: number; identityDistribution: Record<number, number>; totalVotes: number };
  clusters: Cluster[];
  natSuspects: { ipNorm: string; identities: number; buckets: number }[];
  combinedImpact?: Cluster["impact"];
}

/** 组号 → A/B/C…（与主站 groupLabel 一致）。 */
function groupLetter(n: number): string {
  let out = ""; let x = Math.max(0, Math.floor(n));
  do { out = String.fromCharCode(65 + (x % 26)) + out; x = Math.floor(x / 26) - 1; } while (x >= 0);
  return out;
}

export default function AdminFraud() {
  const [token, setToken] = useState("");
  const [authed, setAuthed] = useState(false);
  const [authErr, setAuthErr] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [phase, setPhase] = useState<"nomination" | "approval" | "match">("nomination");
  const [windowMin, setWindowMin] = useState(30);
  const [minScore, setMinScore] = useState(20);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ t: string; ok: boolean } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [combined, setCombined] = useState<Cluster["impact"] | null>(null);
  const [showLow, setShowLow] = useState(false);
  // 已复核（判定为误报）的簇默认**隐藏**，不再只是折叠：复核过一次就说明运营已经看过并下了结论，
  // 让它继续占着列表只会让每次刷新都要重新跳过同一批。需要回头改判时勾这个开关。
  const [showReviewed, setShowReviewed] = useState(false);
  const initialized = useRef(false);

  const tk = useCallback(() => token || localStorage.getItem("adminToken") || "", [token]);

  const load = useCallback(async (override?: string): Promise<boolean> => {
    const t = override || tk();
    if (!t) return false;
    try {
      const url = `/api/admin/fraud-report?phase=${phase}&window=${windowMin}&minScore=${minScore}`;
      const r = await fetch(url, { headers: { "x-admin-token": t }, cache: "no-store" });
      const j = await r.json();
      if (!r.ok) { setMsg({ t: j.error || "读取失败", ok: false }); return false; }
      setReport(j);
      if (!initialized.current) {
        initialized.current = true;
        setSelected(new Set(j.clusters.filter((c: Cluster) => c.level === "high" && !c.reviewed).map((c: Cluster) => c.id)));
      }
      return true;
    } catch { setMsg({ t: "读取失败，请重试。", ok: false }); return false; }
  }, [tk, phase, windowMin, minScore]);

  const unlock = async () => {
    const t = token.trim();
    setAuthErr("");
    if (!t) { setAuthErr("请输入令牌。"); return; }
    localStorage.setItem("adminToken", t);
    const ok = await load(t); // 令牌验证成功才解锁
    setAuthed(ok);
    if (!ok) setAuthErr("令牌不正确。");
  };

  useEffect(() => {
    const saved = localStorage.getItem("adminToken") || "";
    if (saved) {
      setToken(saved);
      (async () => { const ok = await load(saved); setAuthed(ok); })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (authed) load(); }, [authed, load]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 当前实际显示出来的簇。筛选（关注级 / 已复核）和「作废选中」必须用同一个集合，
   *  否则会出现「勾选后被筛掉、但一按作废还是把它删了」这种看不见的删票。 */
  const visibleClusters = useMemo(() => {
    const list = report?.clusters ?? [];
    const byLevel = showLow ? list : list.filter((c) => c.level !== "low");
    return showReviewed ? byLevel : byLevel.filter((c) => !c.reviewed);
  }, [report, showLow, showReviewed]);

  // 勾选组合变化 → 轻量拉取合并影响预览。
  // 只认**可见**的勾选：隐藏一个簇就等于把它从本次操作里排除，符合「看到什么就是要动什么」。
  const selectedClusters = useMemo(
    () => visibleClusters.filter((c) => selected.has(c.id)),
    [visibleClusters, selected],
  );
  useEffect(() => {
    let alive = true;
    const ids = [...new Set(selectedClusters.flatMap((c) => c.identities.map((i) => i.voterId)))];
    const t = tk();
    if (!ids.length || !t) { setCombined(null); return; }
    fetch(`/api/admin/fraud-report?impactOnly=1&voterIds=${encodeURIComponent(ids.join(","))}`, { headers: { "x-admin-token": t }, cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (alive && j?.combinedImpact) setCombined(j.combinedImpact); })
      .catch(() => {});
    return () => { alive = false; };
  }, [selectedClusters, tk]);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const voidSelected = async () => {
    const clusters = selectedClusters;
    if (!clusters.length) return;
    const voterIds = [...new Set(clusters.flatMap((c) => c.identities.map((i) => i.voterId)))];
    const reason = `异常投票检测处置（${clusters.map((c) => `${c.id}#${c.score}`).join("、")}）`;
    if (!confirm(`确认作废选中的 ${clusters.length} 个簇、共 ${voterIds.length} 个身份？不可撤销。\n${reason}`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/fraud-report/void", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-token": tk() },
        body: JSON.stringify({
          competition_id: report?.params.competitionId,
          voterIds,
          reason,
          clusters: clusters.map((c) => ({ id: c.id, score: c.score, level: c.level, voterIds: c.identities.map((i) => i.voterId) })),
        }),
      });
      const j = await r.json();
      if (!r.ok) setMsg({ t: j.error || "作废失败", ok: false });
      else {
        setMsg({ t: j.message || `已作废 ${j.removed ?? 0} 票`, ok: true });
        setSelected(new Set());
        initialized.current = false;
      }
      await load();
    } finally { setBusy(false); }
  };

  const markReviewed = async (reviewed: boolean) => {
    const ids = [...selectedClusters.map((c) => c.id)];
    if (!ids.length) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/fraud-report", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-token": tk() },
        body: JSON.stringify({ action: reviewed ? "mark_reviewed" : "unmark_reviewed", ids }),
      });
      const j = await r.json();
      if (!r.ok) setMsg({ t: j.error || "操作失败", ok: false });
      else setMsg({ t: `已${reviewed ? "标记" : "取消标记"} ${ids.length} 个簇为已复核`, ok: true });
      await load();
    } finally { setBusy(false); }
  };

  const allVoterIds = new Set(report?.clusters.flatMap((c) => c.identities.map((i) => i.voterId)) ?? []);
  const crossing = selectedClusters.length
    ? (combined?.affected.filter((a) => a.crossesCut === "in→out").length ?? 0)
    : report?.clusters.filter((c) => c.impact.affected.some((a) => a.crossesCut === "in→out")).length ?? 0;

  return (
    <main className="wrap admin">
      <div className="eyebrow">Admin</div>
      <h1 className="title" style={{ fontSize: 30 }}>异常投票检测</h1>
      <p className="subtitle">自动识别刷票簇、量化其对晋级结果的影响，并给出可批量处置的清单。<b>只做检测与建议，绝不自动删票</b> —— 由你勾选后走作废接口（真删、不可撤销，作废前自动落快照）。</p>

      <div className="admin-cards">
        <div className="card">
          <div className="field"><label>管理员令牌</label>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") unlock(); }} placeholder="ADMIN_TOKEN" /></div>
          {authed ? <p className="hint" style={{ margin: "8px 0 0", color: "var(--ok)" }}>✓ 已解锁</p>
            : <button className="btn solid" onClick={unlock} style={{ marginTop: 8 }}>解锁</button>}
          {authErr && <p className="hint" style={{ margin: "8px 0 0", color: "var(--danger)" }}>{authErr}</p>}
        </div>

        {authed && report && (<>
          <div className="card">
            <h3>检测参数</h3>
            <div className="row3">
              <div className="field"><label>投票来源</label>
                <select value={phase} onChange={(e) => setPhase(e.target.value as any)}>
                  <option value="nomination">提名期（nominationVotes）</option>
                  <option value="approval">小组赛票选（approvalVotes）</option>
                  <option value="match">对战（matchVotes）</option>
                </select></div>
              <div className="field"><label>突发窗口（分钟）</label>
                <input type="number" min={1} value={windowMin} onChange={(e) => setWindowMin(+e.target.value || 30)} /></div>
              <div className="field"><label>最低分数（低于此不显示）</label>
                <input type="number" min={0} value={minScore} onChange={(e) => setMinScore(+e.target.value || 0)} /></div>
            </div>
            <button className="btn solid" disabled={busy} onClick={() => load()}>重新检测</button>
            {" "}<a href="/admin" style={{ cursor: "pointer" }}>← 返回控制台</a>
          </div>

          <div className="card">
            <h3>总览</h3>
            <div className="tally-grid">
              <div className="tally-col"><div className="tally-h">总票数</div><div className="tally-row"><span className="nm">本届</span><span className="v num">{report.baseline.totalVotes}</span></div></div>
              <div className="tally-col"><div className="tally-h">设备指纹</div><div className="tally-row"><span className="nm">数量</span><span className="v num">{report.baseline.buckets}</span></div></div>
              <div className="tally-col"><div className="tally-h">投票身份</div><div className="tally-row"><span className="nm">总数</span><span className="v num">{allVoterIds.size}</span></div></div>
              <div className="tally-col"><div className="tally-h">高危簇</div><div className="tally-row"><span className="nm">≥70 分</span><span className="v num">{report.clusters.filter((c) => c.level === "high").length}</span></div></div>
              <div className="tally-col"><div className="tally-h">受影响角色</div><div className="tally-row"><span className="nm">票数变动</span><span className="v num">{report.clusters.reduce((t, c) => t + c.impact.affected.length, 0)}</span></div></div>
              <div className="tally-col"><div className="tally-h">跨越晋级线</div><div className="tally-row"><span className="nm">in→out</span><span className="v num">{crossing}</span></div></div>
            </div>
            <p className="hint">身份数分布（每指纹身份数 → 指纹数）：{Object.entries(report.baseline.identityDistribution).sort((a, b) => +a[0] - +b[0]).map(([k, v]) => `${k}个×${v}`).join("、") || "—"}。</p>
            {report.natSuspects.length > 0 && (
              <p className="hint" style={{ color: "var(--muted)" }}>
                疑似 NAT 出口（多人共用、不作批量作废）：{report.natSuspects.map((n) => `${n.ipNorm}（${n.identities} 身份 / ${n.buckets} 指纹）`).join("、")}
              </p>
            )}
          </div>

          {selectedClusters.length > 0 && combined && (
            <div className="card" style={{ borderColor: "var(--rose)" }}>
              <h3>当前勾选组合的影响（{selectedClusters.length} 个簇 · {[...new Set(selectedClusters.flatMap((c) => c.identities.map((i) => i.voterId)))].length} 个身份）</h3>
              {/* 影响的口径随阶段变：提名看晋级线，小组赛看出线名额，淘汰赛看单场胜负。
                  以前不论哪个阶段都只算提名排名，小组赛期间会给出一份"看起来无害"的假预览。 */}
              {combined.scope === "approval" ? (
                <>
                  <p className="hint">小组赛口径：每组取前 2 名出线。作废后<b>出线名额会换人</b>的组：</p>
                  {combined.groupFlips?.length ? (
                    <div className="pool-admin">
                      {combined.groupFlips.map((g) => (
                        <div className="prow" key={g.groupNo}>
                          <div className="meta">
                            <div className="nm">{groupLetter(g.groupNo)} 组</div>
                            <div className="sub">
                              {g.inOut.length ? `掉出：${g.inOut.join("、")}` : ""}
                              {g.inOut.length && g.outIn.length ? " · " : ""}
                              {g.outIn.length ? `顶上：${g.outIn.join("、")}` : ""}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : <p className="hint">没有小组的出线名额发生变化。</p>}
                </>
              ) : combined.scope === "match" ? (
                <>
                  <p className="hint">淘汰赛口径：每场二选一。作废后<b>胜者会改变</b>的对局：</p>
                  {combined.matchFlips?.length ? (
                    <div className="pool-admin">
                      {combined.matchFlips.map((m) => (
                        <div className="prow" key={m.matchupId}>
                          <div className="meta">
                            <div className="nm">{m.before} → {m.after}</div>
                            <div className="sub">对局 #{m.matchupId}{m.decided ? " · 已结算，作废后需「按当前票数重算本轮」" : " · 进行中"}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : <p className="hint">没有对局的胜者发生变化。</p>}
                </>
              ) : (
                <p className="hint">提名口径：切线在 <b>{combined.cutLine}</b> 票；与切线同票 <b>{combined.tiedAtCutLine}</b> 人（大面积平票会牵连 tiebreak）。作废后将跨越晋级线（in→out）的角色：</p>
              )}
              {combined.scope !== "nomination" && combined.scope !== undefined ? null : combined.affected.some((a) => a.crossesCut === "in→out") ? (
                <div className="pool-admin">
                  {combined.affected.filter((a) => a.crossesCut === "in→out").map((a) => (
                    <div className="prow" key={a.candidateId}>
                      <div className="meta"><div className="nm">{a.nameCn}</div><div className="sub">由晋级区内掉出</div></div>
                      <div className="votecell num"><div className="c">{a.votesBefore} → {a.votesAfter}</div><div className="l">#{a.rankBefore} → #{a.rankAfter}</div></div>
                    </div>
                  ))}
                </div>
              ) : <p className="hint">无角色跨越晋级线。</p>}
            </div>
          )}

          {report.clusters.length === 0 ? (
            <div className="card"><p className="hint">未发现达到最低分数的可疑簇 👍</p></div>
          ) : (
            <>
              <div className="card" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <b>已选 {selectedClusters.length} 个簇</b>
                <label className="chk"><input type="checkbox" checked={showLow} onChange={(e) => setShowLow(e.target.checked)} /> 显示「关注」级</label>
                <label className="chk"><input type="checkbox" checked={showReviewed} onChange={(e) => setShowReviewed(e.target.checked)} /> 显示已复核</label>
                <button className="btn danger solid" disabled={busy || !selectedClusters.length} onClick={voidSelected}>作废选中（{selectedClusters.length}）</button>
                <button className="btn" disabled={busy || !selectedClusters.length} onClick={() => markReviewed(true)}>标记已复核（误报）</button>
                <button className="btn" disabled={busy || !selectedClusters.length} onClick={() => markReviewed(false)}>取消已复核</button>
              </div>
              {(() => {
                const byLevel = showLow ? report.clusters : report.clusters.filter((c) => c.level !== "low");
                const hiddenLows = report.clusters.length - byLevel.length;
                const visible = visibleClusters; // 与 selectedClusters 同源，见上面的注释
                const hiddenReviewed = byLevel.length - visible.length;
                return (
                  <>
              {hiddenLows > 0 && <p className="hint" style={{ margin: "0 0 4px" }}>另有 {hiddenLows} 个「关注」级簇（20–39 分）已折叠 —— 勾选上方「显示关注级」可查看。</p>}
              {hiddenReviewed > 0 && <p className="hint" style={{ margin: "0 0 4px" }}>已隐藏 {hiddenReviewed} 个标记为「已复核（误报）」的簇 —— 勾选上方「显示已复核」可查看或改判。</p>}
              {visible.length === 0 && byLevel.length > 0 && <div className="card"><p className="hint">当前筛选下没有待处理的簇 —— 其余都已复核 👍</p></div>}
              {visible.map((c) => (
                <div className="card" key={c.id} style={{ borderColor: c.level === "high" ? "var(--rose)" : c.level === "medium" ? "var(--gold)" : undefined }}>
                  <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                    <label className="chk" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} style={{ width: 18, height: 18, accentColor: "var(--rose)" }} />
                    </label>
                    <span className="flagtag" style={{ background: c.level === "high" ? "var(--rose)" : c.level === "medium" ? "var(--gold)" : "var(--muted)" }}>{LEVEL_ZH[c.level]}</span>
                    <b style={{ fontSize: 18 }}>{c.score}</b>
                    <span className="sub" style={{ fontSize: 13 }}>{KIND_ZH[c.kind] || c.kind} · {c.totalVotes} 票 · {c.identities.length} 个身份</span>
                    {c.reviewed && <span className="flagtag" style={{ background: "var(--ok)" }}>已复核</span>}
                  </div>
                  {c.deviceBuckets.length > 0 && <p className="hint" style={{ marginTop: 6 }}>指纹：{c.deviceBuckets.map((b) => `${b.slice(0, 8)}…`).join("、")}{c.ipsNorm.length ? `　网络：${c.ipsNorm.join("、")}` : ""}</p>}

                  <div className="probe-sub">命中信号（管理员判断的主要依据）</div>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18, display: "grid", gap: 4, fontSize: 13 }}>
                    {c.signals.map((s, i) => (
                      <li key={i}><b>{s.code}</b>（{s.weight} × {s.strength.toFixed(2)}）：{s.evidence}</li>
                    ))}
                    {c.reverse.map((r, i) => (
                      <li key={"r" + i} style={{ color: "var(--ok)" }}><b>{r.code}</b>：{r.evidence}</li>
                    ))}
                  </ul>

                  <details className="done-fold" style={{ marginTop: 10 }}>
                    <summary>时间线（{c.timeline.length} 条 · 等宽字体看间隔与 IP 跳变）</summary>
                    <div className="fold-body">
                      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12 }}>
                        <tbody>
                          {c.timeline.map((t, i) => (
                            <tr key={i}>
                              <td style={{ padding: "3px 10px", color: "var(--muted)", whiteSpace: "nowrap" }}>{fmt(t.at)}</td>
                              <td style={{ padding: "3px 10px" }}>{shortVid(t.voterId)}…</td>
                              <td style={{ padding: "3px 10px" }}>{t.candidate}</td>
                              <td style={{ padding: "3px 10px", color: "var(--muted)" }}>{t.ip}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>

                  <details className="done-fold" style={{ marginTop: 6 }}>
                    <summary>影响量化（该簇作废后 · 切线 {c.impact.cutLine} 票 · 同票 {c.impact.tiedAtCutLine} 人）</summary>
                    <div className="fold-body">
                      {c.impact.affected.length === 0 ? <p className="hint">该簇投票不影响任何角色的票数。</p> : (
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                          <thead>
                            <tr style={{ textAlign: "left", color: "var(--muted)", fontSize: 12 }}>
                              <th style={{ padding: "4px 10px" }}>角色</th><th style={{ padding: "4px 10px" }}>票数</th><th style={{ padding: "4px 10px" }}>排名</th><th style={{ padding: "4px 10px" }}>跨线</th>
                            </tr>
                          </thead>
                          <tbody>
                            {c.impact.affected.map((a) => (
                              <tr key={a.candidateId} style={a.crossesCut === "in→out" ? { background: "var(--rose-soft)", fontWeight: 700 } : undefined}>
                                <td style={{ padding: "4px 10px" }}>{a.nameCn}</td>
                                <td style={{ padding: "4px 10px", fontVariantNumeric: "tabular-nums" }}>{a.votesBefore} → {a.votesAfter}</td>
                                <td style={{ padding: "4px 10px", fontVariantNumeric: "tabular-nums" }}>#{a.rankBefore} → #{a.rankAfter}</td>
                                <td style={{ padding: "4px 10px" }}>{a.crossesCut === "in→out" ? "⚠ 掉出晋级线" : a.crossesCut === "out→in" ? "↗ 进入晋级线" : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </details>

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                    <button className="btn" disabled={busy} onClick={() => toggle(c.id)}>{selected.has(c.id) ? "取消勾选" : "勾选"}</button>
                    <button className="btn" disabled={busy || c.reviewed} onClick={async () => { await markReviewed(true); }}>标记已复核</button>
                  </div>
                </div>
              ))}
              </>
              );
            })()}
            </>
          )}
        </>)}
      </div>

      {msg && <div className={"msg " + (msg.ok ? "ok" : "err")}>{msg.t}</div>}
      <div className="foot"><a href="/admin">← 返回控制台</a>
        <div className="foot-oss">异常投票检测为只读建议：作废是不可撤销的真删操作，作废前会自动保存数据快照。</div>
      </div>
    </main>
  );
}
