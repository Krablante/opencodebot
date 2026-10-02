# First run and upgrades

[English](first-run.md) · [Русский](../ru/first-run.md)

Have a running OpenCodez server, Node 22+, a BotFather token and your numeric Telegram user ID ready. Run `npm run setup` in the checkout. The installer asks for the server URL, optional password, home directory and artifact gateway URL, then writes private configuration, generates the artifact token, and prepares local writable paths and Compose mounts. Existing files and server entries are preserved. A gateway URL must be reachable from the OpenCodez host; it is not necessarily the bot container's address.

Start with `npm run deploy:bot` for Docker, or `npm ci` then `npm start` for Node. Use a clean Git checkout for deployment. For Windows server paths, use native Node or SSH transfer from a Linux container; do not assume drive-letter paths are writable container paths. The detailed path rules remain in [Docker](docker.md).

Add the bot to a forum-enabled group and run `/setup`. It checks administrator, Manage topics, Pin messages and Delete messages rights. It creates FILES and AUDIO only when their bindings are missing, keeps existing special topics, and pins concise instructions. It opens General and sends the first guide page. Repeating setup continues the same configuration.

Pin General, FILES and AUDIO in the topic list manually: Bot API cannot pin the topics themselves. Open the private bot chat and press Start once to allow notifications. Final-answer notifications then enable automatically; explicit disabling is retained in personal preferences. When a separate recipient list was not configured, allowed operator IDs are the recipients.

## AUDIO

Choose Connect / change Groq in setup. Register at https://console.groq.com/home and create a key in API Keys. Send it in the same topic where the bot asked for it. The input is restricted to the allowed operator and that topic for 15 minutes. The bot checks the key against Groq's model endpoint and selects `whisper-large-v3-turbo`. The free tier has limits.

Keys are removed from incoming updates before the Telegram receipt journal is written. The key message is deleted best-effort, and the accepted key is stored in owner-only `provider-secrets.json` beside bot state. It is never placed in preference state, logs, diagnostics or the ordinary inbox. The original Telegram message is still part of Telegram's cloud transport; deletion cannot undo delivery to a group member who already saw it.

Existing OpenRouter/direct-Groq settings remain usable. Adding a key through Telegram creates a durable override without editing read-only container configuration. AUDIO transcripts remain copyable drafts and never start OpenCodez prompts automatically.

## FILES

Setup shows gateway readiness separately from confirmed artifact delivery and incoming-file storage. Enable artifact gateway generates a private token if needed and starts the listener. Compose already publishes its configured port; standalone deployments must make it reachable on a trusted network.

Artifact plugin instructions provide a reusable agent prompt and the configured gateway URL. The separate artifact token is sent to your private bot chat; open that chat and press Start first. Install the bundled plugin and the complete `telegram-artifact-send` skill. Finish by sending a small file to FILES. Successful delivery records bounded host metadata so the bot can show a confirmed connection. No heartbeat or OpenCodez restart is required merely to check an existing transport. Incoming-file storage needs its own writable mount or SSH transfer; plugin delivery alone does not verify it.

## Existing installations

Before a rollout, stop the bot and back up its config, state, provider secrets, Telegram inbox and mirror-marker journals. Preserve the local Bot API volume. Do not run a second Telegram poller with the production token.

The first new start imports the effective former profiles into `state.json` preferences. Bindings, pending topics, notifications and delivery markers remain in their original owners. After import, Telegram preferences own the profile collection and default selection; configuration profiles are installation seeds, not a second editable catalog. Old shortcuts remain supported by the same command handlers. Deleted profiles stay deleted, while retained topic snapshots keep reset/retry usable.

For rollback, restore the stopped-bot backup along with the previous image. A code-only rollback does not undo migrated preferences, newly rotated menu references or new incoming receipts. See [state compatibility](config-runtime.md#paths-and-state) before restoring older journal versions.
