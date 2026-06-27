# Docker

Docker Compose is the recommended deployment path for most people. It keeps the bot as one long-running process with local config and state mounted from the project directory. OpenCodez does not need to be in Docker.

You need Node.js 18 or newer for helper scripts such as `npm run init-config`, plus Docker Compose for the runtime container.

## Files

Create local files once:

```bash
npm run init-config
```

This creates:

```text
config.local.json
servers.json
```

Create `token.env` next to them:

```bash
cp token.env.example token.env
```

```env
TELEGRAM_BOT_TOKEN=123456:telegram-token
TELEGRAM_ALLOWED_USER_IDS=123456789
OPENCODEZ_SERVER_PASSWORD=your-opencodez-password
```

These files stay local and are ignored by git. The Compose file mounts them into the container read-only and mounts `state/` for durable bot state and uploads.

For the optional local Telegram Bot API sidecar, add app credentials from `https://my.telegram.org/apps` to the same `token.env`:

```env
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=your-api-hash
```

By default Compose reads these host paths:

```text
./config.local.json
./servers.json
./token.env
./state
```

If you keep runtime files somewhere else, put path overrides in an ignored `.env` file:

```env
OPENCODEBOT_CONFIG_FILE=/path/to/config.local.json
OPENCODEBOT_SERVERS_FILE=/path/to/servers.json
OPENCODEBOT_TOKEN_ENV_FILE=/path/to/token.env
OPENCODEBOT_STATE_DIR=/path/to/state
```

## OpenCodez URL

Edit `servers.json` so the container can reach OpenCodez.

If OpenCodez is reachable on your LAN, use the LAN URL:

```json
{
  "servers": [
    { "id": "local", "label": "OpenCodez", "url": "http://192.168.1.50:4096", "home": "." }
  ]
}
```

If OpenCodez runs on the same machine as Docker Desktop, use:

```json
{
  "servers": [
    { "id": "local", "label": "OpenCodez", "url": "http://host.docker.internal:4096", "home": "." }
  ]
}
```

Do not use `127.0.0.1` for host OpenCodez from inside Docker unless you intentionally run the container with host networking. In normal Compose networking, `127.0.0.1` means the container itself.

## Run

Linux/macOS:

```bash
mkdir -p state
docker compose up -d --build
docker compose logs -f opencodebot
```

PowerShell:

```powershell
New-Item -ItemType Directory -Force state
docker compose up -d --build
docker compose logs -f opencodebot
```

Stop it with:

```bash
docker compose down
```

## Local Telegram Bot API

The local Bot API server is an optional sidecar in the same Compose project. It is not a separate opencodebot project. It stores TDLib/Bot API state under `state/telegram-bot-api`, and opencodebot mounts the same path at `/var/lib/telegram-bot-api` so large artifacts can be handed to Telegram by local file path.

Enable it in `config.local.json`:

```json
{
  "telegram": {
    "botApi": {
      "mode": "local",
      "rootUrl": "http://telegram-bot-api:8081",
      "localFilesRoot": "/var/lib/telegram-bot-api"
    }
  }
}
```

Start or update the stack with the profile:

```bash
docker compose --profile telegram-local up -d --build
npm run telegram-local -- enable --yes
docker compose exec -T opencodebot npm run telegram-local -- doctor
npm run smoke:live
```

`enable --yes` calls Telegram `logOut` on the cloud Bot API so the token can be served by the local Bot API server. The sidecar port is not published to the LAN; opencodebot reaches `http://telegram-bot-api:8081` on the Compose network. If you return to cloud mode, run `docker compose exec -T opencodebot npm run telegram-local -- disable --yes` while config still points at the local server, then set `telegram.botApi.mode` back to `cloud` and restart the bot. Telegram documents a short restriction window before cloud Bot API accepts the token again.

Update after pulling new code:

```bash
git pull
docker compose up -d --build opencodebot
npm run smoke:live
```

Use full `docker compose up -d --build` when Compose services or the Telegram Bot API sidecar changed. If the update changed the OpenCodez artifact plugin or Telegram artifact skill, also refresh those OpenCodez copies and restart the affected OpenCodez services; see [Artifact Gateway](artifact-gateway.md#updating).

## What Docker Owns

Docker runs opencodebot and, only when the `telegram-local` profile is enabled, the optional Telegram Bot API sidecar. It does not run OpenCodez or WireGuard.

Without the artifact gateway, the bot only makes outgoing requests to Telegram and OpenCodez, and writes state/uploads to the mounted `state/` directory. When the artifact gateway is enabled, Compose publishes the token-protected gateway on `OPENCODEBOT_ARTIFACT_PORT` or `8788` by default so OpenCodez plugins can upload files to Telegram. Keep that port private to hosts that should be allowed to send artifacts.

WireGuard remains a host-level optional helper. If you want remote private access to the OpenCodez web UI, set up WireGuard on the host and keep using the same OpenCodez URL pattern in `servers.json`.
