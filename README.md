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

A Telegram topic follows one main OpenCodez session. Assistant text arrives in completed blocks. Economy mode is the default and hides ordinary tool status; `/mode full` enables compact tool status. A saved mode survives restarts and updates. Hidden reasoning, raw tool arguments, and child sessions stay out of the mirror. The bot persists topic bindings, delivery markers, and incoming Telegram receipts so it can recover after a restart. Its `/q` prompt queue remains in memory.

Beyond the mirror, you can enable speech transcription, a separate final-answer voice reply, or an artifact gateway that lets OpenCodez send files to one chosen Telegram topic. These are optional. Remote browser access through WireGuard and a local Telegram Bot API sidecar are optional too.

## 🚀 Start

You need Node.js **22+**, a running OpenCodez server, a Telegram bot token, and your numeric Telegram user ID. Docker Compose is the recommended runtime on Linux, macOS, and Windows; a direct Node.js run also works.

```bash
git clone https://github.com/Krablante/opencodebot.git
cd opencodebot
npm run setup
```

The installer asks for the BotFather token, your user ID, the OpenCodez URL and optional password, then prepares private files, writable paths and Compose mounts. From a container, `127.0.0.1` points at the container; use the host's reachable address or `host.docker.internal`. [First run](docs/en/first-run.md) covers setup and migration; `npm run init-config` remains available for manual configuration.

Start the bot, add it as an administrator to a forum-enabled group, and run `/setup`. It checks rights, preserves or creates FILES and AUDIO, opens General and offers connection setup. Open the bot's private chat once to allow notifications. Groq keys are entered in the same topic where setup requested them. Preferences persist in bot state; routine profile and connection changes need no JSON edits.

For Docker Compose, create a writable `state` directory (`mkdir -p state` on Linux/macOS, `New-Item -ItemType Directory -Force state` in PowerShell). The revision-aware `npm run deploy:bot` command requires a **clean Git checkout** and runs the live health check after starting the bot:

```bash
npm run deploy:bot
docker compose logs -f opencodebot
```

For a local Node.js run, use `npm start`. Do not run it alongside a container polling the same Telegram token. [Docker setup](docs/en/docker.md) covers mounts, host paths, the optional local Bot API, and updates; [configuration](docs/en/config-runtime.md) covers every runtime file and server setting.

## 💬 Use it

Open the pinned Rich Message menu in General with `/menu`. **New topic** suggests a random Old Russian word and shows the exact model before creation. Choose **Another word** or enter your own title; **Settings → Random topic names** disables the default naming mode. **Profiles** creates and edits presets using the live OpenCodez model catalog; personal selection screens do not clutter the group. `/new` opens the same flow, while `/new [server] [profile] [dir:<path>] [title]` remains a shortcut. The menu moves to a fresh message daily. Bot API 10.3+ is required for rich buttons and personal ephemeral screens.

In a bound topic, `/q` queues another prompt, `/kill` stops the run, `/reset` starts fresh while preserving the old session, and `/context` exports recent logical turns across compaction. Reply to an earlier Telegram prompt to rewind that exact OpenCodez turn. **How to use** contains the illustrated guide and downloadable English/Russian PDFs. Working topics have no permanent control panel.

See [Telegram workflow](docs/en/telegram-workflow.md) for topic rules and the full command guide. [Final Voice](docs/en/final-voice.md), [speech and runtime config](docs/en/config-runtime.md#speech-transcription), and [artifact delivery](docs/en/artifact-gateway.md) each have their own setup instructions.

## 🛠️ Operate and develop

`npm run check` checks syntax, `npm test` runs focused contracts, and `npm run smoke` checks the local integration paths without posting to Telegram. `npm run health:live` checks the deployed Compose process, Telegram access, and required OpenCodez discovery endpoints. `npm run deploy:all` rebuilds the full Compose project when its services change. No CI workflow is required to run the bot; [development](docs/en/development.md) and [self-update](docs/en/self-update.md) explain the source, runtime, and host-runner boundaries.

**Documentation:** 🇬🇧 [English index](docs/en/README.md) · 🇷🇺 [Русский справочник](docs/ru/README.md). Each topic has a matching path under `docs/en/` and `docs/ru/`; add another language as another directory and link it from the indexes.

The application is MIT licensed; the bundled [Old Russian word list](assets/old-russian-words.LICENSE.md) is CC BY-SA 4.0. OpenCodeBot is an independent companion to [OpenCodez](https://github.com/Krablante/opencodez).
