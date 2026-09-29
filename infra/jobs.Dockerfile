# syntax=docker/dockerfile:1.7
# jobs 进程镜像：判题执行、房间调度与巡检（与 API 共享领域包）。
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/jobs/package.json apps/jobs/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
COPY packages/domain/package.json packages/domain/
COPY packages/i18n/package.json packages/i18n/
COPY packages/jev/package.json packages/jev/

# BuildKit cache mount：与 api/web/admin 共享同一份 pnpm store
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    --mount=type=cache,id=pnpm-meta,target=/root/.cache/node/corepack,sharing=locked \
    pnpm install --frozen-lockfile --filter @jev/jobs...

FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY --from=deps /app ./
# tsx 从 apps/jobs/tsconfig.json 的 extends 链上溯，根 tsconfig 必须在镜像里
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/jobs ./apps/jobs
CMD ["pnpm", "--dir", "apps/jobs", "exec", "tsx", "src/main.ts"]