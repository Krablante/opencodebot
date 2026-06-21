# opencodebot

opencodebot is a small Telegram mirror and companion for [OpenCodez](https://github.com/Krablante/opencodez). OpenCodez stays the main interface and source of truth; the bot adds Telegram forum topics, prompts, progress, compact tool status, attachments, final-answer pins, and a memory-only prompt queue.

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

The bot host supports Linux and Windows through Node.js and npm. Linux also has the optional systemd service template and WireGuard server helper. Windows is fully fine as a Telegram, browser, and WireGuard client; running the bot itself on Windows is just `npm start` in PowerShell.

## Setup

Clone the repo and create a runtime config:

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

Run locally:

```bash
npm start
```

Or in PowerShell:

```powershell
npm start
```

The systemd unit in `deploy/` is a template. Edit its user, paths, env file, and `OPENCODEBOT_CONFIG` before installing it on your host.

## Commands

```text
/new [server] [template] [title]
/q <prompt>
/q status
/q delete <number>
/mirror_on
/mirror_off
/help
```

Default chat templates are `d4flash`, `d4pro`, and `gpt55p`. Public defaults use the ordinary OpenCodez `gpt55` template; local deployments can override templates in runtime config.

## Docs

- [Telegram Workflow](docs/telegram-workflow.md) covers topics, `/new`, `/q`, attachments, multipart prompts, rich messages, tools, final pins, and reconcile.
- [Config And Runtime](docs/config-runtime.md) covers config loading, token handling, templates, mirror settings, attachments, and state.
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
