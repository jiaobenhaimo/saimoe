# 大陆部署指南

数据存本地 JSON 文件，不依赖任何外部数据库。这里给两条适合大陆的部署路。

## 前提：域名要不要备案？

**只要用自己的域名 + 大陆机房的服务器，就必须先做 ICP 备案**（阿里云/腾讯云都有免费代备案，通常 1~2 周）。没备案，大陆机房会直接拦 80/443 端口。

- **能等备案** → 方案 A：自己域名 + 国内云服务器，访问最快最稳。
- **不想等** → 方案 B：用云厂商的默认域名（不是自己买的域名），不少 PaaS 允许直接用，几分钟上线；之后备案通过了再换自己的域名。

## 方案 A（推荐）：国内云服务器 + Docker 自托管

应用和数据库都在自己的服务器上，不依赖任何境外服务，访问最快。

### 1. 开一台服务器

阿里云「轻量应用服务器」或腾讯云「轻量应用服务器」，选 2 核 2G 起步的规格，系统选 Ubuntu 22.04，买的时候顺手绑一个自己的域名并提交备案。

### 2. 装 Docker

SSH 进服务器：
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
编辑 `.env`，把 `ADMIN_TOKEN` 改成一段随机字符串（可用 `openssl rand -hex 24` 生成），确认 `API_ENABLED=true`。不需要配任何数据库。

### 4. 启动

```bash
docker compose up -d --build
```
第一次构建要几分钟。起来后应用在容器内监听 80 端口，`docker-compose.yml` 已把它映射到主机的 3000 端口（即 `localhost:3000`）。

### 5. 挂反向代理 + HTTPS

生产环境别直接裸露 3000 端口，前面加一层 Nginx 或用 Caddy（自动申请证书更省事）:

```bash
apt install -y caddy
cat > /etc/caddy/Caddyfile <<'EOF'
your-domain.com {
  reverse_proxy localhost:3000
}
EOF
systemctl restart caddy
```
把 `your-domain.com` 的 DNS A 记录指到服务器 IP，备案通过后即可正常访问，Caddy 会自动签好 HTTPS 证书。

### 6. 更新代码

```bash
cd bgm-saimoe
git pull
docker compose up -d --build
```

### 数据存储说明

数据存在容器本地文件 `/data/saimoe.json`（由 `docker-compose.yml` 里的 `saimoe_data` 这个 volume 持久化）,`docker compose down` 不会删它，只有 `docker compose down -v` 才会清空。**只能单实例运行**；要扩多实例得改用共享存储或数据库。

---

## 关于备份

数据快照每 30 分钟自动写到 `BACKUP_DIR`（默认 `/mnt/sml-data`，建议指向 NAS / 云硬盘等持久化挂载盘），保留最近 `BACKUP_KEEP` 份（默认 48）。恢复时用某份 `saimoe-<时间戳>.json` 覆盖数据文件再重启即可。数据不依赖任何外部数据库或云存储。
