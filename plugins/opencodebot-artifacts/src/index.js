import { readFile, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { tool } from "@opencode-ai/plugin"

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
const DEFAULT_MODE = "auto"

export const OpencodebotArtifactsPlugin = async (_input, options = {}) => ({
  id: "opencodebot.artifacts",
  tool: {
    opencodebot_send_artifact: tool({
      description: `Send a local artifact to the configured opencodebot Telegram artifacts topic.

Use this only when the user explicitly asks to send, upload, share, or forward something to Telegram/TG/opencodebot artifacts. The tool reads file paths locally on the host where this OpenCodez process is running, then uploads bytes to the central opencodebot gateway. It does not need or receive the Telegram bot token.`,
      args: {
        path: tool.schema.string().optional().describe("Local file path to send. Relative paths resolve from the current project directory."),
        text: tool.schema.string().optional().describe("Text to send as an expandable quote."),
        caption: tool.schema.string().min(1).describe("Short context shown with the artifact. Include host/project/action/reason."),
        mode: tool.schema.enum(["auto", "photo", "document", "text"]).optional().describe("How to send the artifact. auto chooses photo for suitable images and document otherwise."),
        filename: tool.schema.string().optional().describe("Filename override when sending file bytes."),
        contentType: tool.schema.string().optional().describe("MIME type override for file bytes."),
        maxBytes: tool.schema.number().optional().describe("Maximum local file size to read, in bytes. Defaults to 50 MiB."),
      },
      async execute(args, context) {
        const gatewayUrl = String(options.gatewayUrl || process.env.OPENCODEBOT_ARTIFACT_GATEWAY_URL || "").replace(/\/$/, "")
        const token = String(options.token || process.env.OPENCODEBOT_ARTIFACT_TOKEN || "")
        if (!gatewayUrl) throw new Error("opencodebot artifact gateway URL is not configured")
        if (!token) throw new Error("opencodebot artifact token is not configured")
        const mode = args.mode || DEFAULT_MODE
        const payload = {
          mode,
          caption: args.caption,
          source: sourceMetadata(context),
        }
        if (args.text) payload.text = String(args.text)
        if (args.path) {
          const filePath = resolveLocalPath(args.path, context)
          if (mode === "text") {
            payload.text = [payload.text, await readFile(filePath, "utf8")].filter(Boolean).join("\n\n")
          } else {
            payload.file = await filePayload(filePath, args, Number(args.maxBytes || DEFAULT_MAX_BYTES))
          }
        }
        if (!payload.text && !payload.file) throw new Error("Provide path or text")

        const response = await fetch(`${gatewayUrl}/artifacts/send`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok || body.ok === false) {
          throw new Error(`opencodebot artifact send failed: ${body.message || body.error || response.status}`)
        }
        const messages = (body.messages || []).map((message) => {
          const link = message.link ? ` ${message.link}` : ""
          return `${message.method} message_id=${message.messageId}${link}`
        }).join("\n")
        return `Sent artifact to opencodebot Telegram artifacts topic.\n${messages}`
      },
    }),
  },
})

export const server = OpencodebotArtifactsPlugin

function resolveLocalPath(value, context) {
  const input = String(value)
  if (path.isAbsolute(input)) return input
  const base = context?.directory || context?.worktree || process.cwd()
  return path.resolve(base, input)
}

async function filePayload(filePath, args, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive number")
  const info = await stat(filePath)
  if (!info.isFile()) throw new Error(`Not a file: ${filePath}`)
  if (info.size > maxBytes) throw new Error(`File is too large (${info.size} bytes; max ${maxBytes})`)
  const bytes = await readFile(filePath)
  return {
    filename: args.filename || path.basename(filePath),
    contentType: args.contentType || contentTypeForPath(filePath),
    dataBase64: bytes.toString("base64"),
  }
}

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".log": "text/plain",
    ".md": "text/markdown",
    ".txt": "text/plain",
  }[ext] || "application/octet-stream"
}

function sourceMetadata(context) {
  return {
    host: os.hostname(),
    directory: context?.directory,
    worktree: context?.worktree,
  }
}
