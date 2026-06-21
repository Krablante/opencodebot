# Docker

Docker Compose is the recommended deployment path for most people. It keeps the bot as one long-running process with local config and state mounted from the project directory. OpenCodez does not need to be in Docker.

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

```env
TELEGRAM_BOT_TOKEN=123456:telegram-token
TELEGRAM_ALLOWED_USER_IDS=123456789
OPENCODE_PASSWORD=your-opencodez-password
```

These files stay local and are ignored by git. The Compose file mounts them into the container read-only and mounts `state/` for durable bot state and uploads.

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

Update after pulling new code:

```bash
docker compose up -d --build
```

## What Docker Owns

Docker runs only opencodebot. It does not run OpenCodez, Telegram, or WireGuard.

The bot has no inbound HTTP port. It makes outgoing requests to Telegram and OpenCodez, and writes state/uploads to the mounted `state/` directory. This keeps the container simple and avoids special privileges.

WireGuard remains a host-level optional helper. If you want remote private access to the OpenCodez web UI, set up WireGuard on the host and keep using the same OpenCodez URL pattern in `servers.json`.
