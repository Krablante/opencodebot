# opencodebot

opencodebot is a small Telegram mirror and companion for [OpenCodez](https://github.com/Krablante/opencodez). OpenCodez stays the main interface and source of truth; the bot adds Telegram forum topics, prompts, progress, compact tool status, attachments, user-prompt pins, final notifications, artifact delivery, optional voice transcription, and a memory-only prompt queue.

It is built as a practical single-operator tool that is still clean enough to share. The code favors readable modules, plain JSON config, and boring runtime state over a large framework.

## Why OpenCodez

opencodebot is tuned for OpenCodez's API and event stream. It works especially well with OpenCodez because that fork adds flexible System/Tone prompt control, built-in Codex-style prompt templates, token-saving pruning, and a more convenient cached web UI. That web UI remains useful on the LAN by default, and can also be reached away from home through the optional WireGuard helper if you want private remote access.

The bot does not scrape the web UI. It talks to the OpenCodez HTTP API and `/event` SSE stream, then mirrors useful session activity into Telegram.

## Features

- Telegram forum topics mapped to OpenCodez sessions.
- `/new [server] [template] [dir:<path>] [title]` for explicit server/profile/directory/topic setup.
- User-provided topic titles stay user-owned; placeholder titles can be renamed from OpenCodez session titles.
- `/q` in-memory per-session prompt queue, with status/delete commands.
- `/kill` to stop the current OpenCodez run for a topic and clear queued prompts.
- Rich assistant messages sent as completed blocks instead of noisy token streaming.
- Global `/mode full|economy` mirror modes: full keeps compact expandable tool quotes, while economy shows assistant progress and final answers without Telegram tool traffic.
- Both modes announce task/subagent spawns with a short robot notice that uses the web-visible task title; child-session prompts, tool logs, and results stay hidden.
- Attachments and Telegram media groups attached to the next prompt; large files are copied to the target server's configured upload root and referenced by server-local path.
- Optional Telegram artifact gateway for sending agent-created files, screenshots, logs, and text into one dedicated artifacts topic; the same topic can accept user-dropped files and save them to a configured server folder.
- Optional OpenRouter speech transcription for one dedicated `/sounds_here` topic; voice and audio messages receive transcripts in the same topic, and a pinned model menu lets operators switch STT models.
- Optional local Telegram Bot API sidecar for higher file limits and streaming artifact delivery without a separate project.
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
# Optional, only when speech.enabled is true:
OPENROUTER_API_KEY=sk-or-...
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

Update the bot container first:

```bash
git pull
docker compose up -d --build opencodebot
npm run smoke:live
```

Use full `docker compose up -d --build` instead when the Compose file, Telegram Bot API sidecar, or other services changed.

If the update changes `plugins/opencodebot-artifacts/` or `skills/telegram-artifact-send/`, refresh the OpenCodez plugin and skill copies wherever OpenCodez loads them. Copy the whole skill directory, including `agents/openai.yaml`; that file carries short trigger metadata for the agent. Restart each OpenCodez service after updating plugin or skill files, because running agents may not reload plugin code or skill metadata until the service restarts.

In Politia, use `/home/bloob/politia/services/harness/opencodez/deploy.sh` for that OpenCodez rollout. If you are running the update from `nuc`, restart the local OpenCodez service last and deferred so the current agent session is not interrupted early.

Your `config.local.json`, `servers.json`, `token.env`, and `state/` directory stay local and are not overwritten by updates.

The artifact gateway and OpenCodez plugin are optional. Start without them first unless you specifically want agents to send files, screenshots, logs, or text to a Telegram artifacts topic. Enable that later with [Artifact Gateway](docs/artifact-gateway.md).

The speech transcription module is optional. Enable it with `speech.enabled=true` and `OPENROUTER_API_KEY` in `token.env`, then run `/sounds_here` in a Telegram forum topic. It uses OpenRouter's `openai/whisper-large-v3-turbo` by default and can switch between configured OpenRouter transcription models from a pinned Telegram menu, so no separate speech service is required.

The local Telegram Bot API sidecar is also optional. Add `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` to `token.env`, set `telegram.botApi.mode` to `local`, start Compose with the `telegram-local` profile, then run `docker compose exec -T opencodebot npm run telegram-local -- doctor`. Details are in [Docker](docs/docker.md) and [Config And Runtime](docs/config-runtime.md).

## Commands

Use `/start` or `/help` when you want the bot to show its command summary. These commands are safe to run in a normal topic, and they do not create or change an OpenCodez session.

Use `/new` when you want a fresh Telegram topic and a new OpenCodez session. You can give it a server id, an optional chat template, an optional `dir:<path>` override, and a title. If no server id is given, the configured default server is used. After the topic is created, send the first prompt in that topic.

Use `/q` inside an existing OpenCodez topic when you want to queue another prompt for the same session. `/q status` shows the queue, and `/q delete 2` removes a queued item by number.

Use `/kill` inside an existing OpenCodez topic when you want to stop the current run. It sends OpenCodez's session abort request and clears that topic's queued prompts, but it does not delete the session or the Telegram topic.

Use `/session` inside a topic when you want to see what Telegram topic is bound to which OpenCodez server/session. It also shows the web session URL and whether the current topic is the artifacts target.

Use `/artifacts_here` inside a forum topic when you want that topic to become the single Telegram target for agent-sent artifacts. After that, `opencodebot_send_artifact` sends files, screenshots, logs, or text to that topic. Files dropped by a user in the same topic are saved under `artifactUploads.root` on the default server, or on the server named by the file caption. Docker deployments must also mount that local artifact root; see [Docker](docs/docker.md#artifact-dropbox-paths).

Use `/sounds_here` inside a forum topic when you want that topic to become the voice transcription inbox. The command creates or refreshes a pinned model menu with buttons for configured transcription models and a `Refresh` button for config changes. Voice and audio messages in that topic are transcribed through OpenRouter and answered in the same topic, with only the transcript formatted as Telegram Mono text and service metadata left outside that formatting. The OpenRouter language hint defaults to `ru`, can be changed to another ISO-639-1 code, or can be set to `null` / `"auto"` for auto-detect. `/sounds_off` clears the binding for the current topic, and `/sounds_status` shows whether speech is enabled, configured, selected model, and busy.

Use `/notify_on`, `/notify_off`, and `/notify_status` to manage private final-answer notifications for the configured recipients. Those DMs include the source topic, an `Open topic` button, context quotes, a completed task list when the agent closed one, and a separate quoted `Tools`/`Patched` summary with compact tool counts and semicolon-separated file names for successful structured file mutations.

Use `/mode`, `/mode full`, or `/mode economy` to inspect or change the persistent global mirror mode. Both modes keep short subagent spawn notices. Full mode keeps normal compact tool reporting. Economy mode still mirrors assistant progress notes, final answers, and run failures, but suppresses ordinary tool Telegram messages across all topics. During active work, non-final assistant progress is coalesced into one editable status message per session so repeated short progress notes do not flood Telegram search or topic history.

Use `/mirror_on` and `/mirror_off` when you need to pause or resume web-to-Telegram mirroring without stopping the bot.

Default chat templates are `d4flash`, `d4pro`, and `gpt55p`. Public defaults use the ordinary OpenCodez `gpt55` template; local deployments can override templates in runtime config.

## Docs

- [Telegram Workflow](docs/telegram-workflow.md) covers topics, `/new`, `/q`, `/kill`, attachments, multipart prompts, rich messages, tools, user-prompt pins, final notifications, and reconcile.
- [Config And Runtime](docs/config-runtime.md) covers config loading, token handling, templates, mirror settings, attachments, and state.
- [Artifact Gateway](docs/artifact-gateway.md) covers `/artifacts_here`, the LAN gateway, user-dropped artifact uploads, the OpenCodez plugin, and the bundled skill.
- [Docker](docs/docker.md) covers the recommended Compose deployment path.
- [Development](docs/development.md) covers source layout, checks, smoke tests, service restart, and change style.
- [WireGuard](docs/wireguard.md) covers the optional private access helper and what it does not own.

## Checks

```bash
npm run check
npm run smoke
npm run smoke:live
```

`npm run check` syntax-checks source and scripts. `npm run smoke` is the central contract smoke for production-sensitive regressions; avoid adding scattered test files for ordinary changes. `npm run smoke:live` runs the same lightweight health check inside the live Compose service against `/app/config.local.json`. Neither smoke path should print tokens or send prompts.

## License

MIT
