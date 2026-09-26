# OpenCodeBot documentation

🇬🇧 [English](README.md) · 🇷🇺 [Русский](../ru/README.md) · [Project overview](../../README.md)

Start with the [project README](../../README.md) if you have not installed the bot yet. This index separates the tasks you do in Telegram from the things you configure and operate on the host.

## Use

- [Telegram workflow](telegram-workflow.md): topics, prompts, `/q`, `/reset`, rewind, `/context`, questions, and notifications.
- [General control menu](control-menu.md): the pinned panel and global versus topic commands.
- [Interface language](interface-language.md): English/Russian UI, `/lang`, and catalog maintenance.

## Configure and extend

- [Configuration and runtime](config-runtime.md): private files, server inventory, profiles, storage, speech, and mirror settings.
- [Artifact gateway](artifact-gateway.md): outbound files and text, user file dropbox, HTTP API, and the OpenCodez plugin.
- [Final Voice](final-voice.md): summary and TTS providers, voice commands, and queue behavior.
- [WireGuard](wireguard.md): optional private browser access through a Linux host.

## Operate and develop

- [Docker](docker.md): Compose mounts, cross-platform paths, Bot API sidecar, and deployments.
- [Self-update](self-update.md): GitHub checks, the Linux host runner, manual updates, and rollback boundaries.
- [Development](development.md): source ownership, verification, and live health checks.

The same filenames and categories live under `docs/ru/`. When behavior or a command changes, update both language versions in the same change. To add another language, create `docs/<language-code>/` with the same topic files and add it to the language links; no language list is hardcoded in the bot's documentation layout.
