# Build from the repository root:  docker build -f services/connectors/Dockerfile .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY services/connectors/package.json services/connectors/
RUN npm ci --workspace packages/shared --workspace services/connectors --include-workspace-root
COPY packages/shared packages/shared
COPY services/connectors services/connectors
RUN npm run build -w packages/shared && npm run build -w services/connectors \
  && npm prune --omit=dev --workspace packages/shared --workspace services/connectors

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/services/connectors/package.json services/connectors/
COPY --from=build /app/services/connectors/dist services/connectors/dist
USER node
CMD ["node", "services/connectors/dist/server.js"]
