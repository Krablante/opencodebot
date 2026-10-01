# Docker

[English](docker.md) · [Русский](../ru/docker.md) · [All languages](../README.md)

Compose runs OpenCodeBot and the optional local Telegram Bot API. OpenCodez and optional VPN access remain separate. Use Node.js 22+ for host helper commands and Docker Compose for the containers.

## Files

Start with `npm run setup`. It prepares private configuration, paths and mounts, and records your UID/GID on POSIX so writable state belongs to the container user too. For native Node use `npm run setup -- --node`; Windows defaults to native paths. Rich menus require Bot API 10.3+.

For manual setup:

```bash
npm run init-config
cp token.env.example token.env
mkdir -p state
```

Fill the Telegram token/operator IDs and optional OpenCodez password in `token.env`. PowerShell equivalents are `Copy-Item token.env.example token.env` and `New-Item -ItemType Directory -Force state`.

Default sources are `./config.local.json`, `./servers.json`, `./token.env`, `./state`, `./uploads`, `./trash` and `./ssh`. Override host paths in ignored `.env`:

```env
OPENCODEBOT_CONFIG_FILE=/absolute/config.local.json
OPENCODEBOT_SERVERS_FILE=/absolute/servers.json
OPENCODEBOT_TOKEN_ENV_FILE=/absolute/token.env
OPENCODEBOT_STATE_DIR=/absolute/state
OPENCODEBOT_UID=1000
OPENCODEBOT_GID=1000
OPENCODEBOT_UPLOAD_ROOT=/home/operator/.opencodebot/uploads
OPENCODEBOT_ARTIFACT_UPLOAD_SOURCE=/home/operator/trash
OPENCODEBOT_ARTIFACT_UPLOAD_ROOT=/home/operator/trash
OPENCODEBOT_SSH_DIR=/home/operator/.ssh
```

Use the owner's actual UID/GID for manual installation; `1000:1000` is only the Compose fallback. Config/inventory/secrets/SSH are read-only mounts. State and file destinations must be writable by the bot. Back up config and state together while stopped; [storage](config-runtime.md#paths-and-state) lists the journals and compatibility rules.

## Artifact dropbox paths

`OPENCODEBOT_ARTIFACT_UPLOAD_SOURCE` is the host directory; `OPENCODEBOT_ARTIFACT_UPLOAD_ROOT` is its container path. Local transfer needs that container path to match the server path printed to OpenCodez and Telegram. The same applies to `uploadRoot` through `OPENCODEBOT_UPLOAD_ROOT`.

| Destination | Recommended arrangement |
| --- | --- |
| Same Linux/macOS host | Mount the final absolute path at the same path inside the bot |
| Remote POSIX host | SSH transfer; no bind mount of the remote directory |
| Windows drive/UNC paths | Native Node on Windows or SSH transfer to Windows |
| Deliberate container-only paths | Mount to `/app/uploads` and `/app/artifact-uploads`, and configure the server paths accordingly |

For `/home/operator` plus `artifactUploads.root=~/trash`, both dropbox variables are `/home/operator/trash`. On macOS use the actual `/Users/...` path. A Linux container cannot write `C:\Users\...` just because that path appears in inventory. Remote paths belong to the target server.

## OpenCodez URL

The URL must be reachable from the container. For a host API, `http://host.docker.internal:4096` commonly works; LAN hostnames/IPs work too. `127.0.0.1` means the bot container unless host networking was deliberately enabled.

```json
{ "servers": [{ "id": "local", "url": "http://host.docker.internal:4096",
  "home": "/home/operator", "uploadRoot": "/home/operator/.opencodebot/uploads",
  "transfer": { "type": "local" } }] }
```

For a Windows backend, keep the reachable API URL but use `pathStyle: "windows"`, Windows home/upload roots and `transfer: { "type": "ssh", "host": "host.docker.internal", "user": "Operator" }`, or run the bot natively.

## Run

Deploy from a clean Git checkout:

```bash
npm run deploy:bot
docker compose logs -f opencodebot
```

The wrapper installs locked dependencies, checks syntax, builds with the exact Git SHA, recreates only the bot and runs live health. `npm run deploy:all` rebuilds/starts the full Compose project for service changes; add `COMPOSE_PROFILES=telegram-local` to `.env` when that sidecar should be part of the full project. Stop with `docker compose down`, preserving state.

Update with `git pull --ff-only` then `npm run deploy:bot`. Use `deploy:all` for Compose/sidecar changes. Do not run `npm start` alongside a container polling the same token. `npm run health:live` checks the actual main process and both loops, Telegram and required backend APIs; `offline_ok` servers are excluded from that deployment gate.

## Local Telegram Bot API

The optional `telegram-local` profile runs the pinned `aiogram/telegram-bot-api:10.3` image. It stores state in `state/telegram-bot-api`, shared with the bot at `/var/lib/telegram-bot-api`. The sidecar port is internal to Compose by default. Get `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from https://my.telegram.org/apps and add them to `token.env`.

```json
{ "telegram": { "botApi": { "mode": "local",
  "rootUrl": "http://telegram-bot-api:8081",
  "localFilesRoot": "/var/lib/telegram-bot-api" } } }
```

The sidecar uses uid/gid `101:101`. The bot joins group 101 to read its downloads; `TELEGRAM_BOT_API_GID` can override that group for another image. The spool belongs to the bot and remains readable to the sidecar. Repair only these exact directories if ownership was previously changed:

```bash
sudo chown -R 101:101 state/telegram-bot-api
sudo mkdir -p state/telegram-bot-api/opencodebot-spool
sudo chown -R "$(id -u):$(id -g)" state/telegram-bot-api/opencodebot-spool
```

For external state, replace `state/telegram-bot-api` with that installation's exact directory. Suppress token-bearing subdirectory paths in diagnostic/backup errors.

Start the sidecar, move the token from the cloud endpoint, then deploy the bot:

```bash
docker compose --profile telegram-local up -d telegram-bot-api
docker compose run --rm --no-deps opencodebot npm run telegram-local -- enable --yes
npm run deploy:bot
docker compose exec -T opencodebot npm run telegram-local -- doctor
```

The enable helper calls cloud `logOut`; the one-off helper is not a poller. Preserve the shared volume when updating the sidecar. To return to cloud, run `docker compose exec -T opencodebot npm run telegram-local -- disable --yes` while config still points at local, then change mode to `cloud` and restart. Telegram can impose a short restriction before cloud serves the token again.

## Operations

The bot normally makes outgoing requests only. Enabling artifacts starts its authenticated gateway; Compose publishes `OPENCODEBOT_ARTIFACT_PORT` (8788 by default) to container port 8788. Changing the container listener port needs a matching Compose port override. Keep access limited to trusted senders.

The bot container has no Docker socket or source mount. Optional Telegram-driven updates use a fixed Linux host runner installed with `npm run update-runner:install`; [self-update](self-update.md) describes its permissions, rollback and manual cases. Plugin/skill deployment is owned by the OpenCodez installation.
