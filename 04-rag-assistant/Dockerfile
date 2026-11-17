FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY corpus corpus
USER node
EXPOSE 4300
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://localhost:4300/health || exit 1
CMD ["node", "dist/server.js"]
