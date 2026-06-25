# Development

This codebase should stay small enough to read in one sitting. The goal is not a framework around OpenCodez; the goal is a reliable companion bot with clear source boundaries.

The current split is intentionally modest. `main.mjs` wires startup, shutdown, and module composition. `telegram-polling.mjs` owns update polling and Telegram input routing. `prompt-routing.mjs` owns Telegram-origin prompt delivery, attachments, multipart prompt buffering, prompt feedback, and the prompt queue. `session-reconcile.mjs` owns OpenCodez event handling and bounded missed-event recovery. `topic-lifecycle.mjs` owns forum topic creation and lifecycle handling. `final-notifications.mjs` owns final-answer DMs. `commands.mjs` owns Telegram command handlers. `render.mjs` coordinates Telegram message rendering while `render-side-effects.mjs` owns pin/final/mirror side effects. `tool-formatting.mjs` and `rich-markdown.mjs` hold pure formatting helpers.

## Checks

Run syntax checks:

```bash
npm run check
```

Run local contract smoke checks:

```bash
npm run smoke
```

`npm run check` is implemented as a Node script so it works on Linux, macOS, and Windows without relying on shell glob expansion. `npm run smoke` without arguments is a local contract smoke and uses `config.example.json`. It checks local logic for `/new` parsing, tool formatting, prompt queue behavior, multipart prompt buffering, and attachment buffering, then loads the selected config, checks Telegram `getMe`, probes OpenCodez servers, and verifies chat-template selection with a temporary session when the selected server is not marked `offline_ok`. It should not send prompts or print tokens.

On Windows, use PowerShell and the same npm commands:

```powershell
npm run check
npm run smoke
npm start
```

Docker checks use the same source tree:

```bash
docker compose build
docker compose run --rm opencodebot npm run check
```

Run live Compose smoke against the running service:

```bash
npm run smoke:live
```

`smoke:live` executes `npm run smoke -- /app/config.local.json` inside the running Compose container, so it checks the live runtime config instead of `config.example.json`.

## Service

When runtime code changes on the live host, rebuild/restart and check logs with Compose:

```bash
docker compose up -d --build opencodebot
docker compose logs --since=2m opencodebot
npm run smoke:live
```

Do not add or document a second live service manager. Compose is the live service path; direct `npm start` is for local/manual runs.

## Change Style

Prefer small modules with clear ownership over broad rewrites. Good extraction targets are pure parsing, formatting, short-lived buffers, and retry helpers. Be more careful with event flow, prompt sending, state updates, and Telegram message editing; those paths are where small behavior changes become visible.

Do not introduce TypeScript as a build pipeline by default. A useful future step would be lightweight JSDoc or `tsc --checkJs` style checking if it can run without changing the Compose runtime shape.

Tests should stay proportional. Add focused checks when behavior is clean and easy to break, such as queue ordering, attachment flushing, `/new` parsing, or tool formatting. Avoid pretending this is an enterprise test suite.

## Git

Check status before and after work:

```bash
git status --short
git diff --stat
npm run check
npm run smoke
npm run smoke:live
```

Track source, docs, `config.example.json`, scripts, and Compose files. Do not track `token.env`, generated runtime config, bot state, uploaded files, WireGuard keys, peer configs, QR images, logs, `node_modules`, or build output.
