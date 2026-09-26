# edge 镜像：构建玩家端与管理端静态文件，与 Caddy（HTTPS 入口）打成一个镜像。
# 静态文件烘进镜像 → 服务器上 docker compose up -d --build 一行完成部署。
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
COPY packages/domain/package.json packages/domain/
COPY packages/i18n/package.json packages/i18n/
COPY packages/jev/package.json packages/jev/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --no-frozen-lockfile --filter @jev/web... --filter @jev/admin...

COPY apps ./apps
COPY packages ./packages
RUN pnpm --dir apps/web build && pnpm --dir apps/admin build

FROM caddy:2
COPY --from=build /app/apps/web/dist /srv/web
COPY --from=build /app/apps/admin/dist /srv/admin
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
