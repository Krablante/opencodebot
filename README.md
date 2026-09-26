# 🤖 OpenCodeBot

**Your OpenCodez sessions in Telegram, without moving the workspace out of OpenCodez.**

OpenCodeBot follows the OpenCodez API and sends visible session activity to Telegram forum topics. You can start a session, send a prompt, answer a question, and see the final reply from your phone. OpenCodez keeps the sessions, message IDs, tools, and web UI; the bot is a second, deliberately smaller control surface.

🇬🇧 [English](README.md) · 🇷🇺 [Русский](README.ru.md) · 📚 [Documentation](docs/en/README.md) · [MIT license](LICENSE)

💬 **Session topics** · 🧰 **Compact progress** · 🎙️ **Optional voice** · 📎 **Artifact delivery**

## 🧭 How it works

```text
OpenCodez API + one event stream per server
                 ↓
       OpenCodeBot (Node.js)
                 ↕
       Telegram forum topics
```

A Telegram topic follows one main OpenCodez session. Assistant text arrives in completed blocks; tools appear as compact status in full mode. Hidden reasoning, raw tool arguments, and child sessions stay out of the mirror. The bot persists topic bindings, delivery markers, and incoming Telegram receipts so it can recover after a restart. Its `/q` prompt queue remains in memory.

Beyond the mirror, you can enable speech transcription, a separate final-answer voice reply, or an artifact gateway that lets OpenCodez send files to one chosen Telegram topic. These are optional. Remote browser access through WireGuard and a local Telegram Bot API sidecar are optional too.

## 🚀 Start

You need Node.js **22+**, a running OpenCodez server, a Telegram bot token, and your numeric Telegram user ID. Docker Compose is the recommended runtime on Linux, macOS, and Windows; a direct Node.js run also works.

```bash
git clone https://github.com/Krablante/opencodebot.git
cd opencodebot
npm run init-config
```

Copy `token.env.example` to the ignored `token.env` (`cp token.env.example token.env` on Linux/macOS; `Copy-Item token.env.example token.env` in PowerShell). Set `OPENCODEBOT_TOKEN`, `OPENCODEBOT_ALLOWED_USER_IDS`, and your OpenCodez API password there. Edit the generated `servers.json` with an HTTP URL reachable **from the bot runtime**. From a container, `127.0.0.1` points at the container; use the host's reachable address or `host.docker.internal`. Set an absolute `home` for `/new` if you want sessions created in that directory, and configure writable host paths before accepting file uploads.

`config.local.json` is generated beside `servers.json`. Review its `telegram`, `defaultPrompt`, and `opencode` settings. The example starts with scheduled updates and optional provider features disabled. A first message from an allowed user can bind the forum chat while `allowChatBootstrap` is on; after setup, set `telegram.chatId` and turn bootstrap off.

For Docker Compose, create a writable `state` directory (`mkdir -p state` on Linux/macOS, `New-Item -ItemType Directory -Force state` in PowerShell). The revision-aware `npm run deploy:bot` command requires a **clean Git checkout** and runs the live health check after starting the bot:

```bash
npm run deploy:bot
docker compose logs -f opencodebot
```

For a local Node.js run, use `npm start`. Do not run it alongside a container polling the same Telegram token. [Docker setup](docs/en/docker.md) covers mounts, host paths, the optional local Bot API, and updates; [configuration](docs/en/config-runtime.md) covers every runtime file and server setting.

## 💬 Use it

Open the pinned panel in General with `/menu`. Start a topic with `/new [server] [profile] [dir:<path>] [title]`, then send its first prompt. In a bound topic, `/q` queues another prompt, `/kill` stops the run, `/reset` starts fresh in the same topic while preserving the old session, and `/context` exports recent turns. Reply to an earlier Telegram prompt to rewind that exact OpenCodez turn. `/mode economy` hides ordinary tool traffic; `/mode full` shows compact tool status. `/artifacts_here` selects the single file-delivery topic when the gateway is configured.

See [Telegram workflow](docs/en/telegram-workflow.md) for topic rules and the full command guide. [Final Voice](docs/en/final-voice.md), [speech and runtime config](docs/en/config-runtime.md#speech-transcription), and [artifact delivery](docs/en/artifact-gateway.md) each have their own setup instructions.

## 🛠️ Operate and develop

`npm run check` checks syntax, `npm test` runs focused contracts, and `npm run smoke` checks the local integration paths without posting to Telegram. `npm run health:live` checks the deployed Compose process, Telegram access, and required OpenCodez discovery endpoints. `npm run deploy:all` rebuilds the full Compose project when its services change. No CI workflow is required to run the bot; [development](docs/en/development.md) and [self-update](docs/en/self-update.md) explain the source, runtime, and host-runner boundaries.

**Documentation:** 🇬🇧 [English index](docs/en/README.md) · 🇷🇺 [Русский справочник](docs/ru/README.md). Each topic has a matching path under `docs/en/` and `docs/ru/`; add another language as another directory and link it from the indexes.

MIT licensed. OpenCodeBot is an independent companion to [OpenCodez](https://github.com/Krablante/opencodez).
