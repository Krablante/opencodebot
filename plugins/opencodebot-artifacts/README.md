# opencodebot artifacts plugin

OpenCodez plugin for sending local files or text to an opencodebot Telegram artifacts topic.

The plugin reads `path` locally on the host where the OpenCodez agent is running, encodes the file bytes, and uploads them to the central opencodebot artifact gateway. It does not need the Telegram bot token.

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
opencodebot_send_artifact({ path?, text?, caption, mode? })
```

`caption` is required and should be short: host/project/action/reason. Use `mode: "auto"` by default, `photo` for image display, `document` for exact file delivery, and `text` for logs or snippets that should be sent as an expandable quote.

Do not use this tool unless the user explicitly asks to send something to Telegram/TG/opencodebot artifacts.
