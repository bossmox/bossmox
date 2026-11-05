FROM node:22.22.2-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm ci && npx tsc

FROM node:22.22.2-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
COPY --from=build /app/dist ./dist
COPY public ./public
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null --header="Host: localhost" http://127.0.0.1:8080/healthz
CMD ["node", "dist/src/server.js"]
