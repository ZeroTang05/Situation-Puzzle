# Admin web (apps/admin) — Vite build → dist → nginx:alpine same shape as web (admin only talks to /api/v1)
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/admin/package.json apps/admin/
RUN pnpm install --no-frozen-lockfile --filter @jev/admin...

COPY apps/admin ./apps/admin
# apps/admin/tsconfig.json extends ../../tsconfig.base.json，把它一并拷进来。
# 走标准 build（先 tsc --noEmit 再 vite build）。apps/admin 的 tsconfig 已切到
# module/moduleResolution: node16 + customConditions: ["types", "node"]，
# 让 tsc 能解析 vite 的 `imports`/`#types/*` 子模块。
COPY tsconfig.base.json /app/tsconfig.base.json
RUN pnpm --dir apps/admin build

FROM nginx:1.27-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY infra/admin.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
EXPOSE 80
