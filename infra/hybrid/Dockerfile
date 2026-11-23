FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/shop/package.json apps/shop/package.json
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build:finder && npm run build:shop
ENV PORT=8080
EXPOSE 8080
CMD ["node", "--import", "tsx", "scripts/hybrid-server.mjs"]
