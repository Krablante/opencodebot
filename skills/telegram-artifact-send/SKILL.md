---
name: telegram-artifact-send
description: Use only when the user explicitly asks to send, upload, share, forward, post, or drop a file, screenshot, image, log, or text artifact to Telegram, TG, or an opencodebot artifacts topic. Do not use for ordinary local requests to show, read, inspect, summarize, print, display, or explain content unless the user also asks to send it to Telegram.
---

# Telegram Artifact Send

This skill sends artifacts to a Telegram artifacts topic through the `opencodebot_send_artifact` OpenCodez plugin tool.

Use it only when Telegram delivery is explicit. Good triggers include “send this file to Telegram”, “скинь скрин в телеграм”, “upload the log to TG”, “закинь это в artifacts topic”, or “forward this screenshot to opencodebot”. Do not use it for “show me the log”, “read this file”, “take a screenshot and describe it”, “print my gh username/email”, or similar local-only requests.

## Workflow

1. Identify or create the artifact the user wants delivered.
2. If the artifact is a local file, keep the path on the same host where the agent is running. The plugin reads paths locally and uploads bytes to the central opencodebot gateway.
3. If the artifact is text, pass it as `text` instead of creating a temporary file unless the user needs a file attachment.
4. Write a short caption with context: host, project or directory, what the artifact is, and why it is being sent.
5. Call `opencodebot_send_artifact` with `path` or `text`, the caption, and `mode` when needed.
6. Tell the user that the artifact was sent and include the returned Telegram message id or link.

## Tool Use

Use `mode: "auto"` by default. Use `mode: "photo"` only when the user wants an image displayed as a Telegram photo. Use `mode: "document"` when exact file delivery matters. Use `mode: "text"` for logs, command output, snippets, or notes that should appear as an expandable quote.

Examples:

```json
{
  "path": "/tmp/opencodebot-smoke.png",
  "caption": "nuc opencodebot smoke screenshot after artifact gateway update",
  "mode": "auto"
}
```

```json
{
  "text": "last 80 lines of the service log...",
  "caption": "ser app log excerpt for failed deploy check",
  "mode": "text"
}
```

## Guardrails

- Do not send secrets, tokens, private keys, or credential files.
- Do not use this skill unless the user clearly asked for Telegram delivery.
- Do not guess a mirror topic or session. The opencodebot gateway owns the target artifacts topic.
- Do not ask opencodebot to read a remote path. The plugin reads the file locally and uploads bytes.
- Keep captions concise and useful; avoid long explanations in the caption.
