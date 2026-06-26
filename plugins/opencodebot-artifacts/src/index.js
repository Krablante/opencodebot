import { readFile, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
const DEFAULT_MODE = "auto"

export const OpencodebotArtifactsPlugin = async (_input, options = {}) => ({
  id: "opencodebot.artifacts",
  tool: {
    opencodebot_send_artifact: {
      description: `Send a local artifact to the configured opencodebot Telegram artifacts topic.

Use this only when the user explicitly asks to send, upload, share, or forward something to Telegram/TG/opencodebot artifacts. The tool reads file paths locally on the host where this OpenCodez process is running, then uploads bytes to the central opencodebot gateway. It does not need or receive the Telegram bot token.`,
      args: {
        path: { type: "string", description: "Local file path to send. Relative paths resolve from the current project directory. file:// URLs are supported." },
        paths: { type: "array", items: { type: "string" }, description: "Multiple local file paths to send as one batch. Relative paths resolve from the current project directory. file:// URLs are supported." },
        text: { type: "string", description: "Text to send as an expandable quote." },
        caption: { type: "string", minLength: 1, description: "Short context shown with the artifact. Include host/project/action/reason." },
        mode: { type: "string", enum: ["auto", "photo", "document", "text"], description: "How to send the artifact. auto chooses photo for suitable images and document otherwise." },
        filename: { type: "string", description: "Filename override when sending file bytes." },
        contentType: { type: "string", description: "MIME type override for file bytes." },
        maxBytes: { type: "number", description: "Maximum local file size to read, in bytes. Defaults to 50 MiB." },
      },
      async execute(args, context) {
        const gatewayUrl = String(options.gatewayUrl || process.env.OPENCODEBOT_ARTIFACT_GATEWAY_URL || "").replace(/\/$/, "")
        const token = String(options.token || process.env.OPENCODEBOT_ARTIFACT_TOKEN || "")
        if (!gatewayUrl) throw new Error("opencodebot artifact gateway URL is not configured")
        if (!token) throw new Error("opencodebot artifact token is not configured")
        const caption = String(args.caption || "").trim()
        if (!caption) throw new Error("caption is required; include short host/project/action context")
        const mode = args.mode || DEFAULT_MODE
        const filePaths = inputPaths(args, context)
        if (filePaths.length > 1 && mode === "text") throw new Error("mode=text supports only one file path; use mode=document for multiple files")
        if (filePaths.length > 1 && (args.filename || args.contentType)) throw new Error("filename/contentType overrides are only supported for a single file")
        const commonPayload = {
          mode,
          caption,
          captionPaths: filePaths,
          source: sourceMetadata(context),
        }
        const responses = []
        if (args.text && (!filePaths.length || mode !== "text")) {
          responses.push(await sendPayload({ gatewayUrl, token, payload: { ...commonPayload, text: String(args.text) } }))
        }
        if (filePaths.length) {
          if (mode === "text") {
            const payload = { ...commonPayload, text: [args.text ? String(args.text) : "", await readFile(filePaths[0], "utf8")].filter(Boolean).join("\n\n") }
            responses.push(await sendPayload({ gatewayUrl, token, payload }))
          } else {
            for (const filePath of filePaths) {
              const payload = { ...commonPayload, file: await filePayload(filePath, args, Number(args.maxBytes || DEFAULT_MAX_BYTES)) }
              responses.push(await sendPayload({ gatewayUrl, token, payload }))
            }
          }
        }
        if (!responses.length) throw new Error("Provide path, paths, or text")
        const messages = responses.flatMap((body) => body.messages || []).map((message) => {
          const link = message.link ? ` ${message.link}` : ""
          return `${message.method} message_id=${message.messageId}${link}`
        }).join("\n")
        return `Sent artifact to opencodebot Telegram artifacts topic.\n${messages}`
      },
    },
  },
})

export const server = OpencodebotArtifactsPlugin

function resolveLocalPath(value, context) {
  const input = String(value)
  const fileUrlPath = localFileUrlPath(input)
  if (fileUrlPath) return fileUrlPath
  if (path.isAbsolute(input)) return input
  const base = context?.directory || context?.worktree || process.cwd()
  return path.resolve(base, input)
}

function localFileUrlPath(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== "file:") return null
    return fileURLToPath(url)
  } catch {
    return null
  }
}

function inputPaths(args, context) {
  const values = []
  if (args.path) values.push(args.path)
  if (Array.isArray(args.paths)) values.push(...args.paths)
  return [...new Set(values.map((value) => resolveLocalPath(value, context)))]
}

async function sendPayload({ gatewayUrl, token, payload }) {
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
  return body
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
