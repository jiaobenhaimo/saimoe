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

  const [title, setTitle] = useState("Bangumi 世萌大会 2026");
  const [size, setSize] = useState(16);
  const [groups, setGroups] = useState(4);
  const [advance, setAdvance] = useState(2);

  // schedule inputs
  const [nomLocal, setNomLocal] = useState("");
  const [gHours, setGHours] = useState(48);
  const [rHours, setRHours] = useState(24);
  const [pDays, setPDays] = useState(2);

  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");

  // 网络诊断
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState<any>(null);

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
    if (comp) { setEditTitle(comp.title || ""); setEditDesc(comp.description || ""); }
  }, [comp?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const qualifiers = groups * advance;
  const pow2 = qualifiers >= 2 && (qualifiers & (qualifiers - 1)) === 0;

  return (
    <main className="wrap admin">
      <div className="eyebrow">Admin</div>
      <h1 className="title" style={{ fontSize: 30 }}>赛事控制台</h1>
      <p className="subtitle">推进比赛阶段。所有操作需要管理员令牌（环境变量 <code>ADMIN_TOKEN</code>)。</p>

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
              {comp.groupsCount ? ` · ${comp.groupsCount} 组，每组取 ${comp.advancePerGroup}` : ""}
            </p>
            {phase === "nomination" && comp.nomEndsAt && <p className="hint" style={{ marginBottom: 0 }}>已定时：提名将于 <b>{fmtAbs(comp.nomEndsAt)}</b> 截止；人数不足顺延 {comp.postponeDays} 天。</p>}
            {phase === "group" && comp.groupEndsAt && <p className="hint" style={{ marginBottom: 0 }}>小组赛将于 <b>{fmtAbs(comp.groupEndsAt)}</b> 自动结算。</p>}
            {phase === "knockout" && comp.koRoundEndsAt && <p className="hint" style={{ marginBottom: 0 }}>本轮将于 <b>{fmtAbs(comp.koRoundEndsAt)}</b> 自动推进。</p>}
          </>
        ) : <p style={{ margin: 0, color: "var(--muted)" }}>暂无比赛。</p>}
      </div>

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
            <div className="field"><label>参赛人数</label>
              <input type="number" value={size} onChange={(e) => setSize(+e.target.value)} /></div>
            <div className="field"><label>小组数</label>
              <input type="number" value={groups} onChange={(e) => setGroups(+e.target.value)} /></div>
            <div className="field"><label>每组晋级</label>
              <input type="number" value={advance} onChange={(e) => setAdvance(+e.target.value)} /></div>
          </div>
          {!pow2 && <p className="hint" style={{ color: "var(--rose-deep)" }}>晋级总数 {qualifiers} 需为 2 的幂（如 4 / 8 / 16)。</p>}

          <button className="btn solid" disabled={busy || !pow2}
            onClick={() => act("start_groups", { size, groups, advance })}>立即开始（取前 {size} 名，分 {groups} 组）</button>

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
          <button className="btn solid" disabled={busy || !pow2 || !nomLocal}
            onClick={() => act("schedule", { nomEndsAt: nomLocal ? new Date(nomLocal).getTime() : 0, size, groups, advance, groupHours: gHours, roundHours: rHours, postponeDays: pDays })}>
            启动定时赛程
          </button>
          {comp.nomEndsAt && <p className="hint">已定时（截止 {fmtAbs(comp.nomEndsAt)}）。<a onClick={() => act("unschedule")}>取消定时</a></p>}
        </div>
      )}

      {phase === "group" && (
        <div className="card">
          <h3>③ 结束小组赛，开淘汰赛</h3>
          <p className="hint">按当前票数结算每组名次，晋级者进入单败淘汰赛。{comp.groupEndsAt ? "（已定时，也可在此手动提前）" : ""}</p>
          <button className="btn solid" disabled={busy} onClick={() => act("start_knockout")}>结算小组赛 → 生成淘汰赛</button>
        </div>
      )}

      {phase === "knockout" && (
        <div className="card">
          <h3>④ 推进淘汰赛一轮</h3>
          <p className="hint">按当前票数结算本轮，生成下一轮；打到只剩 1 人时产生冠军。{comp.koRoundEndsAt ? "（已定时，也可在此手动提前）" : ""}</p>
          <button className="btn solid" disabled={busy} onClick={() => act("advance")}>结算本轮 → 下一轮 / 决出冠军</button>
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

      <div className="card">
        <h3>危险操作</h3>
        <p className="hint">删除当前比赛及其全部数据，无法撤销。</p>
        <button className="btn" disabled={busy} onClick={() => { if (confirm("确认删除当前比赛？")) act("reset"); }}>重置 / 删除当前比赛</button>
      </div>

      {msg && <div className={"msg " + (msg.ok ? "ok" : "err")}>{msg.t}</div>}
      <div className="foot"><a href="/">← 返回投票页</a></div>
    </main>
  );
}
