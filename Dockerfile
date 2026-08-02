# ── deps ──────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --include=dev

# ── build ─────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# public/ is optional in Next.js and may be dropped by upstream packaging
# (its only content is a dotfile). Create it so the runner-stage COPY always works.
RUN mkdir -p public
RUN npm run build

# ── run ───────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Some PaaS containers only have IPv4; force IPv4-first DNS so outbound fetch
# doesn't stall on an unreachable IPv6 address (harmless safety net).
ENV NODE_OPTIONS=--dns-result-order=ipv4first
# Default to port 80 so it works with a plain CMD/health probe. `next start`
# honors PORT; a platform-injected PORT at runtime still overrides this default.
ENV PORT=80
COPY --from=builder /app/next.config.mjs ./
COPY --from=builder /app/package.json ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 80
CMD ["npm", "start"]
