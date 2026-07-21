# Development

This codebase should stay small enough to read in one sitting. The goal is not a framework around OpenCodez; the goal is a reliable companion bot with clear source boundaries.

The current split is intentionally modest. `main.mjs` wires startup, shutdown, and module composition. `telegram-polling.mjs` owns update polling and Telegram input routing. The pure `telegram-rich-message.mjs` normalizes incoming Telegram Rich Message block trees into prompt text and embedded photo records; it owns no state, downloads, or routing. `prompt-routing.mjs` owns Telegram-origin prompt delivery, attachments, multipart prompt buffering, prompt feedback, and the prompt queue. `session-reconcile.mjs` owns OpenCodez event handling, cursor-paged incremental message recovery, session-update gating, cross-host reconcile scheduling, and the bounded watchdog. `topic-lifecycle.mjs` owns forum topic creation and lifecycle handling, while the small `single-flight.mjs` helper coalesces duplicate fallback work and lets primary SSE events wait behind active per-session recovery without being dropped. `final-notifications.mjs` owns final-answer DMs. `commands.mjs` owns Telegram command handlers. `render.mjs` coordinates Telegram message rendering while `render-side-effects.mjs` owns pin/final/mirror side effects. `tool-formatting.mjs` and `rich-markdown.mjs` hold pure formatting helpers; `rich-list-normalization.mjs` uses mdast to isolate Telegram's nested-list workaround from general rich-message preparation.

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

`npm run check` is implemented as a Node script so it works on Linux, macOS, and Windows without relying on shell glob expansion. `npm test` holds only the few contracts that benefit from a dedicated test file, such as chat-profile shape, the OpenCodez System selection payload, the terminal-mirror/idle latch that guards queued prompts, and single-choice question callbacks. `npm run smoke` is the central regression check: it verifies config shape and aggregated server-config validation, ordered SSE event handling, OpenCode request timeouts, whole-session state pruning without per-session message loss, Telegram download limits, synthetic file text filtering, nested rich-list normalization, `/kill`, native `/compact` request shape and internal-summary suppression, structured session-error normalization and history fallback without raw provider-data leakage, queued prompt release after terminal mirror and session idle, the interrupted and empty-terminal warning paths, per-recipient final-notification retry and legacy-marker compatibility, full/economy mode behavior, task/subagent spawn notices, final notification summaries, artifact-topic host rejection, and artifact upload path handling. Incoming Rich Message smoke covers nested inline text, headings, lists, code, details, tables, explicit link targets, captions, largest-photo selection, multiple embedded photos, attachment descriptor reuse, and unsupported-media reporting. Web-prompt smoke covers the ordinary threshold, literal escaped rich HTML, rich splitting only beyond 32,000 characters, and complete ordinary-message fallback after a simulated rich rejection. The incomplete-run smoke deliberately uses the real classic sequence (`message.updated` for the user followed by `session.idle`) without fabricating `session.next.prompted`; it also covers repeated user/idle events, durable dedupe, empty `finish=stop`, the OpenCodez button, and expected-stop suppression. The list matrix covers unchanged flat lists and fenced code plus ordered, unordered, mixed, deep, blockquoted, task-like, inline-formatted, and code-containing nested lists. When a valid runtime config is available, smoke also checks Telegram `getMe` and probes configured OpenCodez servers with `GET /session`. With an explicit runtime config, it verifies that the local artifact upload root is writable when the default artifact server uses local transfer. It should not create sessions, send prompts, or print tokens.

Incremental-reconcile checks cover `limit`/`before` cursor propagation, a durable restart cursor, parallel overlapping session discovery, the lightweight unchanged-session watchdog, exact-message recovery, and bounded current-turn final summaries with a full-history fallback. Queue recovery smoke additionally covers a terminal message that was already mirrored and an authoritative idle status discovered without a live SSE event. Compact-command smoke must keep live OpenCodez `sessionStatus` authoritative over a stale local queue-busy hint while separately rejecting a genuinely in-flight compaction. Context-export checks cover completed answers, ledger-marked and superseded interruptions with all visible progress notes, reasoning/tool/step exclusion, active-turn exclusion, paginated stopping, attachment descriptors, escaped collapsed Rich Message chunking without truncation, strict 1–10 parsing, pairs-to-turns preference migration, command wiring, and fail-closed rich delivery. State smoke covers no-op/deferred saves plus atomic migration from legacy JSON marker maps into the sibling append journal and successful marker recovery after reload. Keep these contracts in the existing focused tests and central smoke rather than introducing a separate performance-test framework.

Question recovery smoke covers an SSE `question.asked` racing with pending-question reconciliation, one Telegram send under request single-flight, resolution after that send completes, the periodic reconcile hook, and the SSE connected hook. Keep this in central smoke rather than adding a dedicated test file.

Run-alert smoke covers per-recipient durable dedupe across error/interruption shapes, separation of later prompt/continuation failures in the same session, expected-stop suppression, explicit `session.error`, failed assistant-step wiring, unexpected idle interruption wiring, topic/session buttons, and marker persistence. Keep this in central smoke rather than adding a dedicated test file.

Speech transcript smoke covers HTML escaping, lossless multi-message reconstruction beyond 10,000 characters, the ordinary 4,096-character payload ceiling, footer-only-last behavior, sequential reply delivery, and partial-delivery accounting. Long-transcript behavior stays in central smoke rather than a new speech-specific test file.

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

Every completed Politia `opencodebot` change must finish with a live Compose rebuild/restart and verification; a successful commit and push do not replace this rollout step. Rebuild/restart and check logs with Compose:

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
