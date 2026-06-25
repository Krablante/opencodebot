# Config And Runtime

The repo contains source, defaults, and docs. Runtime config and state live outside git so the bot can be repaired, restarted, and shared without committing private values.

Create config once with:

```bash
npm run init-config
```

Default runtime config path:

```text
./config.local.json
```

`config.example.json` is the public shape and default baseline. `npm run init-config` creates the local runtime copy and an editable `servers.json`. Edit the runtime copy for local behavior, and update `config.example.json` only when the shareable default shape changes.

## Loading

The bot reads `OPENCODEBOT_CONFIG` when it is set. If it is not set, the loader uses `config.local.json` in the repo root. If that file does not exist, it falls back to `config.example.json`; that fallback is useful for checks, but a real bot should have an explicit runtime config.

Relative paths in config are resolved from the config file's directory. This keeps the same config shape usable on Linux and Windows.

The Docker Compose setup mounts `config.local.json`, `servers.json`, `token.env`, and `state/` into the container at the same `/app/...` paths. That means the config created by `npm run init-config` works for both direct npm usage and Docker. The only common Docker-specific edit is the OpenCodez URL in `servers.json`: use a LAN URL or `host.docker.internal`, not `127.0.0.1`, when OpenCodez runs on the host.

The loader also reads `paths.tokenEnv` and then overlays process environment variables on top. That means systemd, PowerShell, shell sessions, and local scripts can override values from `token.env` without editing the runtime JSON.

OpenCodez servers come from `paths.serversJson`, not from the main config body. The public example points at `servers.example.json`; `npm run init-config` creates a local ignored `servers.json` for your real hosts.

## Secrets

`token.env` is read by local scripts and can also be read by the Linux systemd unit. It holds values such as the Telegram bot token, allowed user ids, the OpenCodez password, and the optional artifact gateway token. Do not print it, paste it into docs, or commit it.

The config names the environment variables to try. `telegram.tokenEnvNames` is checked first, but the loader can also recognize a Telegram-looking token from the env file. `telegram.allowedUserEnvNames` is checked first for user ids; if none are found, the loader falls back to env names that look like owner/user/allowed id variables. `opencode.passwordEnvNames` works the same simple way for the OpenCodez password.

Non-secret config is intentionally small. It covers deployment identity and ownership: chat id, allowed user ids, OpenCodez servers, default prompt profile, chat templates, final-notification recipients, artifact gateway address, paths, and optional web/WireGuard helpers. Mirror policy, prompt pinning, reconcile windows, multipart buffering, attachment limits, and tool compaction are fixed defaults in code.

## Telegram

`telegram.chatId` pins the bot to the intended Telegram forum chat.

`telegram.allowedUserIds` limits who can control the bot. Keep this explicit before handing the bot to someone else. `telegram.allowChatBootstrap` is useful only during first setup: if no chat is configured yet, the first allowed message can bind the bot to that chat. After setup, set the chat id and turn bootstrap off.

The bot always autocreates Telegram forum topics for new OpenCodez sessions discovered through Telegram commands, OpenCodez events, or bounded reconcile. Topic creation is part of the product model, not a runtime mode.

## OpenCodez

`opencode.baseUrl` is the local/default API origin used when a server-specific URL is not involved. `opencode.passwordEnvNames` lists env var names that may contain the OpenCodez password.

`opencode.useServerHomeAsDirectory` controls the `directory` sent when the bot creates a session. When it is true and the selected server has a `home` field in `servers.json`, new sessions start there. When it is false, session creation leaves directory selection to OpenCodez defaults.

Each server in `servers.json` should have an `id` and `url`. Optional fields are `label`, `home`, and `offline_ok`. Offline servers do not stop the bot; the event stream backs off and retries.

## Prompt Profiles

`defaultPrompt` is the fallback profile for Telegram-created sessions. It chooses the default OpenCodez server and the prompt metadata the bot can know before the first prompt: agent, model, and optional `opencodezTemplate`.

`chatTemplates` are named profiles for `/new`. The built-in defaults are `d4flash`, `d4pro`, and `gpt55p`. Runtime config is merged with those defaults, so you can add a new template or override one existing template without copying every default.

Each template can define:

- `agent`: OpenCodez agent name.
- `model.providerID`: provider id, such as `openai` or `deepseek`.
- `model.modelID`: model id.
- `model.variant`: optional model effort/variant.
- `opencodezTemplate`: OpenCodez-side chat template name.

Example:

```json
{
  "chatTemplates": {
    "fast": {
      "agent": "build",
      "model": { "providerID": "deepseek", "modelID": "deepseek-v4-flash", "variant": "max" },
      "opencodezTemplate": "gpt55"
    }
  }
}
```

Then start a topic with:

```text
/new fast work on the upload flow
```

## Fixed Mirror Policy

The mirror policy is deliberately not a public matrix of modes. The bot mirrors user-facing OpenCodez activity, hides internal helper tools such as `todo`/`todowrite`, keeps reasoning summaries out of Telegram, compacts tool status into expandable quotes, and uses fixed Telegram-safe message limits.

User prompts are always pinned. Telegram-origin runs pin the original user message after OpenCodez accepts the prompt; web-origin runs pin the mirrored user-prompt message. Telegram pin service messages are cleaned up when possible. Final assistant answers are marked with `🏁` but are not pinned.

Long Telegram prompts, Telegram attachments, and bounded missed-event recovery are always on with conservative internal limits. These mechanisms are part of the bot's reliability model rather than config modes.

## Final Notifications

`finalNotifications` controls optional private DM notifications for final mirrored answers. `finalNotifications.userIds` is the configured recipient allowlist. `/notify_on` enables notifications for those configured ids after verifying that the bot can DM them; `/notify_off` disables those configured recipients again.

The final DM is intentionally short: it names the topic, provides an `Open topic` button for the final message in the Telegram topic, and quotes the original user prompt in an expandable block for orientation. It does not include the final answer text. Durable dedupe markers are capped internally so live events plus reconcile do not send the same final notification twice.

## Artifacts

`artifacts.enabled` starts the optional LAN artifact gateway. The gateway is for agent-created screenshots, logs, text snippets, and files that should be delivered to one Telegram artifacts topic. It is not a mirror-session router and it does not try to infer the current OpenCodez topic.

`artifacts.listenHost` and `artifacts.port` control the local HTTP listener. Docker Compose publishes the same port with `OPENCODEBOT_ARTIFACT_PORT`, defaulting to `8788`. Expose it only on trusted networks and keep bearer-token auth enabled.

`artifacts.tokenEnvNames` lists environment variable names that may contain the artifact token. The default is `OPENCODEBOT_ARTIFACT_TOKEN`. This token is shared with the OpenCodez plugin. It is not the Telegram bot token, and the plugin should never receive the Telegram bot token.

Artifact payload, file, text, and caption limits are fixed safety defaults in code. Text artifacts are sent as expandable quotes. Suitable JPEG, PNG, and WebP files are sent with `sendPhoto` in `auto` mode; other files are sent with `sendDocument`.

The active target is chosen from Telegram with `/artifacts_here`. Running that command in another topic replaces the previous target. The target is stored in `state.json`, not config.

## Web And WireGuard

`web.publicBaseUrl`, `web.privateBaseUrl`, and `web.preferHttp` are used when the bot builds links to OpenCodez web UI. `preferHttp` is mostly for private LAN links where HTTPS is not the useful default.

`wireguard` exists for the optional helper script only. It can expose a private LAN web UI from outside the LAN, but the Telegram bot, OpenCodez API mirroring, long polling, and LAN web UI do not depend on WireGuard.

## Paths And State

`paths.statePath` points to durable bot state. `state.json` stores topic/session bindings, the current artifacts topic, mirror enabled state, pending Telegram-origin prompt ids, known sessions, per-session mirror markers, bounded reconcile windows, and final-notification opt-ins/dedupe markers. It should not contain full prompt queue text. The `/q` queue is memory-only and disappears on service restart by design.

If OpenCodez reports a terminal run failure, the bot announces the failure, clears queued prompts for that session, and lists the cleared items by number plus the same first-words summary used by `/q status`. Reconnects, progress events, and tool-only events do not release or clear the queue.

`paths.uploadsDir` stores downloaded Telegram files. Uploaded files are runtime material and should stay out of git. Download limits and cleanup age are fixed defaults. WireGuard private keys and peer configs live under the configured runtime state path and `/etc/wireguard` on Linux hosts, not in the repo.

## Useful Changes

Use the runtime config for local behavior on Linux/macOS:

```bash
npm run init-config
$EDITOR config.local.json
$EDITOR servers.json
npm start
```

Use the same files from PowerShell on Windows:

```powershell
npm run init-config
notepad .\config.local.json
notepad .\servers.json
npm start
```

Before sharing the bot with a friend, the important knobs are usually `telegram.chatId`, `telegram.allowedUserIds`, `telegram.allowChatBootstrap`, `defaultPrompt.serverID`, `chatTemplates`, final-notification recipients, artifact gateway address/token env, and web base URLs.

When changing the config shape, update `config.example.json`, `src/config.mjs`, and the relevant docs together. Keep defaults reasonable and boring.
