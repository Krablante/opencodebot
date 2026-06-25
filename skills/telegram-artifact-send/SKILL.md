---
name: telegram-artifact-send
description: Use only when the user explicitly asks to send, upload, share, forward, post, or drop a file, screenshot, image, log, or text artifact to Telegram, TG, or an opencodebot artifacts topic. Do not use for ordinary local requests to show, read, inspect, summarize, print, display, or explain content unless the user also asks to send it to Telegram.
---

# Telegram Artifact Send

Send artifacts to the configured Telegram artifacts topic through the `opencodebot_send_artifact` OpenCodez plugin tool.

Use this only when Telegram delivery is explicit. Good triggers include “send this file to Telegram”, “скинь скрин в телеграм”, “upload the log to TG”, “закинь это в artifacts topic”, or “forward this screenshot to opencodebot”. Do not use it for local-only requests such as “show me the log”, “read this file”, “take a screenshot and describe it”, or “print this output”.

## Workflow

1. Identify exactly what should be delivered: an existing file, a batch of files, a newly created artifact, or a text snippet.
2. Keep file paths host-local. The plugin reads `path`/`paths` on the host where the agent is running, then uploads bytes to the central opencodebot gateway.
3. Prefer `text` for short logs, command output, snippets, or notes. Do not create a temporary file just to send text unless the user asked for an attachment.
4. Pick the send mode from the guide below.
5. Use a compact caption in this shape: `host/project/artifact/reason`.
6. Call `opencodebot_send_artifact` with `path`, `paths`, or `text`, `caption`, and only the needed optional fields.
7. Report the result with the returned Telegram method/message id/link. If sending fails, state the concrete blocker from the tool error.

## Mode Guide

Use `auto` for ordinary files and images when no special handling matters. Use `photo` for images/screenshots that should render inline in Telegram. Use `document` for exact file delivery, archives, PDFs, raw screenshots, and logs as files. Use `text` for pasted output, short logs, snippets, or notes that should appear as an expandable quote.

## Path Quote

For file artifacts, use `path` for one file and `paths` for multiple files. The plugin resolves them to absolute local paths and the Telegram caption gets an extra quoted path block after the main caption.

The quote block is automatic. Do not duplicate paths in the main caption.

For one file, the quote contains the full absolute path. For several files in one directory, the quote contains the absolute directory on one line and the file names comma-separated on the next line. For files from different directories, the quote contains each absolute file path on its own line.

## Tool Use

Use the tool directly. Do not ask opencodebot to read a remote path and do not guess a Telegram topic; the gateway owns the target artifacts topic.

Examples:

```json
{
  "path": "/tmp/opencodebot-smoke.png",
  "caption": "nuc/opencodebot/screenshot/artifact gateway smoke",
  "mode": "photo"
}
```

```json
{
  "paths": ["./screenshots/home.png", "./screenshots/settings.png"],
  "caption": "nuc/opencodebot/screenshots/settings check",
  "mode": "photo"
}
```

```json
{
  "text": "last 80 lines of the service log...",
  "caption": "ser/app/log/failed deploy check",
  "mode": "text"
}
```

```json
{
  "path": "./dist/report.pdf",
  "caption": "dima/report/document/final PDF",
  "mode": "document"
}
```

## Output

After the tool succeeds, keep the reply short:

```text
Sent to Telegram: sendDocument message_id=12345 https://t.me/c/.../12345
```

If the tool fails, keep the reply just as concrete:

```text
Could not send it: file is larger than maxBytes.
```
