# syntax=docker/dockerfile:1
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm install --workspaces --include-workspace-root

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm -w shared run build || true
RUN npm -w web run build
RUN npm -w server run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/public ./server/public
COPY --from=build /app/server/migrations ./server/migrations
EXPOSE 3000
CMD ["sh", "-c", "node node_modules/node-pg-migrate/bin/node-pg-migrate.js -m server/migrations -d DATABASE_URL up && node server/dist/index.js"]
