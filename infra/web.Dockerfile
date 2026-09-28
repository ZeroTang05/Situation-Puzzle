# Player web (apps/web) — Vite build → dist → nginx:alpine serves static + reverse-proxies /api + /ws to api:8080 inside compose network
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/i18n/package.json packages/i18n/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --no-frozen-lockfile --filter @jev/web...

COPY apps ./apps
COPY packages ./packages
COPY tsconfig.base.json /app/tsconfig.base.json
# 走标准 build（先 tsc --noEmit 再 vite build）。apps/web 的 tsconfig 已切到
# module/moduleResolution: node16 + customConditions: ["types", "node"]，
# 让 tsc 能解析 vite 的 `imports`/`#types/*` 子模块与 zod v4 的 types 入口。
RUN pnpm --dir apps/web build

FROM nginx:1.27-alpine
# 轻量 nginx 静态托管 + 容器内反代到 api:8080
RUN rm -f /etc/nginx/conf.d/default.conf
COPY infra/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
