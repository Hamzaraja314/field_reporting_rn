FROM node:22-alpine AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/types/tsconfig.json packages/types/tsconfig.json
COPY packages/types/src packages/types/src
RUN pnpm install --filter @field-reporting/api... --frozen-lockfile
COPY apps/api apps/api
RUN pnpm --filter @field-reporting/api prisma:generate && pnpm --filter @field-reporting/api build

FROM node:22-alpine
WORKDIR /workspace
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/types/src packages/types/src
RUN pnpm install --filter @field-reporting/api... --prod --frozen-lockfile
COPY --from=build /workspace/apps/api/dist apps/api/dist
COPY --from=build /workspace/apps/api/prisma apps/api/prisma
RUN pnpm --filter @field-reporting/api prisma:generate
EXPOSE 3000
CMD ["sh", "-c", "pnpm --filter @field-reporting/api exec prisma migrate deploy && pnpm --filter @field-reporting/api start"]
