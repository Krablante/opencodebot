FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache openssh-client

ENV NODE_ENV=production \
    OPENCODEBOT_CONFIG=/app/config.local.json \
    NPM_CONFIG_UPDATE_NOTIFIER=false

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY config.example.json servers.example.json ./
COPY plugins ./plugins
COPY src ./src
COPY scripts ./scripts

CMD ["node", "src/main.mjs"]
