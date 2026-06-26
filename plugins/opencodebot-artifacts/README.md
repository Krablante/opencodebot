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

`caption` is required and should be short: host/project/action/reason. Use `mode: "auto"` by default, `photo` for image display, `document` for exact file delivery, and `text` for logs or snippets that should be sent as an expandable quote.

File sends use the gateway streaming endpoint. When opencodebot runs with its local Telegram Bot API sidecar, the gateway can hand the spooled file to Telegram by local path and use Telegram's higher local Bot API limits.

When `path` or `paths` is used, the gateway appends a quoted path block to the Telegram caption. One file is shown as a full absolute path. Multiple files in one directory are shown as the absolute directory plus comma-separated file names. Files from different directories are listed as absolute paths.

Example batch send:

```json
{
  "paths": ["./screenshots/home.png", "./screenshots/settings.png"],
  "caption": "nuc/opencodebot/screenshots/settings check",
  "mode": "photo"
}
```

Do not use this tool unless the user explicitly asks to send something to Telegram/TG/opencodebot artifacts.
