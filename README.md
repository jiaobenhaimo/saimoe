# Bangumi 世萌大会

基于 Bangumi 角色的三阶段人气竞赛:**预选提名 → 小组循环赛 → 单败淘汰赛**,决出总冠军。

- 角色数据由后端调用 Bangumi API(无 CORS),提名时自动抓取**简体中文名**;头像走后端代理绕过防盗链。
- 匿名投票:以**设备指纹**去重(不靠公网 IP,同一 NAT 下不同设备可各投一票),每场一票、可改可撤。
- Next.js(App Router)。**数据存本地 JSON 文件,无需任何外部数据库**。

## 快速开始

**Docker(推荐)** —— 一条命令跑起来,自带持久化 volume:

```bash
cp .env.example .env      # 至少改 ADMIN_TOKEN;确认 API_ENABLED=true
docker compose up -d --build
```

**本地开发:**

```bash
npm install
cp .env.example .env.local   # 设 ADMIN_TOKEN、API_ENABLED=true
npm run dev                  # http://localhost:3000
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `API_ENABLED` | 服务 API 总开关,**默认关闭**;必须设为 `true` 才对外提供服务(`/api/health` 不受影响) |
| `ADMIN_TOKEN` | 进入 `/admin` 和推进赛程的口令,设一段长随机串 |
| `DATA_DIR` | 数据文件目录。默认容器内 `./.data`(**临时**,重新部署会清空);指到持久化挂载目录可长期保留 |
| `BACKUP_DIR` | 数据快照目录。默认 `/mnt/sml-data`;每 30 分钟把数据快照写到这里,建议指到持久化挂载盘 |
| `BACKUP_KEEP` | 保留的快照份数,默认 48(≈ 最近 24 小时) |
| `BGM_USER_AGENT` | 调 Bangumi API 的 UA,可选 |

## 怎么玩

- 访客在 `/`:提名阶段搜角色 / 整部作品导入 / 手动添加,并投提名票;小组、淘汰阶段点角色投票。
- 管理员在 `/admin`(需 `ADMIN_TOKEN`)按顺序推进:
  1. 创建比赛 →(可随时**编辑名称 / 简介**)
  2. 结束提名 → 开小组赛:填参赛人数 / 小组数 / 每组晋级(**晋级总数须为 2 的幂**,如 4 组 × 2 = 8)
  3. 结算小组赛 → 生成淘汰赛(按票数定名次)
  4. 逐轮推进淘汰赛,直到决出冠军

## 部署

自托管到云服务器 / NAS(Docker):见 [`DEPLOY_CN.md`](./DEPLOY_CN.md)。

镜像化直接用根目录 `Dockerfile`(多阶段构建,监听 80)。

## 数据与存储

数据是**容器本地的一个 JSON 文件**(`$DATA_DIR/saimoe.json`),每次写操作同步落盘、原子替换;进程内按文件 mtime 缓存,避免重复读盘。含义:

- **必须单实例运行**:多个实例各写各的文件,数据不共享。
- 容器文件系统通常**易失**:不挂持久化卷时,重新部署 / 重启会清空数据。要长期保留,把 `DATA_DIR` 指到持久化挂载目录(云硬盘 / NAS / compose volume)。
- 适合中小规模人气投票;不适合超大规模高并发(整份数据每次读写全量 JSON)。

**自动备份**:进程每 30 分钟把数据快照到 `$BACKUP_DIR/saimoe-<时间戳>.json`(默认 `/mnt/sml-data`),保留最近 `BACKUP_KEEP` 份(默认 48,约 24 小时)。`BACKUP_DIR` 应指向持久化挂载盘(NAS / 云硬盘 / compose volume),快照可用于恢复——用某个快照覆盖 `saimoe.json` 再重启即可。不再依赖任何云存储。

## 结构

```
app/
  page.tsx            投票主页(按阶段渲染)
  admin/page.tsx      管理台
  api/state           GET  当前赛况(含本人投票)
  api/bangumi/search  GET  角色搜索(服务端代理)
  api/nominate        POST 提名 / 整部作品导入
  api/vote            POST 提名投票 / 对战投票
  api/admin/action    POST 赛程推进 + 编辑信息(需令牌)
  api/img             GET  Bangumi 图片代理(绕防盗链)
  api/health          GET  健康检查(不读数据,探针用)
lib/
  db.ts               本地 JSON 存储(读改写 + 原子落盘)
  engine.ts           赛制引擎:分组、种子、结算、状态
  bangumi.ts          Bangumi 搜索 / 详情 / 整部作品角色
  voter.ts            设备指纹 / cookie 投票身份
  flags.ts            服务 API 开关
  schedule.ts         定时赛程推进
  backup.ts           每 30 分钟数据快照
```

## 说明

- **平票 / 0-0** 结算时判给 A 方(`lib/engine.ts` 的 `decide()`)。
- **不支持轮空**,晋级总数要是 2 的幂(管理台会校验)。
- **防刷是尽力而为**:设备指纹可被清理/伪造,要硬性防刷需接账号登录(如 Bangumi OAuth)。
