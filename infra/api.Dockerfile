# API 进程镜像：tsx 运行 TS 源（monorepo 内部包直接引用源码），无需独立构建产物
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
COPY packages/domain/package.json packages/domain/
COPY packages/i18n/package.json packages/i18n/
COPY packages/jev/package.json packages/jev/
RUN pnpm install --frozen-lockfile --filter @jev/api... || pnpm install --no-frozen-lockfile --filter @jev/api...

FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY --from=deps /app ./
COPY packages ./packages
COPY apps/api ./apps/api
EXPOSE 8080
CMD ["pnpm", "--dir", "apps/api", "exec", "tsx", "src/main.ts"]
