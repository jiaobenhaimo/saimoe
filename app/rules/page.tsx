export const metadata = { title: "赛制介绍 · Bangumi 世萌大会" };

export default function Rules() {
  return (
    <main className="wrap">
      <h1 className="title" style={{ fontSize: 30 }}>赛制介绍</h1>
      <p className="subtitle">世萌大会分三个阶段，从提名池一路淘汰，选出本届最萌角色。</p>

      <div className="card">
        <h3>① 预选提名</h3>
        <p className="rules-p">任何人都可以把喜欢的角色加入提名池：搜角色名单个提名、搜作品名一次导入整部作品的全体角色，或手动添加。</p>
        <p className="rules-p">每个人可以给<b>任意多个</b>角色投提名票，但<b>每个角色只能投一票</b>（可随时改投或撤票）。提名截止时，按票数取前 N 名进入小组赛。</p>
      </div>

      <div className="card">
        <h3>② 小组赛（循环赛）</h3>
        <p className="rules-p">晋级角色被均分成若干小组；组内两两对战，你在每场对战里投给其中一方（每场一票，可改可撤）。</p>
        <p className="rules-p">按胜场数排名（同分看总得票），每组取前几名晋级淘汰赛。晋级总数必须是 2 的幂（如 8、16)，这样淘汰赛不会出现轮空。</p>
      </div>

      <div className="card">
        <h3>③ 单败淘汰赛</h3>
        <p className="rules-p">晋级角色按种子排入对阵表，一对一捉对厮杀。每一轮结算后，胜者进入下一轮，败者淘汰，直到决赛决出<b>总冠军</b>。</p>
      </div>

      <div className="card">
        <h3>关于投票与公平</h3>
        <p className="rules-p">投票以<b>设备</b>去重（不看公网 IP，同一网络下的不同设备可以各投一票）。这是尽力而为的防刷方式，并非绝对严格。</p>
        <p className="rules-p">若开启了定时赛程，各阶段会在设定的截止时间自动推进；提名人数不足时会自动顺延若干天，后续赛程也随之顺延。当前截止时间显示在投票页顶部。</p>
      </div>

      <div className="foot"><a href="/">← 返回投票页</a></div>
    </main>
  );
}
