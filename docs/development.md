# Development

This codebase should stay small enough to read in one sitting. The goal is not a framework around OpenCodez; the goal is a reliable companion bot with clear source boundaries.

The current split is intentionally modest. `main.mjs` wires runtime flow. `commands.mjs` owns Telegram commands. `chat-templates.mjs` owns `/new` parsing and template application. `render.mjs` coordinates Telegram message rendering. `tool-formatting.mjs` and `rich-markdown.mjs` hold pure formatting helpers. `attachments.mjs`, `multipart-prompts.mjs`, and `prompt-queue.mjs` hold the short-lived buffers that are easy to reason about alone.

## Checks

Run syntax checks:

```bash
npm run check
```

Run smoke checks:

```bash
npm run smoke
```

`npm run check` is implemented as a Node script so it works on Linux, macOS, and Windows without relying on shell glob expansion. Smoke includes local logic checks for `/new` parsing, tool formatting, prompt queue behavior, multipart prompt buffering, and attachment buffering. It then loads runtime config, checks Telegram `getMe`, probes OpenCodez servers, and verifies chat-template selection with a temporary session when the selected server is not marked `offline_ok`. It should not send prompts or print tokens.

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

## Service

When runtime code changes on the live host, restart and check logs:

```bash
sudo systemctl restart opencodebot.service
journalctl -u opencodebot.service -n 120 --no-pager
```

The service file lives in `deploy/opencodebot.service` and is Linux/systemd only. On Windows, run the bot directly with `npm start` in PowerShell. Do not add a Windows service wrapper until someone actually needs unattended Windows hosting.

## Change Style

Prefer small modules with clear ownership over broad rewrites. Good extraction targets are pure parsing, formatting, short-lived buffers, and retry helpers. Be more careful with event flow, prompt sending, state updates, and Telegram message editing; those paths are where small behavior changes become visible.

Do not introduce TypeScript as a build pipeline by default. A useful future step would be lightweight JSDoc or `tsc --checkJs` style checking if it can run without changing systemd/runtime shape.

Tests should stay proportional. Add focused checks when behavior is clean and easy to break, such as queue ordering, attachment flushing, `/new` parsing, or tool formatting. Avoid pretending this is an enterprise test suite.

## Git

Check status before and after work:

```bash
git status --short
git diff --stat
npm run check
npm run smoke
```

Track source, docs, `config.example.json`, scripts, and deployment templates. Do not track `token.env`, generated runtime config, bot state, uploaded files, WireGuard keys, peer configs, QR images, logs, `node_modules`, or build output.
