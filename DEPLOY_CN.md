# 大陆部署指南

Vercel + 海外 MySQL 那套在中国大陆访问不稳定(无大陆节点,偶有被墙)。这里给两条更适合大陆的路。

## 前提:域名要不要备案?

**只要用自己的域名 + 大陆机房的服务器,就必须先做 ICP 备案**(阿里云/腾讯云都有免费代备案,通常 1~2 周)。没备案,大陆机房会直接拦 80/443 端口。

- **能等备案** → 方案 A:自己域名 + 国内云服务器,访问最快最稳。
- **不想等** → 方案 B:用云厂商的默认域名(不是自己买的域名),不少 PaaS 允许直接用,几分钟上线;之后备案通过了再换自己的域名。

## 方案 A(推荐):国内云服务器 + Docker 自托管

应用和数据库都在自己的服务器上,不依赖任何境外服务,访问最快。

### 1. 开一台服务器

阿里云「轻量应用服务器」或腾讯云「轻量应用服务器」,选 2 核 2G 起步的规格,系统选 Ubuntu 22.04,买的时候顺手绑一个自己的域名并提交备案。

### 2. 装 Docker

SSH 进服务器:
```bash
curl -fsSL https://get.docker.com | sh
apt install -y docker-compose-plugin   # 或按面板提示装
```

### 3. 把代码放上去

```bash
git clone https://github.com/jiaobenhaimo/bgm-saimoe.git
cd bgm-saimoe
cp .env.example .env
```
编辑 `.env`,把 `MYSQL_PASSWORD` 和 `ADMIN_TOKEN` 改成两段不同的随机字符串(可用 `openssl rand -hex 24` 生成)。**不需要**填 `DATABASE_URL`——`docker-compose.yml` 会用 `MYSQL_PASSWORD` 自动拼出正确的连接串,指向同一个 compose 网络里的数据库容器。

### 4. 启动

```bash
docker compose up -d --build
```
第一次构建要几分钟。起来后应用在容器内监听 80 端口,`docker-compose.yml` 已把它映射到主机的 3000 端口(即 `localhost:3000`)。

### 5. 挂反向代理 + HTTPS

生产环境别直接裸露 3000 端口,前面加一层 Nginx 或用 Caddy(自动申请证书更省事):

```bash
apt install -y caddy
cat > /etc/caddy/Caddyfile <<'EOF'
your-domain.com {
  reverse_proxy localhost:3000
}
EOF
systemctl restart caddy
```
把 `your-domain.com` 的 DNS A 记录指到服务器 IP,备案通过后即可正常访问,Caddy 会自动签好 HTTPS 证书。

### 6. 更新代码

```bash
cd bgm-saimoe
git pull
docker compose up -d --build
```

### 数据库说明

`lib/db.ts` 用的是标准 `mysql2` 驱动,能直接连自己 Docker 里的 MySQL,也能连阿里云 RDS MySQL、腾讯云数据库 MySQL、腾讯云开发 CloudBase MySQL——换的只是 `DATABASE_URL` 这一行,代码不用改。数据存在 `docker-compose.yml` 里的 `db_data` 这个 volume 里,`docker compose down` 不会删它,只有显式 `docker compose down -v` 才会清空。

---

## 方案 B:腾讯云开发 CloudBase Run(不备案,几分钟上线)

详细步骤已经拆成独立文档,见 [`DEPLOY_TCB.md`](./DEPLOY_TCB.md)——用的是云托管(CloudBase Run)按 `Dockerfile` 容器化部署,数据库用 CloudBase 自带的 MySQL(开一次「直连服务」拿标准连接串),和本项目现成的 `mysql2` 直连驱动完全兼容,不用改代码。

---

## 两条路怎么选

| | 方案 A(自托管) | 方案 B(CloudBase) |
|---|---|---|
| 要不要备案 | 用自己域名就要 | 用默认域名不用 |
| 上线速度 | 备案周期(1~2周) | 几分钟 |
| 运维 | 自己管服务器、续期证书 | 全托管 |
| 成本 | 服务器月租(轻量约 ¥24~60/月) | 按量计费,小流量几乎免费 |
| 适合 | 长期正式跑、想完全掌控 | 先内测/给朋友玩,后面再转正 |

先用方案 B 跑起来验证功能,备案批下来再迁到方案 A,两边用的都是同一套 `mysql2` 连接串,迁移只是改一个环境变量加换服务器,代码不用动。
