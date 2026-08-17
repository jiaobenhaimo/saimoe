# Bangumi SML

基于 Bangumi 角色的三阶段人气竞赛：**预选提名 → 小组循环赛 → 单败淘汰赛**，决出总冠军。

- 角色数据在**浏览器端**直接调用 Bangumi API（CORS 直连），提名时抓取中文名；服务端只负责存储、结算与调度，**零出站 HTTP**。
- 匿名投票：以**设备指纹**去重（不靠公网 IP，同一 NAT 下不同设备可各投一票），每场一票、可改可撤。
- Next.js(App Router)。**数据存本地 JSON 文件，无需任何外部数据库**。

## 快速开始

**Docker（推荐）** —— 一条命令跑起来，自带持久化 volume:

```bash
cp .env.example .env      # 至少改 ADMIN_TOKEN;确认 API_ENABLED=true
docker compose up -d --build
```

**本地开发：**

```bash
npm install
cp .env.example .env.local   # 设 ADMIN_TOKEN、API_ENABLED=true
npm run dev                  # http://localhost:3000
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `API_ENABLED` | 服务 API 总开关，**默认关闭**；必须设为 `true` 才对外提供服务（`/api/health` 不受影响） |
| `ADMIN_TOKEN` | 进入 `/admin` 和推进赛程的口令，设一段长随机串 |
| `DATA_DIR` | 数据文件目录。默认容器内 `./.data`（**临时**，重新部署会清空）；指到持久化挂载目录可长期保留 |
| `BACKUP_DIR` | 数据快照目录。默认 `/mnt/sml-data`；每 30 分钟把数据快照写到这里，建议指到持久化挂载盘 |
| `BACKUP_KEEP` | 保留的快照份数，默认 48（≈ 最近 24 小时） |

## 怎么玩

- 访客在 `/`：提名阶段搜角色 / 整部作品导入 / 手动添加，并投提名票；小组、淘汰阶段点角色投票。
- 管理员在 `/admin`（需 `ADMIN_TOKEN`）按顺序推进：
  1. 创建比赛 →（可随时**编辑名称 / 简介**）
  2. 结束提名 → 开小组赛：填参赛人数 / 小组数 / 每组晋级（**晋级总数须为 2 的幂**，如 4 组 × 2 = 8）
  3. 结算小组赛 → 生成淘汰赛（按票数定名次）
  4. 逐轮推进淘汰赛，直到决出冠军

## 部署

自托管到云服务器 / NAS(Docker)：见 [`DEPLOY_CN.md`](./DEPLOY_CN.md)。

镜像化直接用根目录 `Dockerfile`（多阶段构建，监听 80）。

## 数据与存储

数据是**容器本地的一个 JSON 文件**(`$DATA_DIR/saimoe.json`)，每次写操作同步落盘、原子替换；进程内按文件 mtime 缓存，避免重复读盘。含义：

- **必须单实例运行**：多个实例各写各的文件，数据不共享。
- 容器文件系统通常**易失**：不挂持久化卷时，重新部署 / 重启会清空数据。要长期保留，把 `DATA_DIR` 指到持久化挂载目录（云硬盘 / NAS / compose volume）。
- 适合中小规模人气投票；不适合超大规模高并发（整份数据每次读写全量 JSON）。

**自动备份**：进程每 30 分钟把数据快照到 `$BACKUP_DIR/saimoe-<时间戳>.json`（默认 `/mnt/sml-data`），保留最近 `BACKUP_KEEP` 份（默认 48，约 24 小时）。`BACKUP_DIR` 应指向持久化挂载盘（NAS / 云硬盘 / compose volume），快照可用于恢复——用某个快照覆盖 `saimoe.json` 再重启即可。不再依赖任何云存储。

## 结构

```
app/
  page.tsx            投票主页(按阶段渲染)
  admin/page.tsx      管理台
  api/state           GET  当前赛况(含本人投票)
  api/nominate        POST 提名 / 整部作品导入
  api/vote            POST 提名投票 / 对战投票
  api/admin/action    POST 赛程推进 + 编辑信息(需令牌)
  api/wx              GET/POST 微信公众号验签 + 被动回复(带专属投票链接)
  api/v               GET  公众号链接换取投票会话 cookie
  api/health          GET  健康检查(不读数据,探针用)
lib/
  db.ts               本地 JSON 存储(读改写 + 原子落盘)
  engine.ts           赛制引擎:分组、种子、结算、状态
  voter.ts            设备指纹 / cookie 投票身份
  flags.ts            服务 API 开关
  schedule.ts         定时赛程推进
  backup.ts           每 30 分钟数据快照
```

## 说明

- **平票 / 0-0** 结算时判给 A 方（`lib/engine.ts` 的 `decide()`）。
- **不支持轮空**，晋级总数要是 2 的幂（管理台会校验）。
- **提名清理**：用户加进池子但一直 0 提名票的自提名角色会被清理——关闭页面时前端 `pagehide` 立即清（`fetch(keepalive)` 带 `x-fp`），服务端 `runTick` 再按宽限期（`SAIMOE_ORPHAN_GRACE_MIN`，默认 30 分钟）兜底，防止崩溃/手机切后台漏掉。拿到 ≥1 票即永久保留。批量导入 / 管理员添加的角色（`nominated_at` 为空）不会被清。
- **防刷是尽力而为**：去重以浏览器指纹（`x-fp`）为准，不靠公网 IP。**同一台设备的不同浏览器会算作不同身份**——因为指纹含 UA/canvas/WebGL，跨浏览器必然不同，而 Safari/Brave/Firefox 还会主动随机化这些值；这在纯前端无法做到强保证，要硬性一人一票需接账号登录（如 Bangumi OAuth）。
- **去重元数据**：每条投票另存一个粗粒度 `device_bucket`（前端 `x-db`，仅用屏幕/时区/核数等跨浏览器稳定的低熵特征，不含 UA/canvas/WebGL）、客户端 `ip` 与 `created_at` 时间戳。它们**只作元数据供 /admin 运营看板检测与人工作废**,**绝不用于拦截或去重**。
- **运营可观测（/admin）**：异常投票看板（同设备多身份 / 同 IP 多身份 / 短时爆发 / 覆盖率异常四类信号，阈值见 `.env.example`，可一键作废某设备簇/IP/身份的全部票——作废后如该轮已结算需再点「按当前票数重算本轮」）、操作审计日志（记录每次管理操作）、赛程时间线预览（按当前节奏推算未来阶段时间）。

## 站点专属信息（不在仓库里）

联系方式、主办方、鸣谢与二维码图片属于**某一届活动**的内容，也含个人联系方式，因此不放进仓库，改由服务器上的未跟踪文件提供：

```
$DATA_DIR/site.json      # 文本内容，格式见 site.example.json
$DATA_DIR/site/*.png     # 二维码图片，由 /api/site/<文件名> 提供
```

每个字段可写成 `{zh, en, ja}` 三语对象，也可直接写字符串（等同只填中文）；缺哪种语言就按 **日语 → 中文 → 英语** 回退，与角色名一致。

没有这个文件时，规则页会自动隐藏「主办与鸣谢」整节与联系方式 —— clone 下来就是一个干净的通用版本。想换目录用 `SITE_DIR` 环境变量。

部署时（以 Fly 为例，数据卷挂在 `/data`）：

```bash
fly ssh sftp shell -a saimoe
put site.json /data/site.json
put qr-host.png /data/site/qr-host.png
```

## 许可

本项目以 **GNU GPL v3 或更高版本** 发布，完整条款见仓库根目录的 [LICENSE](./LICENSE)。

你可以自由使用、修改和分发本项目；若分发修改后的版本，请同样以 GPL 开源并保留原始版权与许可声明。
