# syntax=docker/dockerfile:1.7
# Player web (apps/web) — Vite build → dist → nginx:alpine serves static + reverse-proxies /api + /ws to api:8080 inside compose network
FROM node:22-bookworm-slim AS build
WORKDIR /app
# 提前固化 pnpm 版本，避免每次 corepack 现拉 shim；该命令本身极轻，不会污染缓存层
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# 仅拷 manifest/lock + 必需 package.json：源码变更不会让 pnpm install 层失效
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/i18n/package.json packages/i18n/
COPY packages/ui/package.json packages/ui/

# BuildKit cache mount：跨 4 个 Dockerfile 共享同一份 pnpm store
# （id 必须一致）。pnpm 9+ 的虚拟 store 落在 ~/.local/share/pnpm/store/v3
# 这里用 sharing=locked 防多 builder 写竞。
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    --mount=type=cache,id=pnpm-meta,target=/root/.cache/node/corepack,sharing=locked \
    pnpm install --frozen-lockfile --filter @jev/web...

COPY tsconfig.base.json /app/tsconfig.base.json
COPY apps ./apps
COPY packages ./packages

# vite 依赖预打包/增量构建缓存也挂到 mount：源码二次构建从 ~1min 降到 ~5s
# 走标准 build（先 tsc --noEmit 再 vite build）。apps/web 的 tsconfig 已切到
# module/moduleResolution: node16 + customConditions: ["types", "node"]，
# 让 tsc 能解析 vite 的 `imports`/`#types/*` 子模块与 zod v4 的 types 入口。
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    --mount=type=cache,id=vite-web,target=/app/apps/web/node_modules/.vite,sharing=locked \
    pnpm --dir apps/web build

FROM nginx:1.27-alpine
# 轻量 nginx 静态托管 + 容器内反代到 api:8080
RUN rm -f /etc/nginx/conf.d/default.conf
COPY infra/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80