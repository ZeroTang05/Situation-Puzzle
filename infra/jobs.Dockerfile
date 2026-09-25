# jobs 进程镜像：与 API 共享领域包
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/jobs/package.json apps/jobs/
COPY packages/database/package.json packages/database/
COPY packages/domain/package.json packages/domain/
COPY packages/jev/package.json packages/jev/
RUN pnpm install --frozen-lockfile --filter @jev/jobs... || pnpm install --no-frozen-lockfile --filter @jev/jobs...

FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY --from=deps /app ./
COPY packages ./packages
COPY apps/jobs ./apps/jobs
CMD ["pnpm", "--dir", "apps/jobs", "exec", "tsx", "src/main.ts"]
