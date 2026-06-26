# Artifact Gateway

opencodebot can act as a small Telegram artifact gateway for AI agents. The design is intentionally simple: one central opencodebot instance owns the Telegram bot token and one current Telegram artifacts topic. Agent-side plugins on any LAN host read local files or text and stream the artifact bytes to opencodebot, which then sends the artifact to Telegram.

This avoids guessing the current mirror topic, avoids SSH, and avoids sharing the Telegram bot token with agents.

## Model

```text
agent on any host
  -> OpenCodez plugin reads local path or text
  -> POST http://opencodebot-host:8788/artifacts/send-file for files, /artifacts/send for text
  -> opencodebot sends to the configured Telegram artifacts topic
```

There is one artifacts topic. It is not per host. When `/artifacts_here` is run in another Telegram forum topic, that new topic replaces the old target. The old target is forgotten.

The artifacts topic is not a mirror topic. If it was bound to an OpenCodez session, `/artifacts_here` disables that binding. Ordinary messages and attachments in the artifacts topic are not sent to OpenCodez.

## opencodebot Setup

Enable the gateway in runtime config:

```json
{
  "artifacts": {
    "enabled": true,
    "listenHost": "0.0.0.0",
    "port": 8788,
    "tokenEnvNames": ["OPENCODEBOT_ARTIFACT_TOKEN"]
  }
}
```

Set a shared artifact token in the bot's runtime environment, not in git:

```env
OPENCODEBOT_ARTIFACT_TOKEN=replace-with-a-long-random-token
```

With Docker Compose, expose the gateway port to the LAN:

```yaml
ports:
  - "8788:8788"
```

Start or restart opencodebot, then open the Telegram forum topic that should receive artifacts and run:

```text
/artifacts_here
```

Run the same command in a different topic whenever the artifact inbox should move. The latest topic wins.

## Gateway API

All requests require:

```text
Authorization: Bearer <OPENCODEBOT_ARTIFACT_TOKEN>
```

Status check:

```text
GET /artifacts/status
```

Send text:

```json
{
  "caption": "ser my-app deploy log excerpt",
  "mode": "text",
  "text": "last log lines..."
}
```

Send a file with the streaming endpoint used by the bundled plugin:

```text
POST /artifacts/send-file
Content-Type: application/octet-stream
X-Opencodebot-Artifact-Meta: <base64url JSON metadata>

<raw file bytes>
```

The metadata JSON accepts the same top-level fields as `/artifacts/send`, plus small file metadata:

```json
{
  "caption": "toma ui screenshot after layout fix",
  "mode": "auto",
  "file": { "filename": "screenshot.png", "contentType": "image/png" }
}
```

`mode` can be `auto`, `photo`, `document`, or `text`. `auto` sends suitable JPEG/PNG/WebP files as Telegram photos and everything else as documents. Text artifacts are sent as Telegram MarkdownV2 expandable quotes. In cloud Bot API mode, the gateway keeps the conservative 50 MiB file limit. In local Bot API mode, streamed files are spooled under the shared local Bot API volume and sent to Telegram by local file path, allowing the local Bot API 2 GB file limit.

## OpenCodez Plugin Setup

The bundled plugin lives at:

```text
plugins/opencodebot-artifacts
```

Install or reference it from the OpenCodez environment on each host that should be able to send artifacts. Configure the plugin with the LAN gateway URL and artifact token.

In Politia, `/home/bloob/politia/services/harness/opencodez/deploy.sh` is the live install/update path for the five OpenCodez hosts. It deploys a managed copy of the whole plugin package to `~/.config/opencodez/plugins/opencodebot-artifacts`, writes `~/.config/opencodez/artifacts.env`, points OpenCodez at the package directory, and opens the gateway port from the LAN on the gateway host.

OpenCodez plugin entries can be npm specs, `file://` URLs, relative paths, absolute paths, or `[spec, options]` tuples. Install or vendor the plugin package on each OpenCodez host, then reference the package directory. For a local checkout, a config entry can look like this:

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

On Windows OpenCodez clients, reference the plugin package with a normal absolute path such as `C:\Users\you\opencodebot\plugins\opencodebot-artifacts` or a valid file URL such as `file:///C:/Users/you/opencodebot/plugins/opencodebot-artifacts`.

You can also keep the token out of config and use environment variables:

```text
OPENCODEBOT_ARTIFACT_GATEWAY_URL=http://192.168.1.50:8788
OPENCODEBOT_ARTIFACT_TOKEN=replace-with-the-same-artifact-token
```

The plugin exposes this tool:

```text
opencodebot_send_artifact({ path?, paths?, text?, caption, mode? })
```

If `path` is provided, the plugin reads that file on the local host where the agent is running and streams its bytes to opencodebot. opencodebot on `nuc` does not read remote paths from `ser`, `toma`, `dima`, or `rtx`.

If `path` or `paths` is provided, the plugin resolves each value to an absolute path and the gateway appends a quoted path block to the Telegram caption. One file is shown as its full absolute path. Several files in one directory are shown as the absolute directory followed by comma-separated file names. Files from different directories are listed as absolute file paths. POSIX paths, Windows drive paths, Windows UNC paths, relative paths, and `file://` URLs are supported by the plugin and caption formatter. The gateway treats those paths as display metadata only; file reads happen locally inside the OpenCodez plugin process.

## Skill Setup

The bundled skill lives at:

```text
skills/telegram-artifact-send/SKILL.md
```

Install it into the agent's skills directory or copy it into the deployment's supported skill location. The skill should only trigger for explicit Telegram delivery requests such as “send this screenshot to Telegram”, “скинь лог в TG”, or “закинь файл в artifacts topic”. It should not trigger for local-only requests like “show me the log” or “read this file”.

## Verification

1. Run `/artifacts_here` in the desired Telegram forum topic.
2. Check gateway status with the artifact token.
3. Send a text artifact through the plugin.
4. Send an image file and confirm Telegram shows it as a photo when `mode` is `auto`.
5. Send a non-image file and confirm Telegram receives it as a document.

## Update Prompt

Use this prompt with an AI agent that has access to the repo and runtime:

```text
Update opencodebot artifact gateway, the bundled OpenCodez artifact plugin, and the telegram-artifact-send skill according to docs/artifact-gateway.md. Preserve the model: one central opencodebot gateway, one current artifacts topic selected by /artifacts_here, no SSH, no per-host topics, plugin reads local files and streams bytes, Telegram token remains only in opencodebot. Run checks, rebuild the service, verify gateway status and sample artifact sends, then commit and push.
```
