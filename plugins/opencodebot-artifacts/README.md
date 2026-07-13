# opencodebot artifacts plugin

OpenCodez plugin for sending local files or text to an opencodebot Telegram artifacts topic.

The plugin reads `path`/`paths` locally on the host where the OpenCodez agent is running and streams file bytes to the central opencodebot artifact gateway. It does not need the Telegram bot token.

## Configuration

Set these values in the OpenCodez runtime environment or pass them as plugin options:

```env
OPENCODEBOT_ARTIFACT_GATEWAY_URL=http://192.168.1.50:8788
OPENCODEBOT_ARTIFACT_TOKEN=replace-with-artifact-token
```

Install or vendor this package in the OpenCodez environment, then reference the package directory. Example OpenCodez config entry:

```jsonc
{
  "plugin": [
    [
      "/path/to/opencodebot/plugins/opencodebot-artifacts",
      {
        "gatewayUrl": "http://192.168.1.50:8788",
        "token": "replace-with-artifact-token"
      }
    ]
  ]
}
```

## Tool

```text
opencodebot_send_artifact({ path?, paths?, text?, caption, mode? })
```

`caption` is required and should be short: host/project/action/reason. Use `mode: "auto"` by default. `photo` is an inline-display preference; oversized or rejected photos are delivered as lossless documents. Use `document` for exact file delivery and `text` for logs or snippets that should be sent as an expandable quote.

File sends use the gateway streaming endpoint. When opencodebot runs with its local Telegram Bot API sidecar, the gateway can hand the spooled file to Telegram by local path and use Telegram's higher local Bot API limits. Telegram-visible file names preserve the requested file basename; unique spool IDs live in parent directories, not in the uploaded filename.

When `path` or `paths` is used, the gateway appends a quoted path block to the Telegram caption. Each streamed file message shows the path for that file only. If `text` is sent alongside a batch, the separate text message may include the full batch path list as context.

Example batch send:

```json
{
  "paths": ["./screenshots/home.png", "./screenshots/settings.png"],
  "caption": "nuc/opencodebot/screenshots/settings check",
  "mode": "auto"
}
```

Do not use this tool unless the user explicitly asks to send something to Telegram/TG/opencodebot artifacts.
