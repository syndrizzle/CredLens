# Frontend: build the Vite app, then serve it with nginx, which also proxies /api to the backend
# over the compose network so the browser only ever talks to one origin.
FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM nginx:1.30.8-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
