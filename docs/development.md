# Development

This codebase should stay small enough to read in one sitting. The goal is not a framework around OpenCodez; the goal is a reliable companion bot with clear source boundaries.

The current split is intentionally modest. `main.mjs` wires startup, shutdown, and module composition. `telegram-polling.mjs` owns update polling and Telegram input routing. `prompt-routing.mjs` owns Telegram-origin prompt delivery, attachments, multipart prompt buffering, prompt feedback, and the prompt queue. `session-reconcile.mjs` owns OpenCodez event handling and bounded missed-event recovery. `topic-lifecycle.mjs` owns forum topic creation and lifecycle handling, while the small `single-flight.mjs` helper coalesces duplicate fallback work and lets primary SSE events wait behind active per-session recovery without being dropped. `final-notifications.mjs` owns final-answer DMs. `commands.mjs` owns Telegram command handlers. `render.mjs` coordinates Telegram message rendering while `render-side-effects.mjs` owns pin/final/mirror side effects. `tool-formatting.mjs` and `rich-markdown.mjs` hold pure formatting helpers; `rich-list-normalization.mjs` uses mdast to isolate Telegram's nested-list workaround from general rich-message preparation.

## Checks

Run syntax checks:

```bash
npm run check
```

Run the small dedicated test suite:

```bash
npm test
```

Run the short smoke check:

```bash
npm run smoke
```

`npm run check` is implemented as a Node script so it works on Linux, macOS, and Windows without relying on shell glob expansion. `npm test` holds only the few contracts that benefit from a dedicated test file, such as chat-profile shape, the OpenCodez System selection payload, the terminal-mirror/idle latch that guards queued prompts, and single-choice question callbacks. `npm run smoke` is the central regression check: it verifies config shape and aggregated server-config validation, ordered SSE event handling, OpenCode request timeouts, whole-session state pruning without per-session message loss, Telegram download limits, synthetic file text filtering, nested rich-list normalization, `/kill`, queued prompt release after terminal mirror and session idle, the incomplete-run warning fallback, full/economy mode behavior, task/subagent spawn notices, final notification summaries, artifact-topic host rejection, and artifact upload path handling. The incomplete-run smoke deliberately uses the real classic sequence (`message.updated` for the user followed by `session.idle`) without fabricating `session.next.prompted`; it also covers repeated user/idle events, durable dedupe, the OpenCodez button, and expected-stop suppression. The list matrix covers unchanged flat lists and fenced code plus ordered, unordered, mixed, deep, blockquoted, task-like, inline-formatted, and code-containing nested lists. When a valid runtime config is available, smoke also checks Telegram `getMe` and probes configured OpenCodez servers with `GET /session`. With an explicit runtime config, it verifies that the local artifact upload root is writable when the default artifact server uses local transfer. It should not create sessions, send prompts, or print tokens.

The runtime dependencies `mdast-util-from-markdown` and `mdast-util-to-markdown` are deliberately narrow: they provide CommonMark structure and safe inline serialization without introducing a general application framework. Keep `package-lock.json` committed; Docker installs the locked production dependency graph with `npm ci --omit=dev`.

Keep dedicated test files few and focused. This is a small operated bot, so tests should protect important configuration and API contracts rather than every formatter branch and helper function. Prefer real disposable-session checks for runtime and multihost behavior; clean those sessions up immediately.

On Windows, use PowerShell and the same npm commands:

```powershell
npm run check
npm test
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

`smoke:live` executes `npm run smoke -- /app/config.local.json` inside the running Compose container, so it checks the live runtime config with the same lightweight smoke contract.

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

Tests should stay proportional. Add or keep checks only when a regression is expensive to catch manually or has already caused production pain. Avoid pretending this is an enterprise test suite.

## Git

Check status before and after work:

```bash
git status --short
git diff --stat
npm run check
npm test
npm run smoke
npm run smoke:live
```

Track source, docs, `config.example.json`, scripts, and Compose files. Do not track `token.env`, generated runtime config, bot state, uploaded files, WireGuard keys, peer configs, QR images, logs, `node_modules`, or build output.
