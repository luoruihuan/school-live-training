FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/api apps/api
COPY apps/web apps/web
RUN DATABASE_URL=mysql://build:build@localhost/live_training npm run db:generate
RUN npm run build

# 初始化容器保留 Prisma CLI 和种子脚本，业务容器只安装运行依赖。
FROM build AS initialize
WORKDIR /app/apps/api
CMD ["node", "scripts/init-db.mjs"]

FROM build AS api-dependencies
RUN npm prune --omit=dev --omit=optional --workspace=apps/api

FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=api-dependencies /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY apps/api/package.json ./package.json
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM nginx:stable-alpine AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/docker-nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 80 443

