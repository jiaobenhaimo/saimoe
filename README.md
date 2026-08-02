# Bangumi 世萌大会

基于 Bangumi 角色的三阶段人气竞赛:**预选提名 → 小组循环赛 → 单败淘汰赛**,决出总冠军。

- 角色数据由后端调用 Bangumi API(无 CORS 问题),提名时自动抓取**简体中文名**。
- 匿名投票:每个浏览器一个 httpOnly cookie,据此对提名和每场对战去重(**每人每场一票,可改可撤**)。
- Next.js(App Router)+ MySQL。数据表**首次访问自动创建**,无需手动建库。

## 快速开始

**Docker(推荐)** —— 应用 + MySQL 一起起:

```bash
cp .env.example .env      # 改 MYSQL_PASSWORD 和 ADMIN_TOKEN;DATABASE_URL 不用填
docker compose up -d --build
```

**本地开发** —— 需自备一个 MySQL:

```bash
npm install
cp .env.example .env.local   # 填 DATABASE_URL 和 ADMIN_TOKEN
npm run dev                  # http://localhost:3000
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | MySQL 连接串 `mysql://user:pass@host:3306/db`(Docker Compose 部署会自动拼好,无需手填) |
| `ADMIN_TOKEN` | 进入 `/admin` 和推进赛程的口令,设一段长随机串 |
| `BGM_USER_AGENT` | 调 Bangumi API 的 UA,可选 |

> 这些变量只在**运行时**读取;`next build` / 打镜像阶段不需要它们。

## 怎么玩

- 访客在 `/`:提名阶段搜角色投提名票;小组/淘汰阶段点角色投票。
- 管理员在 `/admin`(需 `ADMIN_TOKEN`)按顺序推进:
  1. 创建比赛 →(可随时**编辑名称 / 简介**)
  2. 结束提名 → 开小组赛:填参赛人数 / 小组数 / 每组晋级(**晋级总数须为 2 的幂**,如 4 组 × 2 = 8)
  3. 结算小组赛 → 生成淘汰赛(按票数定名次)
  4. 逐轮推进淘汰赛,直到决出冠军

## 部署

- **腾讯云开发 CloudBase Run**(免备案先上线):见 [`DEPLOY_TCB.md`](./DEPLOY_TCB.md)
- **自托管到国内云服务器**(Docker + 备案):见 [`DEPLOY_CN.md`](./DEPLOY_CN.md)

镜像化直接用根目录 `Dockerfile`(多阶段构建,监听 80)。

## 结构

```
app/
  page.tsx            投票主页(按阶段渲染)
  admin/page.tsx      管理台
  api/state           GET  当前赛况(含本人投票)
  api/bangumi/search  GET  角色搜索(服务端代理)
  api/nominate        POST 提名角色(抓中文名)
  api/vote            POST 提名投票 / 对战投票
  api/admin/action    POST 赛程推进 + 编辑信息(需令牌)
lib/
  db.ts               MySQL 连接池 + 自动建表(表结构的唯一来源)
  engine.ts           赛制引擎:分组、种子、结算、状态
  bangumi.ts          Bangumi 搜索 + 详情(中文名)
  voter.ts            匿名 voter cookie
```

## 说明

- **平票**默认判 A 方,规则在 `lib/engine.ts` 的 `decide()`。
- **不支持轮空**,所以晋级总数要是 2 的幂(管理台会校验)。
- **防刷是 honor-system**,清 cookie 即可再投;要更强可换成 Bangumi OAuth(投票表已按 `voter_id` 建唯一约束,换成账号 id 即可)。
- **结算无强事务**,极端并发下可能有个位数偏差,对人气赛足够。
