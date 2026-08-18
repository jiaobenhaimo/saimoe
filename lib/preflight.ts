import { readDbRO, topLevel, nominationTally, jpFlaggedCount, breakOf, type Competition, type DB } from "./db";

/**
 * 开赛前检查（preflight）。
 *
 * 提名期结束、要开小组赛的那一刻，是整届比赛里最容易出事的地方：一旦分组落定并生成对阵，
 * 想改就得靠「撤回上一步」层层回退，而票已经在动了。所以把所有会导致翻车的条件集中在
 * 一处，在**还能改**的时候一次性摊开给运营看，而不是等 startGroups 抛出一句错误。
 *
 * 每一项都写清「为什么这是个问题」和「怎么办」，因为真正会看这个面板的人是在赛前紧张地
 * 逐条排查，而不是在读源码。
 *
 * 三个等级：
 *   fail — 现在开赛一定会失败或产生错误赛程，必须处理。
 *   warn — 能开，但很可能不是你想要的结果（比如一堆角色没有中文名就进了小组赛）。
 *   ok   — 已就绪。
 */
export type Level = "ok" | "warn" | "fail";
export interface Check {
  id: string;
  level: Level;
  title: string;
  /** 现状。 */
  detail: string;
  /** 该怎么办（fail/warn 才有）。 */
  fix?: string;
}
export interface Preflight {
  phase: string;
  /** 整体是否可以开赛（没有 fail）。 */
  ready: boolean;
  fails: number;
  warns: number;
  checks: Check[];
  /** 按当前配置推算出来的赛制形状，让运营开赛前就能确认「是不是我想要的」。 */
  shape: {
    qualifying: number;      // 达到最低提名票的可参赛角色数
    targetSize: number;      // 计划取前 N 名
    actualSize: number;      // 含并列全取后的实际参赛数
    groupSize: number;       // 每组人数
    groups: number;          // 组数
    autoAdvance: number;     // 各组前 2 名直接晋级
    koTarget: number;        // 淘汰赛规模（2 的幂）
    fillNeeded: number;      // 需要补位的名额
    matchdays: number;       // 小组赛比赛日数（approval 模式）
    mode: string;
  } | null;
}

function nextPow2(n: number): number { let p = 1; while (p < n) p <<= 1; return Math.max(2, p); }

/** 并列全取后的实际参赛人数：凑满 size，但与第 size 名同票的一并纳入。 */
function actualQualifiers(votes: number[], size: number): number {
  if (votes.length < size || size <= 0) return votes.length;
  const cutoff = votes[size - 1];
  return votes.filter((v) => v >= cutoff).length;
}

export function preflight(cid: number): Preflight {
  const db: DB = readDbRO();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return { phase: "none", ready: false, fails: 1, warns: 0, shape: null, checks: [{ id: "comp", level: "fail", title: "没有比赛", detail: "还没有创建比赛。", fix: "先在上方创建一届比赛。" }] };

  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  // ── 参赛规模：能不能凑出一个完整的淘汰赛 ────────────────────────────────────
  const { total: nomTotal } = nominationTally(db, cid);
  const cands = topLevel(db, cid);
  const minVotes = comp.nom_min_votes ?? 0;
  const votes = cands.map((c) => nomTotal.get(c.id) || 0).filter((v) => v >= minVotes).sort((a, b) => b - a);
  const qualifying = votes.length;
  const targetSize = comp.auto_size || comp.target_size || 0;

  let shape: Preflight["shape"] = null;
  if (targetSize >= 4) {
    const actualSize = actualQualifiers(votes, targetSize);
    const G = Math.max(2, Math.floor(comp.group_size ?? 4));
    const groups = Math.max(1, Math.floor((actualSize - (actualSize % G)) / G));
    const koTarget = nextPow2(2 * groups);
    const perDay = comp.groups_per_day && comp.groups_per_day > 0 ? comp.groups_per_day : 2;
    shape = {
      qualifying, targetSize, actualSize, groupSize: G, groups,
      autoAdvance: 2 * groups, koTarget, fillNeeded: Math.max(0, koTarget - 2 * groups),
      matchdays: Math.max(1, Math.ceil(groups / perDay)),
      mode: (comp.group_mode ?? "approval") === "rr" ? "循环赛（1v1）" : "投票晋级（组内 2 票）",
    };

    if (qualifying < targetSize) {
      add({ id: "size", level: "fail", title: "可参赛角色不足",
        detail: `计划取前 ${targetSize} 名，但达到最低提名票（${minVotes || 0}）的角色只有 ${qualifying} 个。`,
        fix: "调低「参赛人数」或「最低提名票」，或让提名期再顺延几天。到点时人数不够，调度器会自动顺延而不是开赛。" });
    } else if (actualSize < koTarget) {
      add({ id: "bracket", level: "fail", title: "凑不出完整的淘汰赛",
        detail: `${actualSize} 人分 ${groups} 组，各组前 2 名共 ${2 * groups} 人，但淘汰赛需要 ${koTarget} 强，补位人数不足。`,
        fix: `把参赛人数提到 ${koTarget} 以上，或把每组人数调大（组数变少，淘汰赛规模就变小）。` });
    } else {
      add({ id: "bracket", level: "ok", title: "赛制可以凑齐",
        detail: `${actualSize} 人 → ${groups} 组 × ${shape.groupSize} 人 → ${2 * groups} 人直接晋级 + ${shape.fillNeeded} 个补位 = ${koTarget} 强。` });
    }

    if (actualSize > targetSize) {
      add({ id: "ties", level: "warn", title: "存在并列，实际参赛人数会多于计划",
        detail: `计划 ${targetSize} 人，因第 ${targetSize} 名有并列，实际会有 ${actualSize} 人参赛。`,
        fix: "这是既定规则（并列全取），确认过就行；若不希望如此，可微调「参赛人数」避开并列点。" });
    }
    // 每组固定取前 2 名晋级，与每组人数无关。6 人组意味着淘汰率 4/6，人数越多淘汰越狠 ——
    // 这不是错误，但运营多半想确认一下自己知道。
    if (shape.groupSize >= 6) {
      add({ id: "cut", level: "warn", title: "每组淘汰比例偏高",
        detail: `每组 ${shape.groupSize} 人、只取前 2 名，意味着每组淘汰 ${shape.groupSize - 2} 人（${Math.round((1 - 2 / shape.groupSize) * 100)}%）。`,
        fix: "这是既定规则（组内 2 票取前二），确认过即可；想放宽淘汰率就把每组人数调小。" });
    }
    if (actualSize % shape.groupSize !== 0) {
      add({ id: "remainder", level: "warn", title: "人数不能整除每组人数",
        detail: `${actualSize} 人 ÷ 每组 ${shape.groupSize} 人有余数，余下 ${actualSize % shape.groupSize} 人会补进最弱的几个组，那些组变成 ${shape.groupSize + 1} 人。`,
        fix: "接受即可（弱组多一人），或调整参赛人数/每组人数让它整除。" });
    }
  } else {
    add({ id: "size", level: "fail", title: "还没设定参赛人数",
      detail: "「参赛人数」为空或小于 4，无法推算分组与淘汰赛规模。",
      fix: "在「赛程设置与预览」里填好参赛人数、每组人数、比赛日节奏，再回来看这里。" });
  }

  // ── 自动推进：到点了有没有人来推 ────────────────────────────────────────────
  if (comp.phase === "nomination") {
    if (!comp.nom_ends_at) {
      add({ id: "nomEnd", level: "warn", title: "提名没有设截止时间",
        detail: "提名期不会自动结束，需要管理员手动点「结束提名 → 开小组赛」。",
        fix: "想自动开赛就在「赛程设置」里设一个提名截止时间；只手动操作则忽略此项。" });
    } else {
      add({ id: "nomEnd", level: "ok", title: "提名截止已设定",
        detail: `${new Date(comp.nom_ends_at).toLocaleString("zh-CN")} 自动结束提名。` });
    }
  }
  const pace = comp.group_round_days ?? 0, hrs = comp.round_hours ?? 0;
  if (!pace || !hrs) {
    add({ id: "pace", level: "warn", title: "赛程节奏不完整",
      detail: `小组赛${pace ? `每 ${pace} 天一个比赛日` : "**未设**每比赛日天数"}，淘汰赛${hrs ? `每轮 ${hrs} 小时` : "**未设**每轮时长"}。缺的那一段不会自动推进。`,
      fix: "在「赛程设置」里补上，或接受由管理员手动逐轮推进。" });
  } else {
    add({ id: "pace", level: "ok", title: "赛程节奏已设定",
      detail: `小组赛每 ${pace} 天一个比赛日${shape ? `（共 ${shape.matchdays} 个比赛日）` : ""}，淘汰赛每轮 ${hrs} 小时。` });
  }

  // ── 休赛期：留不留查票时间 ──────────────────────────────────────────────────
  const brk = breakOf(comp);
  if (brk.hours > 0) {
    add({ id: "break", level: "ok", title: "已预留休赛期",
      detail: `每轮结束后自动停投 ${brk.hours} 小时用于核对票数，之后才结算并开下一轮。` });
  } else {
    add({ id: "break", level: "warn", title: "没有预留休赛期",
      detail: "每轮一到点就立刻结算并开下一轮，中间没有查票时间。若结算后才发现刷票，需要作废并「按当前票数重算本轮」。",
      fix: "在下方「休赛期」里设几个小时（常用 6～12），系统会在每轮之间自动停投让你查票。" });
  }

  // ── 资料完整度：进了小组赛就会大量曝光 ──────────────────────────────────────
  // 只看**会真的参赛**的那批人（按提名票排在前 actualSize 名），而不是整个提名池：
  // 池底那些注定被淘汰的角色缺中文名，赛前没有任何修补价值。
  const ranked = [...cands]
    .map((c) => ({ c, v: nomTotal.get(c.id) || 0 }))
    .filter((x) => x.v >= minVotes)
    .sort((a, b) => b.v - a.v || a.c.id - b.c.id)
    .slice(0, shape ? shape.actualSize : cands.length)
    .map((x) => x.c);
  const noImage = ranked.filter((c) => !c.image).length;
  const noCn = ranked.filter((c) => !(c.name_cn || "").trim()).length;
  const noSubject = ranked.filter((c) => !(c.subject_name || c.subject_name_ja || "").trim()).length;
  if (ranked.length && (noImage || noCn || noSubject)) {
    add({ id: "data", level: "warn", title: "参赛角色资料有缺失",
      detail: `预计参赛的 ${ranked.length} 人中：缺头像 ${noImage}、缺中文名 ${noCn}、缺所属作品 ${noSubject}。`,
      fix: "用「资料缺失盘点」按票数从高到低补齐 —— 人气角色会被看得最多。缺名字时前端按「日语→中文→英语」回退，不会空白，但观感差。" });
  } else if (ranked.length) {
    add({ id: "data", level: "ok", title: "参赛角色资料完整",
      detail: `预计参赛的 ${ranked.length} 人都有头像、中文名与所属作品。` });
  }

  // ── 产地复核队列 ────────────────────────────────────────────────────────────
  const jpPending = jpFlaggedCount(cid);
  if (jpPending > 0) {
    add({ id: "jp", level: "warn", title: "还有角色等待产地复核",
      detail: `${jpPending} 个角色没查到「日本」标签，已提示提名者「管理员会复核」。`,
      fix: "在「产地复核」面板逐个放行或移除。开赛后移除角色会打乱分组，赶在开赛前处理掉。" });
  } else {
    add({ id: "jp", level: "ok", title: "产地复核已清空", detail: "没有待复核的角色。" });
  }

  // ── 刷票排查 ────────────────────────────────────────────────────────────────
  // 分组是按提名票排名定种子的，所以刷票不只是多几票的问题 —— 它会改变整张分组表。
  const nomVotes = db.nominationVotes.filter((v) => v.competition_id === cid);
  const withMeta = nomVotes.filter((v) => v.device_bucket || v.ip).length;
  const byBucket = new Map<string, Set<string>>();
  for (const v of nomVotes) {
    if (!v.device_bucket) continue;
    if (!byBucket.has(v.device_bucket)) byBucket.set(v.device_bucket, new Set());
    byBucket.get(v.device_bucket)!.add(v.voter_id);
  }
  const suspicious = [...byBucket.values()].filter((set) => set.size >= 3).length;
  if (suspicious > 0) {
    add({ id: "fraud", level: "warn", title: "有疑似刷票的设备簇",
      detail: `${suspicious} 个设备标识下出现了 ≥3 个投票身份。提名票决定种子与分组，刷票会直接改变整张分组表。`,
      fix: "开赛前到「异常投票检测」页面核对处理。分组一旦落定，作废提名票不会自动重排分组。" });
  } else {
    add({ id: "fraud", level: "ok", title: "未见明显刷票簇",
      detail: `${nomVotes.length} 张提名票（其中 ${withMeta} 张带去重元数据）。` });
  }

  // ── 备份 ────────────────────────────────────────────────────────────────────
  // 开赛是不可逆操作里最重的一步，出问题时唯一的退路就是快照。
  add({ id: "backup", level: "ok", title: "开赛前请确认有快照",
    detail: "系统每 30 分钟自动快照一次到 BACKUP_DIR。开小组赛会改写所有角色的分组与种子，撤回虽可用，但有快照才最保险。" });

  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  return { phase: comp.phase, ready: fails === 0, fails, warns, checks, shape };
}
