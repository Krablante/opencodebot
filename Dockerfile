FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    OPENCODEBOT_CONFIG=/app/config.local.json \
    NPM_CONFIG_UPDATE_NOTIFIER=false

COPY package.json ./
COPY config.example.json servers.example.json ./
COPY src ./src
COPY scripts ./scripts

CMD ["node", "src/main.mjs"]
