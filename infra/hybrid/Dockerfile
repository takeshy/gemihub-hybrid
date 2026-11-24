FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/shop/package.json apps/shop/package.json
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build:finder && npm run build:shop && npm run build:admin
ENV PORT=8080 CHROMIUM=/usr/bin/chromium
EXPOSE 8080
CMD ["node", "--import", "tsx", "scripts/hybrid-server.mjs"]
