# syntax=docker/dockerfile:1.7
# Admin web (apps/admin) — Vite build → dist → nginx:alpine same shape as web (admin only talks to /api/v1)
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/admin/package.json apps/admin/
COPY packages/contracts/package.json packages/contracts/
COPY packages/i18n/package.json packages/i18n/
COPY packages/ui/package.json packages/ui/

# BuildKit cache mount：与 api/web/jobs 共享同一份 pnpm store
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    --mount=type=cache,id=pnpm-meta,target=/root/.cache/node/corepack,sharing=locked \
    pnpm install --frozen-lockfile --filter @jev/admin...

# i18n 在 src/index.ts 里 `import type { ErrorCode } from '@jev/contracts'`，
# 必须在镜像里有 contracts 的源码（admin 体积小，单独 COPY 比让 tsc 走兜底解析更稳）
COPY packages/contracts ./packages/contracts
COPY packages/i18n ./packages/i18n
COPY packages/ui ./packages/ui

COPY tsconfig.base.json /app/tsconfig.base.json
COPY apps/admin ./apps/admin

# vite 依赖预打包/增量构建缓存也挂到 mount：源码二次构建显著加速
# 走标准 build（先 tsc --noEmit 再 vite build）。apps/admin 的 tsconfig 已切到
# module/moduleResolution: node16 + customConditions: ["types", "node"]，
# 让 tsc 能解析 vite 的 `imports`/`#types/*` 子模块。
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    --mount=type=cache,id=vite-admin,target=/app/apps/admin/node_modules/.vite,sharing=locked \
    pnpm --dir apps/admin build

FROM nginx:1.27-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY infra/admin.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
EXPOSE 80