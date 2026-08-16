# ── deps ──────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --include=dev

# ── build ─────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# public/ is optional in Next.js and may be dropped by upstream packaging
# (its only content is a dotfile). Create it so the runner-stage COPY always works.
RUN mkdir -p public
RUN npm run build

# ── run (standalone) ──────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# #11: container-local time drives reminder timestamps (getHours/getMonth). Without this the
# 公众号 text prints UTC (8h off in CN). tzdata provides the zoneinfo Alpine otherwise lacks.
RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai
# Some PaaS containers only have IPv4; force IPv4-first DNS so outbound fetch
# doesn't stall on an unreachable IPv6 address (harmless safety net).
ENV NODE_OPTIONS=--dns-result-order=ipv4first
# Default to port 80; a platform-injected PORT at runtime still overrides this.
ENV PORT=80
# standalone server binds localhost by default — must listen on all interfaces in a container.
ENV HOSTNAME=0.0.0.0
# Self-contained output: server.js + only the prod deps Next traced (no devDependencies).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 80
CMD ["node", "server.js"]
