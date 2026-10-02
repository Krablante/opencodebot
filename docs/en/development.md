# Development

[English](development.md) · [Русский](../ru/development.md) · [All languages](../README.md)

OpenCodeBot runs directly as Node.js ES modules. There is no compiler, bundler or application framework. Two mdast packages handle CommonMark structure and safe inline formatting; built-in Node APIs cover HTTP, streams, storage and processes. Keep `package-lock.json` committed. Read [architecture](architecture.md) before changing event ownership or recovery.

## Source map

Directories follow concrete boundaries. `src/config/` normalizes installation settings, `src/i18n/` holds UI catalogs, `src/speech/` handles inbound transcription and `src/artifacts/` holds gateway parsing/formatting helpers. The root modules own the bot's related workflows. A directory per tiny helper would make this tree harder to follow.

| Area | Owner |
| --- | --- |
| Startup and composition | `src/main.mjs` |
| Telegram transport / input | `telegram.mjs`, `telegram-polling.mjs`, `telegram-inbox.mjs`, `telegram-rich-message.mjs` |
| Prompt dispatch, buffers and queue | `prompt-routing.mjs`, `prompt-queue.mjs`, `multipart-prompts.mjs`, `attachments.mjs` |
| Backend transport / recovery | `opencode.mjs`, `session-reconcile.mjs`, `backend-backoff.mjs`, `single-flight.mjs` |
| Logical turns / compaction | `logical-turn.mjs`, `compaction-reminders.mjs`, `context-export.mjs` |
| Topic lifecycle and titles | `topic-lifecycle.mjs`, `topic-titles.mjs` |
| General / topic and profile cards / setup | `control-menu.mjs`, `launch-menu.mjs`, `setup.mjs` |
| Saved preferences / durable storage | `user-settings.mjs`, `state.mjs` |
| Visible output | `render.mjs`, `render-side-effects.mjs`, `rich-markdown.mjs`, `rich-list-normalization.mjs`, `tool-formatting.mjs` |
| Commands, questions and notifications | `commands.mjs`, `questions.mjs`, `final-notifications.mjs`, `run-alerts.mjs` |
| Optional voice / artifact transport | `final-voice.mjs`, `speech/`, `artifacts-gateway.mjs`, `artifact-uploads.mjs`, `upload-transfer.mjs` |
| Update protocol / operational health | `update-manager.mjs`, `update-shared.mjs`, `runtime-health.mjs` |

`plugins/opencodebot-artifacts/` is a separately installed agent plugin, with its own package. `skills/telegram-artifact-send/` is the complete companion skill. Bot deployment does not install either into OpenCodez. `scripts/` contains operator commands and the central smoke check; `test/` contains a few API/state contracts. `assets/` contains shipped guides and the attributed word list.

## Checks

For a small change, start with syntax and a bounded manual scenario. Use the existing checks for changes to shared state, transport or delivery. Do not add a test file per helper or formatter branch.

```bash
npm ci
npm run check
npm run docs:check
npm test
npm run smoke
```

The same npm commands work in PowerShell. `check` walks JavaScript files through Node without shell glob expansion. The focused tests protect launch parsing, model/System request shape, queue gates, questions and reconcile/context behavior. Smoke checks configuration, event ordering, timeouts, input isolation, rendering, state recovery, notifications, voice and file transport using disposable data. No-config smoke uses the public example and skips live access.

With an explicit runtime config, `node scripts/smoke.mjs /absolute/config.json` additionally performs read-only Telegram/backend checks and verifies a local dropbox mount. Never start a second poller with the production token. `npm run health:live` checks the running Compose process; `smoke:live` is its compatibility alias.

GitHub Actions runs one job on `main` pushes and pull requests: install locked dependencies, syntax, documentation, focused tests and isolated smoke. Documentation checks validate matching language topic files, local links/anchors, npm commands and JSON examples. The job has no deployment credentials and sends no Telegram messages. Release and production health remain separate operator actions.

## Verify behavior, not just helpers

For prompt/recovery changes, check an idle prompt, a queued prompt after terminal delivery, a failed launch retry, a missing session, and a restart using isolated state. For inbox changes, overlap two topics across fetched batches, hold one handler, finish out of order, and exercise capacity and failed disk writes. Topic order and receipt durability must survive those scenarios.

For file changes, reject oversized input before download, enforce the actual remaining budget, stream a valid file, simulate interrupted transfer and repeat a dropbox filename. Verify final bytes and staging cleanup. Test SSH on a disposable destination on each changed platform; a mock process invocation does not verify a remote shell.

For assistant-formatting changes, inspect local paths, spaces/parentheses/backticks, reference links, images, nested lists and code. Telegram's `savePreparedInlineMessage` with `InputRichMessageContent` checks its real Rich Message parser without publishing. Real send/edit/delete checks and phone-sized previews are still needed for transport and layout. Prepared messages cannot validate every client's pixels.

## UI and guides

```bash
node scripts/preview-ui.mjs /tmp/opencodebot-ui
```

This produces portable HTML previews and printable pages from the actual menu renderers. `OPENCODEBOT_PREVIEW_FONT` and `OPENCODEBOT_PREVIEW_BOLD_FONT` select local Cyrillic-capable fonts. Guide text lives in `src/user-guide.mjs`; regenerate `assets/guide-en.pdf` and `assets/guide-ru.pdf` and inspect the rendered pages whenever text or illustrations change.

User documentation follows `docs/<language-code>/<topic>.md`; [the language index](../README.md) owns the available languages. Add a directory with matching topic filenames, update navigation and keep meaning synchronized in one change. README translations are entry points. UI catalogs have their separate extension rules in [interface language](interface-language.md).

## Change and release

Keep a workflow's state and side effects with its owner. Extract a helper when it separates a real responsibility; avoid parallel routers, copied recovery loops or a new dependency to replace a small stable function. OpenCodez owns canonical message IDs and session history. Runtime files belong outside Git.

Use concise Conventional Commit subjects. The update card turns `feat:`, `fix:` and `perf:` subjects into user-facing notes and groups maintenance commits. Before publishing, inspect status/diff, run checks proportionate to the change, update matching documentation and verify the version matches package metadata.

The release path is [Compose deployment](docker.md#run), followed by live health and a runtime revision check. The image's `OPENCODEBOT_BUILD_SHA` and OCI label must match the committed source. Publish the GitHub release only for the verified revision. Compose/host-runner changes need manual deployment; plugin/skill changes need their own installed-copy rollout. [Self-update](self-update.md) defines that boundary.
