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
OPENCODEBOT_TOKEN=123456:telegram-token
OPENCODEBOT_ALLOWED_USER_IDS=123456789
OPENCODEZ_SERVER_PASSWORD=your-opencodez-password
# Optional STT providers; configure either or both.
OPENROUTER_API_KEY=your-openrouter-api-key
GROQ_API_KEY=your-groq-api-key
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
./uploads
./trash
./ssh
```

If you keep runtime files somewhere else, put path overrides in an ignored `.env` file:

```env
OPENCODEBOT_CONFIG_FILE=/path/to/config.local.json
OPENCODEBOT_SERVERS_FILE=/path/to/servers.json
OPENCODEBOT_TOKEN_ENV_FILE=/path/to/token.env
OPENCODEBOT_STATE_DIR=/path/to/state
OPENCODEBOT_UPLOAD_ROOT=/home/alice/.opencodebot/uploads
OPENCODEBOT_ARTIFACT_UPLOAD_SOURCE=/home/alice/trash
OPENCODEBOT_ARTIFACT_UPLOAD_ROOT=/home/alice/trash
OPENCODEBOT_SSH_DIR=/home/alice/.ssh
```

## Artifact Dropbox Paths

Files dropped by users in the `/artifacts_here` topic are saved under the selected server's artifact upload root. The path printed back to Telegram is the server path, not an arbitrary container scratch path. With the default config, `artifactUploads.root` is `~/trash`, so a server whose `home` is `/home/alice` gets files under `/home/alice/trash/YYYY-MM-DD/`.

Docker adds one extra requirement: the bot container must be able to write that folder. Compose therefore has two artifact dropbox variables. `OPENCODEBOT_ARTIFACT_UPLOAD_SOURCE` is the host folder Docker mounts. `OPENCODEBOT_ARTIFACT_UPLOAD_ROOT` is where that folder appears inside the container. When the selected server uses `transfer: { "type": "local" }`, this container path must match the server path the bot is going to write.

For a normal Linux or macOS host where Docker and the default OpenCodez server share the same host folder, set both values to the same absolute path. On Linux this is often under `/home/alice`; on macOS it is often under `/Users/Alice`.

```env
OPENCODEBOT_ARTIFACT_UPLOAD_SOURCE=/home/alice/trash
OPENCODEBOT_ARTIFACT_UPLOAD_ROOT=/home/alice/trash
```

For a simple local-only setup where you are fine with container-style paths, leave the defaults and set `artifactUploads.root` to `/app/artifact-uploads` or set a matching `artifactUploadRoot` on the local server. This is easy to mount, but the path shown in Telegram will be a container path, so it is usually less convenient for a human-operated desktop host.

```env
OPENCODEBOT_ARTIFACT_UPLOAD_SOURCE=./trash
OPENCODEBOT_ARTIFACT_UPLOAD_ROOT=/app/artifact-uploads
```

On Docker Desktop for Windows, a Windows path such as `C:\Users\Alice\trash` is a good server path to show to OpenCodez and to the user, but it is not a good Linux container target path. For Windows hosts, prefer either running opencodebot directly with Node on Windows, or using `transfer: { "type": "ssh" }` for that Windows server so the bot copies files to `C:\Users\Alice\trash` through SSH. If you intentionally use local Docker transfer on Windows, make sure Docker mounts the Windows folder to a container path and configure the server's artifact root to the path the container can actually write.

Remote servers are different. If the selected server uses SSH transfer, Docker does not need the remote final folder as a bind mount. The bot downloads the Telegram file into its own runtime area, then copies it to the remote server's `artifactUploadRoot` or expanded `artifactUploads.root` over SSH.

## OpenCodez URL

Edit `servers.json` so the container can reach OpenCodez.

If OpenCodez is reachable on your LAN, use the LAN URL:

```json
{
  "servers": [
    {
      "id": "local",
      "label": "OpenCodez",
      "url": "http://192.168.1.50:4096",
      "home": "/home/alice",
      "uploadRoot": "/home/alice/.opencodebot/uploads",
      "transfer": { "type": "local" }
    }
  ]
}
```

If OpenCodez runs on the same Windows machine as Docker Desktop and you want the bot to report Windows paths, prefer SSH transfer to the Windows host. The OpenCodez URL can still use `host.docker.internal`, while file copies go through Windows OpenSSH or another SSH server reachable from the container.

```json
{
  "servers": [
    {
      "id": "local",
      "label": "OpenCodez",
      "url": "http://host.docker.internal:4096",
      "home": "C:\\Users\\Alice",
      "uploadRoot": "C:\\Users\\Alice\\.opencodebot\\uploads",
      "artifactUploadRoot": "C:\\Users\\Alice\\trash",
      "pathStyle": "windows",
      "transfer": { "type": "ssh", "host": "host.docker.internal", "user": "Alice" }
    }
  ]
}
```

Use `transfer: { "type": "local" }` with Docker Desktop only when the server paths in `servers.json` are paths the Linux container can actually write. That is usually fine for WSL-style or container-style paths, but not for plain `C:\...` paths.

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

The bot container normally runs as your user, while the local Bot API sidecar uses its own `telegram-bot-api` user inside the container. Keep the shared local Bot API state owned by uid/gid `101:101`, and keep only the artifact spool writable by the bot uid/gid. Compose adds the bot to group `101` so it can read local Bot API downloads without owning that state; set `TELEGRAM_BOT_API_GID` in `.env` only if the sidecar image uses a different group id. If you previously ran the bot as root or changed ownership recursively, repair the volume before debugging file downloads.

```bash
sudo chown -R 101:101 state/telegram-bot-api
sudo mkdir -p state/telegram-bot-api/opencodebot-spool
sudo chown -R "$(id -u):$(id -g)" state/telegram-bot-api/opencodebot-spool
docker compose restart telegram-bot-api opencodebot
```

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

Without the artifact gateway, the bot only makes outgoing requests to Telegram and OpenCodez, and writes state/uploads to the mounted `state/` directory. When the artifact gateway is enabled, Compose publishes the token-protected gateway on `OPENCODEBOT_ARTIFACT_PORT` or `8788` by default so OpenCodez plugins can upload files to Telegram. User-dropped files in the artifacts topic use the mounted `OPENCODEBOT_ARTIFACT_UPLOAD_ROOT`. Keep the gateway port private to hosts that should be allowed to send artifacts.

WireGuard remains a host-level optional helper. If you want remote private access to the OpenCodez web UI, set up WireGuard on the host and keep using the same OpenCodez URL pattern in `servers.json`.
