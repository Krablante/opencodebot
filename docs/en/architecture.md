# Architecture

[English](architecture.md) · [Русский](../ru/architecture.md) · [All languages](../README.md)

OpenCodeBot is one Node process between Telegram and OpenCodez. OpenCodez owns execution, canonical message IDs, history and the web workspace. The bot owns Telegram topics, input routing, delivery records and preferences. It rebuilds conversation details from OpenCodez instead of maintaining a second history database.

```text
Telegram updates → durable inbox → ordered topic handlers → OpenCodez API
                                                           ↓
Telegram messages ← renderer ← event/recovery coordinator ← one SSE per server
```

## Boundaries

The [source map](development.md#source-map) identifies the owners. These are the contracts that matter when a change crosses them:

- Transport unwraps global `{directory, payload}` events once. Event handlers see one shape in both scopes.
- Polling saves incoming updates before advancing Telegram's acknowledgement cursor. Topic handlers complete independently; a slow backend cannot block later fetches.
- Topic creation saves a pending launch first. Its first prompt creates one session under per-topic single-flight, binds it before model/System mutations and applies the saved snapshot. Discovery cannot create a second topic from those setup events.
- Reconcile and live recovery share per-session operation lanes. Duplicate fallback requests coalesce; primary events wait behind an active recovery rather than disappearing.
- Rendering receives only identified main-session text/tool parts. Reasoning and unknown text deltas cannot enter Telegram. Hidden child sessions and exact normalized `opencode-see delegate` sessions stay private.
- Preferences become Telegram-owned after one import. Installation configuration remains the owner of credentials, endpoints, mounts and provider limits.

The artifact gateway is an optional listener inside this process. The agent plugin reads a file on its own host and streams bytes with a separate token; gateway JSON never authorizes filesystem reads. Incoming FILES uploads use local mounts or SSH independently. Transcription and final voice call external providers; the bot image contains no inference runtime.

## Event and queue gates

A live text block becomes visible when its completed part arrives; assistant completion finalizes delivery. Exact-message reads recover missing lifecycle data. They are not a request for every healthy delta.

Queued prompts require both backend idle and the previous terminal outcome delivered in Telegram. Either signal may arrive first. An idle check reads the current logical turn when needed and mirrors its missing final before releasing the queue. Failed or interrupted runs receive one terminal notice; expected kill/reset/rewind stops stay silent. Questions hold the gate open until answered. Manual compaction has its own in-flight queue hold.

`logical-turn.mjs` follows durable compaction `turn_id`/`replay_id` and reminder links. Reconcile, context export, duration/token accounting and reminders agree on the original external request. Internal summaries are handled without being mirrored. Automatic mid-run reminders rebuild payloads from the backend and require admission confirmation before the Telegram notice. An automatic replay already persisted by OpenCodez, including pre-turn, is acknowledged through the same notice without another prompt submission.

## Recovery and limits

SSE is primary. Discovery uses cursor pages and a five-minute overlapping high-water mark. Message recovery starts with five messages and then twenty-message pages, stopping at the saved cursor, active window or logical-turn boundary. Reconnect catch-up visits only recent/leased/queued bindings and caps each at five pages. Different servers recover concurrently; work within each server remains ordered. Unchanged sessions get a bounded lightweight watchdog instead of repeated history downloads.

The one-minute watchdog also checks the outcome of a tracked unfinished run, even when the session's update timestamp is unchanged. Reconnection verifies unfinished recovered turns. Once the backend is idle, a fresh history read and a second idle check distinguish a missing final answer from ongoing work, questions and expected stops. A confirmed interruption posts a topic warning and follows the existing alert path; its durable marker prevents normal repeat notifications. Idle and delivered-terminal queue gates are released together so the next queued run retains its own gates.

Ordinary HTTP requests, including response-body reads, have two-minute deadlines. `/session` inspection uses concurrent five-second requests. Manual compaction permits 21 minutes for OpenCodez's 20-minute budget. File transfers have 15-minute deadlines; SSH connects within ten seconds. Shared host backoff applies to transport/timeouts, `408`, `429` and `5xx`; a confirmed session `404` removes only that session's state.

The inbox holds at most 1,000 pending updates and pauses intake at 16 MiB, with one fetched batch permitted to cross the byte threshold. Handlers run two at a time per backend, with separate control, speech and upload groups. Additional bounded memory queues and storage formats are documented in [state](config-runtime.md#paths-and-state).

The gateway admits four uploads/deliveries at a time and returns `503` with `Retry-After` beyond that. File bodies stream to owned spool directories; completed/failed deliveries remove them. Hourly cleanup removes recognized abandoned spools older than 24 hours. Cloud multipart delivery has a 32 MiB memory cap; local Bot API sends a shared file path and supports its 2 GB limit without loading the whole file into bot RAM.

Durability covers recorded receipts and delivery identifiers. A crash between an external side effect and its marker can repeat the action. Queued prompts, personal drafts and unfinished voice work disappear on restart. Neither the inbox nor successful markers promise exactly-once network delivery. Keep their backups together and preserve corrupt data for deliberate recovery.

`health:live` checks the actual process, polling/reconcile progress, Telegram and required discovery APIs. A stopped recovery loop initiates shutdown; Compose restarts the process. Shutdown cancels ordinary requests, flushes deferred state and allows eight seconds before exit. State, upload and journal details belong in the [runtime reference](config-runtime.md), deployment in [Docker](docker.md).

## Deliberate tradeoffs

JSON plus append journals fit an operated forum bot: no database service, worker bus or second deployment path. Delivery indexes cost memory proportional to retained IDs, while lookup cost stays constant. Disabled binding history grows with real session history and is preserved to keep topic stops, names and old session references meaningful. A very large installation should measure that retained metadata and journal compaction before adding a database.

Per-server ordered event handling protects delivery order but lets a slow Telegram send delay another session on the same server. Cross-topic input and cross-server recovery remain independent. Splitting live events into session lanes would require ordering guarantees for sessionless events and bounded admission; it is a tradeoff, not a free optimization.
