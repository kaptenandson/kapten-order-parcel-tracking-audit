# Follows the Node 24 major tag on purpose: build with `--pull` so each build
# gets the current 24.x patch.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && npm run lint && npm test && npm run build
RUN npm prune --omit=dev
FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV BIND_HOST=0.0.0.0 PORT=3100 DATABASE_PATH=/app/data/audit.sqlite
EXPOSE 3100
HEALTHCHECK --interval=20s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3100/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server/main.js"]
