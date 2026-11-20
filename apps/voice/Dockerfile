# Build from the repo root: docker build -f apps/voice/Dockerfile .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @careloop/voice build

FROM node:22-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /repo/apps/voice/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
