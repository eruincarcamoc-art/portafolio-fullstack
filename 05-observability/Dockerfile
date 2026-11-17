FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production DB_PATH=/data/pulse.db
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir /data && chown node /data
COPY --from=build /app/dist ./dist
USER node
VOLUME /data
EXPOSE 4400
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://localhost:4400/health || exit 1
CMD ["node", "dist/server.js"]
