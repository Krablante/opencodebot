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

Docker Compose is the easiest deployment path on Linux, Windows, and macOS. The bot also runs directly through Node.js and npm. Linux has the optional systemd service template and WireGuard server helper. Windows is fully fine as a Telegram, browser, Docker, and WireGuard client.

## Setup

Clone the repo and create local config:

```bash
git clone https://github.com/Krablante/opencodebot.git
cd opencodebot
npm run init-config
```

This creates `config.local.json` and `servers.json`. Edit both before starting the bot:

```bash
$EDITOR config.local.json
$EDITOR servers.json
```

PowerShell works the same way:

```powershell
notepad .\config.local.json
notepad .\servers.json
```

Secrets belong in `token.env`, not in git:

```env
TELEGRAM_BOT_TOKEN=123456:telegram-token
TELEGRAM_ALLOWED_USER_IDS=123456789
OPENCODE_PASSWORD=your-opencodez-password
```

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

OpenCodez does not need to run in Docker. Put its normal LAN URL in `servers.json`; if OpenCodez runs on the same machine as Docker Desktop, `http://host.docker.internal:4096` is usually the right URL.

For direct npm usage, run `npm start`. The systemd unit in `deploy/` is a Linux template for people who prefer systemd over Docker.

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
```

`npm run check` syntax-checks source and scripts. `npm run smoke` runs local logic checks, loads config, checks Telegram `getMe`, probes configured OpenCodez servers, and verifies chat-template selection with a temporary OpenCodez session. It should not print tokens or send prompts.

## License

MIT
