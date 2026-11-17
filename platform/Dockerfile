FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY web ./web
COPY server ./server
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --chown=node:node package.json ./
RUN mkdir /app/data
RUN chown node:node /app/data
USER node
ENV NODE_ENV=production PV_ROLE=cloud PV_HOST=0.0.0.0 PV_PORT=8787 PV_DATA_DIR=/app/data
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["node", "server/index.mjs"]
