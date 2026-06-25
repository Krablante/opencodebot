# opencodebot

opencodebot is a small Telegram mirror and companion for [OpenCodez](https://github.com/Krablante/opencodez). OpenCodez stays the main interface and source of truth; the bot adds Telegram forum topics, prompts, progress, compact tool status, attachments, user-prompt pins, final notifications, artifact delivery, and a memory-only prompt queue.

It is built as a practical single-operator tool that is still clean enough to share. The code favors readable modules, plain JSON config, and boring runtime state over a large framework.

## Why OpenCodez

opencodebot is tuned for OpenCodez's API and event stream. It works especially well with OpenCodez because that fork adds flexible System/Tone prompt control, built-in Codex-style prompt templates, token-saving pruning, and a more convenient cached web UI. That web UI remains useful on the LAN by default, and can also be reached away from home through the optional WireGuard helper if you want private remote access.

The bot does not scrape the web UI. It talks to the OpenCodez HTTP API and `/event` SSE stream, then mirrors useful session activity into Telegram.

## Features

- Telegram forum topics mapped to OpenCodez sessions.
- `/new [server] [template] [title]` for explicit server/profile/topic setup.
- User-provided topic titles stay user-owned; placeholder titles can be renamed from OpenCodez session titles.
- `/q` in-memory per-session prompt queue, with status/delete commands.
- Rich assistant messages sent as completed blocks instead of noisy token streaming.
- Expandable tool quotes with configurable hidden tools.
- Attachments and Telegram media groups attached to the next prompt.
- Optional Telegram artifact gateway for sending agent-created files, screenshots, logs, and text into one dedicated artifacts topic.
- Multipart prompt buffering for Telegram clients that split long messages.
- Optional WireGuard helper for private off-LAN access to the existing OpenCodez web UI.

## Shape

```text
Telegram forum chat
  -> opencodebot long polling
    -> OpenCodez HTTP API and /event SSE
    -> local topic/session state

LAN browser, or optional WireGuard browser
  -> OpenCodez web UI and server selector
```

OpenCodez remains the main workspace. Telegram is the mirror/control surface for moments when a chat interface is more convenient.

## Platforms

Docker Compose is the recommended deployment path on Linux, Windows, and macOS. The bot also runs directly through Node.js and npm. Windows is fully fine as a Telegram, browser, Docker, and WireGuard client.

## Quick Start

You need Node.js 18 or newer, Docker Compose, a running OpenCodez server, and a Telegram bot token from BotFather. The bot can run on the same machine as OpenCodez or on another machine that can reach OpenCodez over HTTP.

Clone the repo and create local config:

```bash
git clone https://github.com/Krablante/opencodebot.git
cd opencodebot
npm run init-config
cp token.env.example token.env
```

This creates `config.local.json` and `servers.json`, then gives you a local `token.env` to fill in. Edit these before starting the bot:

```bash
$EDITOR config.local.json
$EDITOR servers.json
$EDITOR token.env
```

PowerShell works the same way:

```powershell
Copy-Item .\token.env.example .\token.env
notepad .\config.local.json
notepad .\servers.json
notepad .\token.env
```

Secrets belong in `token.env`, not in git. Use your BotFather token, your numeric Telegram user id, and the password for the OpenCodez server API:

```env
TELEGRAM_BOT_TOKEN=123456:telegram-token
TELEGRAM_ALLOWED_USER_IDS=123456789
OPENCODEZ_SERVER_PASSWORD=your-opencodez-password
```

Edit `servers.json` so the bot can reach OpenCodez. If OpenCodez is on your LAN, use its LAN URL. If Docker and OpenCodez are on the same host, `http://host.docker.internal:4096` is usually the right URL.

The first allowed user who talks to the bot can bootstrap the Telegram chat when `allowChatBootstrap` is still enabled in `config.local.json`. After the bot learns the chat id, keep the generated local config and state files; they are the runtime state.

Run with Docker Compose:

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

For direct local usage, run `npm start`. Production/live operation should use Docker Compose.

## Update

Update is intentionally boring:

```bash
git pull
docker compose up -d --build
npm run smoke:live
```

Your `config.local.json`, `servers.json`, `token.env`, and `state/` directory stay local and are not overwritten by updates.

The artifact gateway and OpenCodez plugin are optional. Start without them first unless you specifically want agents to send files, screenshots, logs, or text to a Telegram artifacts topic. Enable that later with [Artifact Gateway](docs/artifact-gateway.md).

## Commands

```text
/new [server] [template] [title]
/session
/q <prompt>
/q status
/q delete <number>
/artifacts_here
/mirror_on
/mirror_off
/help
```

Default chat templates are `d4flash`, `d4pro`, and `gpt55p`. Public defaults use the ordinary OpenCodez `gpt55` template; local deployments can override templates in runtime config.

## Docs

- [Telegram Workflow](docs/telegram-workflow.md) covers topics, `/new`, `/q`, attachments, multipart prompts, rich messages, tools, user-prompt pins, final notifications, and reconcile.
- [Config And Runtime](docs/config-runtime.md) covers config loading, token handling, templates, mirror settings, attachments, and state.
- [Artifact Gateway](docs/artifact-gateway.md) covers `/artifacts_here`, the LAN gateway, the OpenCodez plugin, and the bundled skill.
- [Docker](docs/docker.md) covers the recommended Compose deployment path.
- [Development](docs/development.md) covers source layout, checks, smoke tests, service restart, and change style.
- [WireGuard](docs/wireguard.md) covers the optional private access helper and what it does not own.

## Checks

```bash
npm run check
npm run smoke
npm run smoke:live
```

`npm run check` syntax-checks source and scripts. `npm run smoke` is a local contract smoke: without arguments it uses `config.example.json`. `npm run smoke:live` runs smoke inside the live Compose service against `/app/config.local.json`. Neither smoke path should print tokens or send prompts.

## License

MIT
