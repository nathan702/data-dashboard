# Build from the repository root:  docker build -f services/api/Dockerfile .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY services/api/package.json services/api/
RUN npm ci --workspace packages/shared --workspace services/api --include-workspace-root
COPY packages/shared packages/shared
COPY services/api services/api
RUN npm run build -w packages/shared && npm run build -w services/api \
  && npm prune --omit=dev --workspace packages/shared --workspace services/api

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/services/api/package.json services/api/
COPY --from=build /app/services/api/dist services/api/dist
USER node
CMD ["node", "services/api/dist/server.js"]
