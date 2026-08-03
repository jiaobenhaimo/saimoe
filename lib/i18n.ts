// Trilingual dictionary (中文 / English / 日本語) for the public site.
// Pure module: only exports data + string helpers, safe to import anywhere.
export type Lang = "zh" | "en" | "ja";
export const LANGS: { code: Lang; label: string }[] = [
  { code: "zh", label: "中文" },
  { code: "en", label: "EN" },
  { code: "ja", label: "日本語" },
];

type Entry = { zh: string; en: string; ja: string };
const D: Record<string, Entry> = {
  "title": { zh: "世萌大会", en: "Saimoe Cup", ja: "世萌大会" },
  "subtitle": {
    zh: "为你喜爱的角色提名助威，从提名池一路投到总决赛。提名阶段可支持任意多个角色（每个角色一票）；对战阶段每场一票，均可随时改投或撤回。",
    en: "Nominate and cheer for your favorite characters — from the nominee pool all the way to the grand final. In the nomination phase you can back any number of characters (one vote each); in the battle phase it's one vote per match, changeable or retractable anytime.",
    ja: "好きなキャラを推薦して応援しよう。推薦プールから決勝まで投票できます。推薦段階では何体でも推薦可能（1キャラ1票）、対戦段階は1試合1票で、いつでも変更・取り消しできます。",
  },
  "rulesLink": { zh: "赛制介绍 →", en: "Rules →", ja: "ルール →" },
  "rules": { zh: "赛制介绍", en: "Rules", ja: "ルール" },
  "dataFrom": { zh: "数据来自 Bangumi", en: "Data from Bangumi", ja: "データ提供：Bangumi" },

  "phase.nomination": { zh: "预选提名", en: "Nomination", ja: "予選推薦" },
  "phase.group": { zh: "小组赛", en: "Group Stage", ja: "予選リーグ" },
  "phase.knockout": { zh: "淘汰赛", en: "Knockout", ja: "決勝T" },
  "phase.finished": { zh: "冠军", en: "Champion", ja: "優勝" },

  "dl.nomination": { zh: "提名截止", en: "Nomination ends", ja: "推薦締切" },
  "dl.group": { zh: "小组赛截止", en: "Group stage ends", ja: "リーグ締切" },
  "dl.knockout": { zh: "本轮截止", en: "Round ends", ja: "本ラウンド締切" },
  "dl.remain": { zh: "剩 {t}", en: "{t} left", ja: "残り {t}" },
  "dl.over": { zh: "已到时，正在处理…", en: "Time's up, processing…", ja: "締切、処理中…" },

  "unit.day": { zh: "天", en: "d", ja: "日" },
  "unit.hour": { zh: "小时", en: "h", ja: "時間" },
  "unit.min": { zh: "分", en: "m", ja: "分" },
  "unit.sec": { zh: "秒", en: "s", ja: "秒" },

  "err.load.title": { zh: "网络错误，无法加载赛况", en: "Network error: couldn't load", ja: "読み込みに失敗しました" },
  "err.load.body": { zh: "请检查云托管服务的网络配置，或稍后重试。", en: "Check the server's network settings, or try again later.", ja: "サーバーのネットワーク設定を確認するか、後で再試行してください。" },
  "common.retry": { zh: "重试", en: "Retry", ja: "再試行" },
  "disabled.title": { zh: "服务暂未开放", en: "Service unavailable", ja: "現在利用できません" },
  "disabled.body": { zh: "API 当前已禁用。请管理员设置环境变量 API_ENABLED=true 后重新部署。", en: "The API is disabled. Ask the admin to set API_ENABLED=true and redeploy.", ja: "APIが無効です。管理者に API_ENABLED=true の設定と再デプロイを依頼してください。" },
  "nocomp.title": { zh: "比赛还没开始", en: "No competition yet", ja: "開催前です" },
  "nocomp.body": { zh: "比赛尚未开始，敬请期待。", en: "The competition hasn't started yet. Stay tuned.", ja: "まだ開催されていません。お楽しみに。" },

  "nom.section": { zh: "提名角色", en: "Nominate characters", ja: "キャラを推薦" },
  "nom.ph.char": { zh: "输入角色名，提名单个角色", en: "Character name — nominate one", ja: "キャラ名で1体推薦" },
  "nom.ph.subject": { zh: "输入作品名，批量导入其全部角色", en: "Anime title — import all its characters", ja: "作品名で全キャラ取込" },
  "common.searching": { zh: "搜索中", en: "Searching", ja: "検索中" },
  "nom.searchChar": { zh: "搜角色", en: "Search", ja: "キャラ検索" },
  "nom.searchSubject": { zh: "搜作品", en: "Search anime", ja: "作品検索" },
  "nom.notFoundQ": { zh: "没有找到？", en: "Not found?", ja: "見つからない？" },
  "nom.manualAdd": { zh: "手动添加角色", en: "add manually", ja: "手動で追加" },
  "nom.noSubject": { zh: "没搜到作品，换个关键词。", en: "No anime found — try another keyword.", ja: "作品が見つかりません。別のキーワードで。" },
  "nom.noChar": { zh: "没搜到角色，换个词或手动添加。", en: "No character found — try another word or add manually.", ja: "キャラが見つかりません。別の語か手動追加で。" },
  "nom.importAll": { zh: "导入全体角色", en: "Import all", ja: "全キャラ取込" },
  "nom.subjectTag": { zh: "作品", en: "Anime", ja: "作品" },
  "nom.charTag": { zh: "角色", en: "Character", ja: "キャラ" },
  "nom.plus": { zh: "＋ 提名", en: "＋ Nominate", ja: "＋ 推薦" },
  "nom.manualTitle": { zh: "手动添加角色", en: "Add character manually", ja: "手動でキャラ追加" },
  "nom.nameRequired": { zh: "角色名（必填）", en: "Name (required)", ja: "名前（必須）" },
  "nom.imgOptional": { zh: "图片链接（可选）", en: "Image URL (optional)", ja: "画像URL（任意）" },
  "nom.addToPool": { zh: "加入提名池", en: "Add to pool", ja: "プールに追加" },
  "nom.poolTitle": { zh: "提名池 · 人气预选", en: "Nominee pool · popularity", ja: "推薦プール · 人気予選" },
  "nom.countSuffix": { zh: "个角色", en: "characters", ja: "体" },
  "nom.limitOn": { zh: "每人最多提名 {n} 个 · 已用 {x}/{n}", en: "Up to {n} per person · used {x}/{n}", ja: "1人{n}体まで · 使用 {x}/{n}" },
  "nom.limitOff": { zh: "提名不限个数（每个角色一票）", en: "Unlimited nominations (one vote per character)", ja: "推薦数は無制限（1キャラ1票）" },
  "nom.minVotes": { zh: " · 进入小组赛需 ≥ {n} 提名票", en: " · Need ≥ {n} votes to reach group stage", ja: " · リーグ進出に{n}票以上" },
  "nom.empty": { zh: "还没有提名，添加一个角色开个头吧。", en: "No nominees yet — add one to get started.", ja: "まだ推薦がありません。1体追加してみましょう。" },
  "nom.voteLabel": { zh: "提名", en: "noms", ja: "推薦" },
  "nom.voted": { zh: "已投", en: "Voted", ja: "投票済" },
  "nom.vote": { zh: "投一票", en: "Vote", ja: "投票" },
  "nom.remove": { zh: "移除", en: "Remove", ja: "削除" },

  "search.fail": { zh: "在线搜索失败（{err}），可手动添加。", en: "Online search failed ({err}); you can add manually.", ja: "オンライン検索に失敗（{err}）。手動追加できます。" },
  "subject.fail": { zh: "作品搜索失败：{err}", en: "Anime search failed: {err}", ja: "作品検索に失敗：{err}" },
  "subject.neterr": { zh: "作品搜索网络错误。", en: "Anime search network error.", ja: "作品検索でネットワークエラー。" },
  "net.err": { zh: "网络错误，可手动添加。", en: "Network error; add manually.", ja: "ネットワークエラー。手動追加できます。" },
  "import.progress": { zh: "正在导入《{name}》的角色…", en: "Importing characters from \u201C{name}\u201D…", ja: "『{name}』のキャラを取込中…" },
  "import.fail": { zh: "导入失败：{err}", en: "Import failed: {err}", ja: "取込に失敗：{err}" },
  "import.done": { zh: "《{name}》导入完成：新增 {added} / 共 {imported} 个角色", en: "\u201C{name}\u201D imported: {added} new / {imported} total", ja: "『{name}』取込完了：新規 {added} / 全 {imported} 体" },

  "group.title": { zh: "小组赛 · 循环对战", en: "Group Stage · round robin", ja: "予選リーグ · 総当たり" },
  "group.advance": { zh: "每组前 {n} 名晋级", en: "Top {n} per group advance", ja: "各組上位{n}名が進出" },
  "group.matchday": { zh: "第 {d}/{n} 比赛日", en: "Matchday {d}/{n}", ja: "第{d}/{n}試合日" },
  "match.upcoming": { zh: "未开始（等待对应比赛日）", en: "Upcoming (waiting for its matchday)", ja: "未開始（試合日待ち）" },
  "group.letter": { zh: "{L} 组", en: "Group {L}", ja: "{L}組" },
  "th.rank": { zh: "#", en: "#", ja: "#" },
  "th.char": { zh: "角色", en: "Character", ja: "キャラ" },
  "th.win": { zh: "胜", en: "W", ja: "勝" },
  "th.votes": { zh: "得票", en: "Votes", ja: "得票" },

  "champ.tag": { zh: "本届世萌总冠军", en: "Grand Champion", ja: "優勝" },
  "ko.title": { zh: "淘汰赛 · 单败晋级", en: "Knockout · single elimination", ja: "決勝トーナメント · 一発勝負" },
  "ko.hint": { zh: "点选对阵格查看详情并投票", en: "Tap a match to view details & vote", ja: "対戦をタップして詳細・投票" },
  "ko.detail": { zh: "对战详情", en: "Match detail", ja: "対戦詳細" },
  "round.final": { zh: "决赛", en: "Final", ja: "決勝" },
  "round.semi": { zh: "半决赛", en: "Semifinal", ja: "準決勝" },
  "round.quarter": { zh: "四分之一决赛", en: "Quarterfinal", ja: "準々決勝" },
  "round.top": { zh: "{n} 强", en: "Top {n}", ja: "ベスト{n}" },

  "match.advance": { zh: "晋级", en: "Advance", ja: "進出" },
  "match.vs": { zh: "VS", en: "VS", ja: "VS" },
  "match.rateNote": { zh: "赛中仅显示得票率，结算后公布票数", en: "Only vote share shown during the match; counts revealed after", ja: "試合中は得票率のみ、確定後に票数を公開" },
  "match.settled": { zh: "本场已结算 · 得票已公布", en: "Settled · counts revealed", ja: "確定 · 票数公開済" },

  "cmt.collapse": { zh: "收起评论", en: "Hide comments", ja: "コメントを隠す" },
  "cmt.open": { zh: "评论", en: "Comments", ja: "コメント" },
  "cmt.name": { zh: "昵称（可选）", en: "Name (optional)", ja: "名前（任意）" },
  "cmt.text": { zh: "友善发言…", en: "Be kind…", ja: "やさしくどうぞ…" },
  "cmt.send": { zh: "发送", en: "Send", ja: "送信" },
  "cmt.loading": { zh: "加载中…", en: "Loading…", ja: "読み込み中…" },
  "cmt.empty": { zh: "还没有评论，来抢沙发。", en: "No comments yet — be the first.", ja: "コメントはまだありません。" },
  "cmt.anon": { zh: "匿名", en: "Anonymous", ja: "匿名" },
  "cmt.sendFail": { zh: "发送失败，请重试。", en: "Send failed, please retry.", ja: "送信に失敗しました。" },

  // rules page
  "rules.title": { zh: "赛制介绍", en: "Format & Rules", ja: "ルール説明" },
  "rules.subtitle": { zh: "世萌大会分三个阶段，从提名池一路淘汰，选出本届最萌角色。", en: "The Saimoe Cup runs in three phases, narrowing the nominee pool down to this season's most moe character.", ja: "世萌大会は3段階制。推薦プールから勝ち抜き、今期の最萌キャラを決めます。" },
  "rules.s1.h": { zh: "① 预选提名", en: "① Nomination", ja: "① 予選推薦" },
  "rules.s1.p1": { zh: "任何人都可以把喜欢的角色加入提名池：搜角色名单个提名、搜作品名一次导入整部作品的全体角色，或手动添加。", en: "Anyone can add characters to the nominee pool: search a character to nominate one, search an anime to import all its characters at once, or add manually.", ja: "誰でも好きなキャラをプールに追加できます：キャラ名で個別推薦、作品名で全キャラ一括取込、または手動追加。" },
  "rules.s1.p2": { zh: "每个人可以给任意多个角色投提名票，但每个角色只能投一票（可随时改投或撤票）。提名截止时，按票数取前 N 名进入小组赛。", en: "You may nominate any number of characters, but only one vote per character (changeable/retractable anytime). When nomination closes, the top N by votes advance to the group stage.", ja: "何体でも推薦できますが、1キャラにつき1票（いつでも変更・取消可）。推薦締切時、得票上位N体が予選リーグへ。" },
  "rules.s2.h": { zh: "② 小组赛（循环赛）", en: "② Group Stage (round robin)", ja: "② 予選リーグ（総当たり）" },
  "rules.s2.p1": { zh: "晋级角色被均分成若干小组；组内两两对战，你在每场对战里投给其中一方（每场一票，可改可撤）。", en: "Advancing characters are split evenly into groups; within a group everyone plays everyone, and you vote for one side per match (one vote each, changeable/retractable).", ja: "進出キャラを均等に組分けし、組内で総当たり。各対戦で片方に投票します（1試合1票、変更・取消可）。" },
  "rules.s2.p2": { zh: "按胜场数排名（同分看总得票），每组取前几名晋级淘汰赛。晋级总数必须是 2 的幂（如 8、16），这样淘汰赛不会出现轮空。", en: "Ranked by wins (ties broken by total votes); the top few per group advance. The total advancing must be a power of two (e.g. 8, 16) so the bracket has no byes.", ja: "勝ち数で順位付け（同数は総得票）。各組上位が進出。進出総数は2のべき乗（例：8、16）で、不戦勝が出ないようにします。" },
  "rules.s3.h": { zh: "③ 单败淘汰赛", en: "③ Single-elimination knockout", ja: "③ 一発勝負トーナメント" },
  "rules.s3.p1": { zh: "晋级角色按种子排入对阵表，一对一捉对厮杀。每一轮结算后，胜者进入下一轮，败者淘汰，直到决赛决出总冠军。", en: "Advancing characters are seeded into a bracket for one-on-one matches. After each round the winner advances and the loser is out, until the final crowns the grand champion.", ja: "進出キャラをシードして対戦表へ。1対1で対戦し、各ラウンドの勝者が進出、敗者は敗退。決勝で優勝が決まります。" },
  "rules.s4.h": { zh: "关于投票与公平", en: "Voting & fairness", ja: "投票と公平性について" },
  "rules.s4.p1": { zh: "投票以设备去重（不看公网 IP，同一网络下的不同设备可以各投一票）。这是尽力而为的防刷方式，并非绝对严格。", en: "Votes are de-duplicated per device (not by public IP — different devices on the same network can each vote). This is a best-effort anti-fraud measure, not a strict guarantee.", ja: "投票は端末単位で重複排除（公開IPは見ません。同一回線でも別端末なら各1票）。ベストエフォートの不正対策で、厳密ではありません。" },
  "rules.s4.p2": { zh: "若开启了定时赛程，各阶段会在设定的截止时间自动推进；提名人数不足时会自动顺延若干天，后续赛程也随之顺延。当前截止时间显示在投票页顶部。", en: "If a timed schedule is enabled, each phase advances automatically at its deadline; if nominees are too few, it postpones a few days and later phases shift accordingly. The current deadline is shown at the top of the voting page.", ja: "自動スケジュールが有効な場合、各段階は締切時刻に自動進行します。推薦数が不足すると数日延期し、後続日程もずれます。現在の締切は投票ページ上部に表示。" },
  "rules.back": { zh: "← 返回投票页", en: "← Back to voting", ja: "← 投票ページへ戻る" },
};

export function t(lang: Lang, key: string, p?: Record<string, string | number>): string {
  const e = D[key];
  let s = e ? (e[lang] || e.zh) : key;
  if (p) for (const k in p) s = s.split("{" + k + "}").join(String(p[k]));
  return s;
}

/** Translate a round-label code from the server ("final"/"semi"/"quarter"/"top:N"). */
export function roundLabelT(lang: Lang, code: string): string {
  if (code === "final") return t(lang, "round.final");
  if (code === "semi") return t(lang, "round.semi");
  if (code === "quarter") return t(lang, "round.quarter");
  if (code.startsWith("top:")) return t(lang, "round.top", { n: code.slice(4) });
  return code;
}
