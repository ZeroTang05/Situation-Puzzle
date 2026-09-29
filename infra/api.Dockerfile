# syntax=docker/dockerfile:1.7
# API 进程镜像：容器启动时先执行追加式数据库迁移，再启动服务。
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# 固化 pnpm：避免每次 corepack 现拉 shim 卡住（之前 production api 启动卡死的根因之一）
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
COPY packages/domain/package.json packages/domain/
COPY packages/i18n/package.json packages/i18n/
COPY packages/jev/package.json packages/jev/

# BuildKit cache mount：与 web/admin/jobs 共享同一份 pnpm store（id=pnpm-store）
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    --mount=type=cache,id=pnpm-meta,target=/root/.cache/node/corepack,sharing=locked \
    pnpm install --frozen-lockfile --filter @jev/api...

FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY --from=deps /app ./
# tsx 从 apps/api/tsconfig.json 的 extends 链上溯，根 tsconfig 必须在镜像里
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
# 题库导入源（seed profile 使用）
COPY data ./data
EXPOSE 8080
# 迁移是追加式且幂等：每次启动先执行，再启动 API
CMD ["sh", "-c", "pnpm --dir packages/database run db:migrate && exec pnpm --dir apps/api exec tsx src/main.ts"]