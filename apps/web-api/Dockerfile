# Build from the repo root: docker build -f apps/web-api/Dockerfile .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @careloop/web-api build

FROM node:22-slim
ENV NODE_ENV=production PORT=8080 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/web-api/.next/standalone ./
COPY --from=build /repo/apps/web-api/.next/static ./apps/web-api/.next/static
USER node
EXPOSE 8080
CMD ["node", "apps/web-api/server.js"]
