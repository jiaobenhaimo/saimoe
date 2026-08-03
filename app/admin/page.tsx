"use client";

import { useCallback, useEffect, useState } from "react";

function fmtAbs(ms?: number | null): string {
  if (!ms) return "";
  try { return new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

export default function Admin() {
  const [token, setToken] = useState("");
  const [state, setState] = useState<any>(null);
  const [msg, setMsg] = useState<{ t: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [obs, setObs] = useState<any>(null);

  const [title, setTitle] = useState("Bangumi 世萌大会 2026");
  const [size, setSize] = useState(16);

  // schedule inputs
  const [nomLocal, setNomLocal] = useState("");
  const [gHours, setGHours] = useState(48);
  const [rHours, setRHours] = useState(24);
  const [pDays, setPDays] = useState(2);
  const [nUserLimit, setNUserLimit] = useState(0);
  const [nMinVotes, setNMinVotes] = useState(0);
  const [perRound, setPerRound] = useState(0);
  const [roundDays, setRoundDays] = useState(0);
  const [dlHours, setDlHours] = useState(24);
  const [paceDays, setPaceDays] = useState(1);
  const [paceHours, setPaceHours] = useState(24);

  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");

  // 网络诊断
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState<any>(null);

  // 调试模式
  const [dbgOn, setDbgOn] = useState(false);
  const [dbgBusy, setDbgBusy] = useState(false);
  const [dbgLog, setDbgLog] = useState<string[]>([]);
  const [dbgCount, setDbgCount] = useState(8);
  const [dbgVoters, setDbgVoters] = useState(30);
  useEffect(() => { fetch("/api/admin/debug").then((r) => r.json()).then((j) => setDbgOn(!!j.enabled)).catch(() => {}); }, []);
  const dbgAct = async (action: string, extra: Record<string, unknown> = {}) => {
    if (dbgBusy) return;
    setDbgBusy(true); localStorage.setItem("adminToken", token); setMsg(null); setDbgLog([]);
    try {
      const r = await fetch("/api/admin/debug", { method: "POST", headers: { "Content-Type": "application/json", "x-admin-token": token }, body: JSON.stringify({ action, ...extra }) });
      const j = await r.json();
      if (!r.ok) setMsg({ t: j.error || "调试失败", ok: false });
      else { if (j.log) setDbgLog(j.log); setMsg({ t: j.log ? `模拟完成(${j.log.length} 步)` : `调试 ${action} 完成`, ok: true }); }
      await load();
    } finally { setDbgBusy(false); }
  };

  useEffect(() => { setToken(localStorage.getItem("adminToken") || ""); }, []);

  const load = useCallback(async () => {
    const r = await fetch("/api/state", { cache: "no-store" });
    setState(await r.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    if (busy) return; // prevent double-submit
    setBusy(true);
    localStorage.setItem("adminToken", token);
    setMsg(null);
    try {
      const r = await fetch("/api/admin/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-token": token },
        body: JSON.stringify({ action, ...extra }),
      });
      const j = await r.json();
      if (!r.ok) setMsg({ t: j.error || "操作失败", ok: false });
      else setMsg({ t: j.message || "已执行：" + action, ok: true });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const loadObs = useCallback(async () => {
    const tk = token || localStorage.getItem("adminToken") || "";
    if (!tk) return;
    try {
      const r = await fetch("/api/admin/observe", { headers: { "x-admin-token": tk }, cache: "no-store" });
      if (r.ok) setObs(await r.json());
    } catch {}
  }, [token]);
  useEffect(() => { if (token) loadObs(); }, [token, loadObs]);
  const invalidate = async (by: string, key: string) => { await act("invalidate_votes", { by, key }); await loadObs(); };

  const ping = async () => {
    setPinging(true); setPingResult(null);
    try {
      const r = await fetch("/api/diag", { cache: "no-store" });
      setPingResult(await r.json());
    } catch (e: any) {
      setPingResult({ error: "请求失败：" + (e?.message || e) });
    } finally { setPinging(false); }
  };

  const downloadExport = async (format: "json" | "csv") => {
    try {
      const r = await fetch(`/api/admin/export?format=${format}`, { headers: { "x-admin-token": token } });
      if (!r.ok) { const j = await r.json().catch(() => ({})); setMsg({ t: j.error || "导出失败", ok: false }); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `saimoe-${comp?.id ?? "results"}.${format === "csv" ? "csv" : "json"}`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setMsg({ t: "导出失败：" + (e?.message || e), ok: false });
    }
  };

  const comp = state?.competition;
  const phase = comp?.phase;

  useEffect(() => {
    if (comp) { setEditTitle(comp.title || ""); setEditDesc(comp.description || ""); setNUserLimit(comp.nomUserLimit || 0); setNMinVotes(comp.nomMinVotes || 0); }
  }, [comp?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const estGroups = Math.max(1, Math.floor(size / 4));
  const estKo = (() => { let p = 1; const t = 2 * estGroups; while (p < t) p <<= 1; return Math.max(2, p); })();

  return (
    <main className="wrap admin">
      <div className="eyebrow">Admin</div>
      <h1 className="title" style={{ fontSize: 30 }}>赛事控制台</h1>
      <p className="subtitle">推进比赛阶段。所有操作需要管理员令牌（环境变量 <code>ADMIN_TOKEN</code>)。</p>

      <div className="admin-cards">
      <div className="card">
        <div className="field"><label>管理员令牌</label>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ADMIN_TOKEN" /></div>
      </div>

      <div className="card">
        <h3>当前状态</h3>
        {comp ? (
          <>
            <p style={{ margin: 0 }}>
              《{comp.title}》— 阶段：<b>{phase}</b>
              {comp.groupsCount ? ` · ${comp.groupsCount} 组 → ${comp.koTarget} 强` : ""}
            </p>
            {phase === "nomination" && comp.nomEndsAt && <p className="hint" style={{ marginBottom: 0 }}>已定时：提名将于 <b>{fmtAbs(comp.nomEndsAt)}</b> 截止；人数不足顺延 {comp.postponeDays} 天。</p>}
            {phase === "group" && comp.groupRoundEndsAt && <p className="hint" style={{ marginBottom: 0 }}>小组赛第 <b>{comp.groupMatchday}/{comp.groupMatchdayCount}</b> 比赛日将于 <b>{fmtAbs(comp.groupRoundEndsAt)}</b> 自动结算。</p>}
            {phase === "knockout" && comp.koRoundEndsAt && <p className="hint" style={{ marginBottom: 0 }}>本轮将于 <b>{fmtAbs(comp.koRoundEndsAt)}</b> 自动推进。</p>}
          </>
        ) : <p style={{ margin: 0, color: "var(--muted)" }}>暂无比赛。</p>}
      </div>

      {dbgOn && (
        <div className="card" style={{ borderColor: "var(--gold)", background: "#fffdf5" }}>
          <h3>🐞 调试模式</h3>
          <p className="hint">用假数据在几分钟内验证整条赛程。<b>仅在 DEBUG_MODE=true 时可用,上线前请关闭。</b>会新建一场比赛(成为当前比赛)。</p>
          <div className="row3">
            <div className="field"><label>角色/参赛数</label>
              <input type="number" min={2} value={dbgCount} onChange={(e) => setDbgCount(+e.target.value)} /></div>
            <div className="field"><label>模拟投票人数</label>
              <input type="number" min={1} value={dbgVoters} onChange={(e) => setDbgVoters(+e.target.value)} /></div>
            <div className="field"><label>&nbsp;</label>
              <button className="btn solid" disabled={dbgBusy} onClick={() => dbgAct("simulate", { count: dbgCount, groups: 2, advance: 2, voters: dbgVoters })}>一键模拟整届</button></div>
          </div>
          <hr className="sep" />
          <p className="hint">或分步来(配合上面的赛程按钮):</p>
          <div className="btnrow">
            <button className="btn" disabled={dbgBusy} onClick={() => dbgAct("seed", { count: dbgCount })}>① 造 {dbgCount} 个测试角色</button>
            <button className="btn" disabled={dbgBusy} onClick={() => dbgAct("nominate", { votes: dbgCount * 20 })}>② 灌提名票</button>
            <button className="btn" disabled={dbgBusy} onClick={() => dbgAct("vote", { voters: dbgVoters })}>③ 给当前开放对战灌票</button>
          </div>
          {dbgLog.length > 0 && <pre className="ping-result">{dbgLog.join("\n")}</pre>}
        </div>
      )}

      <div className="card">
        <h3>网络诊断（Ping）</h3>
        <p className="hint">检查容器能否解析并连通 Bangumi API（DNS + HTTPS）。若在线搜索失败，先在这里看 <code>api.reachable</code> 和 <code>dns</code> 的结果。</p>
        <button className="btn solid" disabled={busy || pinging} onClick={ping}>{pinging ? "检查中…" : "检查网络连接"}</button>
        {pingResult && <pre className="ping-result">{JSON.stringify(pingResult, null, 2)}</pre>}
      </div>

      {comp && (
        <div className="card">
          <h3>编辑比赛信息</h3>
          <div className="field"><label>比赛名称</label>
            <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} /></div>
          <div className="field"><label>简介 / 副标题（可选，显示在投票页标题下方）</label>
            <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)}
              placeholder="例如：2026 春季 · 由你决定最萌角色" /></div>
          <button className="btn solid" disabled={busy || !editTitle.trim()}
            onClick={() => act("update", { title: editTitle, description: editDesc })}>保存修改</button>
        </div>
      )}

      {(!comp || phase === "finished") && (
        <div className="card">
          <h3>① 创建新一届</h3>
          <div className="field"><label>标题</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <button className="btn solid" disabled={busy} onClick={() => act("create", { title })}>创建比赛（进入提名阶段）</button>
        </div>
      )}

      {phase === "nomination" && (
        <div className="card">
          <h3>② 结束提名 → 小组赛</h3>
          <div className="row3">
            <div className="field"><label>晋级人数(取前 N,含并列)</label>
              <input type="number" min={4} value={size} onChange={(e) => setSize(+e.target.value)} /></div>
            <div className="field" style={{ gridColumn: "span 2" }}><label>&nbsp;</label>
              <span className="hint">世界杯式:约 <b>{estGroups}</b> 个 4 人组(并列/余数可成 5 人组),各组前 2 + 最优第三名 → <b>{estKo}</b> 强淘汰赛。</span></div>
          </div>
          <div className="row3">
            <div className="field"><label>每组每轮场数（0=自动）</label>
              <input type="number" min={0} value={perRound} onChange={(e) => setPerRound(+e.target.value)} /></div>
            <div className="field"><label>每比赛日天数（0=手动）</label>
              <input type="number" min={0} value={roundDays} onChange={(e) => setRoundDays(+e.target.value)} /></div>
            <div className="field"><label>&nbsp;</label><span className="hint">同一角色一轮内不会重复出场</span></div>
          </div>
          <button className="btn solid" disabled={busy || size < 4}
            onClick={() => act("start_groups", { size, perRound, roundDays })}>立即开始(取前 {size} 名 → 约 {estGroups} 组 → {estKo} 强)</button>

          <hr className="sep" />
          <h3 style={{ fontSize: 15 }}>或：定时自动开赛</h3>
          <p className="hint">到设定的提名截止时间自动开小组赛；若届时提名人数不足 {size}，自动顺延若干天（后续赛程随之顺延）。</p>
          <div className="field"><label>提名截止时间</label>
            <input type="datetime-local" value={nomLocal} onChange={(e) => setNomLocal(e.target.value)} /></div>
          <div className="row3">
            <div className="field"><label>小组赛时长（小时）</label>
              <input type="number" value={gHours} onChange={(e) => setGHours(+e.target.value)} /></div>
            <div className="field"><label>每轮淘汰赛（小时）</label>
              <input type="number" value={rHours} onChange={(e) => setRHours(+e.target.value)} /></div>
            <div className="field"><label>人数不足顺延（天）</label>
              <input type="number" value={pDays} onChange={(e) => setPDays(+e.target.value)} /></div>
          </div>
          <button className="btn solid" disabled={busy || size < 4 || !nomLocal}
            onClick={() => act("schedule", { nomEndsAt: nomLocal ? new Date(nomLocal).getTime() : 0, size, groupHours: gHours, roundHours: rHours, groupPerRound: perRound, groupRoundDays: roundDays, postponeDays: pDays })}>
            启动定时赛程
          </button>
          {comp.nomEndsAt && <p className="hint">已定时（截止 {fmtAbs(comp.nomEndsAt)}）。<a onClick={() => act("unschedule")}>取消定时</a></p>}
        </div>
      )}

      {phase === "nomination" && (
        <div className="card">
          <h3>提名约束</h3>
          <p className="hint">限制每人可提名的角色数，并设置进入小组赛的最低提名票门槛（填 0 表示不限）。</p>
          <div className="row3">
            <div className="field"><label>每人提名上限</label>
              <input type="number" min={0} value={nUserLimit} onChange={(e) => setNUserLimit(+e.target.value)} /></div>
            <div className="field"><label>最低提名票</label>
              <input type="number" min={0} value={nMinVotes} onChange={(e) => setNMinVotes(+e.target.value)} /></div>
            <div className="field"><label>&nbsp;</label>
              <button className="btn solid" disabled={busy} onClick={() => act("nom_rules", { userLimit: nUserLimit, minVotes: nMinVotes })}>保存约束</button></div>
          </div>
        </div>
      )}

      {phase === "group" && (
        <div className="card">
          <h3>③ 小组赛比赛日</h3>
          <p className="hint">当前：第 <b>{comp.groupMatchday}/{comp.groupMatchdayCount}</b> 比赛日{comp.groupRoundEndsAt ? `（截止 ${fmtAbs(comp.groupRoundEndsAt)}）` : ""}；每组每轮 {comp.groupPerRound || "自动"} 场。</p>
          <button className="btn solid" disabled={busy} onClick={() => act("advance_group")}>结算本比赛日 → 下一比赛日</button>
          <hr className="sep" />
          <p className="hint">或直接结束整个小组赛（结算所有剩余比赛日并生成淘汰赛）：</p>
          <button className="btn" disabled={busy} onClick={() => act("start_knockout")}>结算小组赛 → 生成淘汰赛</button>
        </div>
      )}

      {phase === "playoff" && (
        <div className="card">
          <h3>③½ 第三名加赛</h3>
          <p className="hint">{state.playoff?.contenders ?? "?"} 名并列者进行循环赛,争夺最后 <b>{state.playoff?.slots ?? "?"}</b> 个晋级名额{comp.groupRoundEndsAt ? `(截止 ${fmtAbs(comp.groupRoundEndsAt)})` : ""}。</p>
          <button className="btn solid" disabled={busy} onClick={() => act("resolve_playoff")}>结算加赛 → 生成淘汰赛</button>
        </div>
      )}

      {phase === "knockout" && (
        <div className="card">
          <h3>④ 推进淘汰赛一轮</h3>
          <p className="hint">按当前票数结算本轮，生成下一轮；打到只剩 1 人时产生冠军。{comp.koRoundEndsAt ? "（已定时，也可在此手动提前）" : ""}</p>
          <button className="btn solid" disabled={busy} onClick={() => act("advance")}>结算本轮 → 下一轮 / 决出冠军</button>
        </div>
      )}

      {comp && phase !== "finished" && (
        <div className="card">
          <h3>赛程控制</h3>
          <p className="hint">
            直接设定 / 延长 / 清除<b>本阶段</b>（{phase === "nomination" ? "提名" : phase === "group" ? `小组赛第 ${comp.groupMatchday}/${comp.groupMatchdayCount} 比赛日` : "本淘汰轮"}）的截止时间，到点自动推进。
            当前截止：{(phase === "nomination" ? comp.nomEndsAt : phase === "group" ? comp.groupRoundEndsAt : comp.koRoundEndsAt) ? fmtAbs(phase === "nomination" ? comp.nomEndsAt : phase === "group" ? comp.groupRoundEndsAt : comp.koRoundEndsAt) : "无"}。
          </p>
          <div className="row3">
            <div className="field"><label>本阶段还剩（小时）</label>
              <input type="number" min={0} step={0.5} value={dlHours} onChange={(e) => setDlHours(+e.target.value)} /></div>
            <div className="field"><label>&nbsp;</label>
              <button className="btn solid" disabled={busy} onClick={() => act("set_deadline", { hours: dlHours })}>设定截止</button></div>
            <div className="field"><label>&nbsp;</label>
              <button className="btn" disabled={busy} onClick={() => act("set_deadline", { hours: 0 })}>清除截止</button></div>
          </div>
          {phase === "group" && (
            <div className="row3" style={{ marginTop: 8 }}>
              <div className="field"><label>后续每比赛日天数</label>
                <input type="number" min={0} step={0.5} value={paceDays} onChange={(e) => setPaceDays(+e.target.value)} /></div>
              <div className="field"><label>&nbsp;</label>
                <button className="btn" disabled={busy} onClick={() => act("set_pace", { groupRoundDays: paceDays })}>更新后续节奏</button></div>
              <div className="field"><label>&nbsp;</label><span className="hint">影响之后每个比赛日的自动截止</span></div>
            </div>
          )}
          {phase === "knockout" && (
            <div className="row3" style={{ marginTop: 8 }}>
              <div className="field"><label>后续每轮小时</label>
                <input type="number" min={0} value={paceHours} onChange={(e) => setPaceHours(+e.target.value)} /></div>
              <div className="field"><label>&nbsp;</label>
                <button className="btn" disabled={busy} onClick={() => act("set_pace", { roundHours: paceHours })}>更新后续节奏</button></div>
              <div className="field"><label>&nbsp;</label><span className="hint">影响之后每轮的自动截止</span></div>
            </div>
          )}
        </div>
      )}

      {phase === "nomination" && state?.nomination && (
        <div className="card">
          <h3>管理提名池</h3>
          <p className="hint">移除误加 / 重复的角色，会连同其提名票一起删除，无法撤销。</p>
          {state.nomination.pool.length === 0 ? <p className="hint">暂无提名。</p> : (
            <div className="pool-admin">
              {state.nomination.pool.map((p: any) => (
                <div className="prow" key={p.id}>
                  <div className="meta"><div className="nm">{p.nameCn || p.name}</div>{p.nameCn && p.nameCn !== p.name && <div className="sub">{p.name}</div>}</div>
                  <div className="votecell num"><div className="c">{p.votes}</div><div className="l">提名</div></div>
                  <button className="btn" disabled={busy} onClick={() => { if (confirm(`确认移除「${p.nameCn || p.name}」？`)) act("remove_candidate", { candidateId: p.id }); }}>移除</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {(phase === "group" || phase === "knockout" || phase === "finished") && (
        <div className="card">
          <h3>撤销 / 重算</h3>
          <p className="hint">撤回上一步阶段推进（回到上一阶段 / 上一轮），或按当前票数重算当前轮。谨慎使用。</p>
          <button className="btn" disabled={busy} onClick={() => act("undo")}>撤回上一步</button>{" "}
          <button className="btn" disabled={busy} onClick={() => act("resettle")}>按当前票数重算本轮</button>
        </div>
      )}

      {comp && (
        <div className="card">
          <h3>导出结果</h3>
          <p className="hint">导出当前比赛的赛况数据（JSON 为完整结构，CSV 为扁平表格）。</p>
          <button className="btn" disabled={busy} onClick={() => downloadExport("json")}>导出 JSON</button>{" "}
          <button className="btn" disabled={busy} onClick={() => downloadExport("csv")}>导出 CSV</button>
        </div>
      )}

      {comp && obs && (
        <div className="card">
          <h3>🛡️ 异常投票看板</h3>
          <p className="hint">
            共 {obs.totals?.votes ?? 0} 票(含元数据 {obs.totals?.withMeta ?? 0})、{obs.totals?.matches ?? 0} 场对局。
            阈值:同设备 ≥{obs.thresholds?.DEVICE_MIN} 身份 · 同 IP ≥{obs.thresholds?.IP_MIN} 身份 · {Math.round((obs.thresholds?.BURST_WINDOW_MS || 0) / 1000)}s 内 ≥{obs.thresholds?.BURST_MIN} 票 · 覆盖 ≥{Math.round((obs.thresholds?.COVERAGE_PCT || 0) * 100)}%。
            {" "}<a onClick={loadObs}>刷新</a>
          </p>
          {(!obs.flags || obs.flags.length === 0) ? (
            <p className="hint">未发现可疑模式 👍</p>
          ) : (
            <div className="pool-admin">
              {obs.flags.map((f: any) => (
                <div className="prow" key={f.type + ":" + f.key}>
                  <span className={"flagtag flag-" + f.type}>{f.type === "device" ? "设备" : f.type === "ip" ? "IP" : f.type === "burst" ? "爆发" : "覆盖"}</span>
                  <div className="meta"><div className="nm">{f.keyShort}{f.identities ? ` · ${f.identities} 身份` : ""} · {f.votes} 票</div><div className="sub">{f.detail}</div></div>
                  <button className="btn" disabled={busy} onClick={() => { if (confirm(`确认作废「${f.keyShort}」的全部票?不可撤销。若该轮已结算,请随后「按当前票数重算本轮」。`)) invalidate(f.by, f.key); }}>作废</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {comp && obs && obs.timeline && obs.timeline.length > 0 && (
        <div className="card">
          <h3>🗓️ 赛程时间线预览</h3>
          <p className="hint">按当前排程与节奏推算的预计时间点(仅预览,实际以自动/手动推进为准;“—”表示该步为手动或尚未设定节奏)。</p>
          <ul className="timeline">
            {obs.timeline.map((it: any, i: number) => (
              <li key={i}><span className="tl-at">{it.at ? fmtAbs(it.at) : "—"}</span><span className="tl-label">{it.label}</span>{it.note ? <span className="tl-note">{it.note}</span> : null}</li>
            ))}
          </ul>
        </div>
      )}

      {comp && obs && (
        <div className="card">
          <h3>🗂️ 操作审计日志</h3>
          <p className="hint">最近的管理操作(最多 200 条,倒序)。{" "}<a onClick={loadObs}>刷新</a></p>
          {(!obs.audit || obs.audit.length === 0) ? (
            <p className="hint">暂无记录。</p>
          ) : (
            <ul className="audit">
              {obs.audit.map((a: any) => (
                <li key={a.id}><span className="au-ts">{fmtAbs(a.ts)}</span><span className="au-sum">{a.summary}</span>{a.phase ? <span className="au-phase">{a.phase}</span> : null}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="card">
        <h3>危险操作</h3>
        <p className="hint">删除当前比赛及其全部数据，无法撤销。</p>
        <button className="btn" disabled={busy} onClick={() => { if (confirm("确认删除当前比赛？")) act("reset"); }}>重置 / 删除当前比赛</button>
      </div>

      </div>

      {msg && <div className={"msg " + (msg.ok ? "ok" : "err")}>{msg.t}</div>}
      <div className="foot"><a href="/">← 返回投票页</a></div>
    </main>
  );
}
