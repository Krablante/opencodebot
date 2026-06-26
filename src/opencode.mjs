import { durationMs, logErrorEvent, logInfo, shouldLogSlow } from "./logger.mjs"

export class OpenCodeClient {
  constructor(config) {
    this.config = config
    this.servers = new Map(config.opencode.servers.map((server) => [server.id, server]))
  }

  server(id) {
    const server = this.servers.get(id)
    if (!server) throw new Error(`Unknown OpenCodez server: ${id}`)
    return server
  }

  async listSessions(serverID) {
    return this.request(this.server(serverID), "/session")
  }

  async getSession(serverID, sessionID) {
    return this.request(this.server(serverID), `/session/${encodeURIComponent(sessionID)}`)
  }

  async createSession(serverID) {
    return this.request(this.server(serverID), "/session", { method: "POST" })
  }

  async messages(serverID, sessionID) {
    return this.request(this.server(serverID), `/session/${encodeURIComponent(sessionID)}/message`)
  }

  async promptAsync(serverID, sessionID, payload) {
    return this.request(this.server(serverID), `/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      method: "POST",
      body: payload,
    })
  }

  async selectPromptTemplate(serverID, sessionID, name, model) {
    const body = { sessionID, kind: "template", name }
    const normalizedModel = promptModel(model)
    if (normalizedModel) body.model = normalizedModel
    return this.request(this.server(serverID), "/opencodez/prompts/select", { method: "POST", body })
  }

  async request(server, pathname, options = {}) {
    const url = this.url(server, pathname)
    const headers = { ...(options.headers || {}) }
    if (options.body !== undefined) headers["content-type"] = "application/json"
    const auth = this.authHeader()
    if (auth) headers.authorization = auth
    const response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`OpenCodez ${server.id} ${pathname} failed: ${response.status} ${text.slice(0, 200)}`)
    }
    if (response.status === 204) return null
    const contentType = response.headers.get("content-type") || ""
    if (contentType.includes("application/json")) return response.json()
    const text = await response.text()
    return text ? JSON.parse(text) : null
  }

  async subscribeEvents(serverID, onEvent, signal) {
    const server = this.server(serverID)
    let retryDelayMs = 2500
    let offlineSince = 0
    let lastOfflineLogAt = 0
    while (!signal?.aborted) {
      try {
        const url = this.url(server, "/event")
        const headers = {}
        const auth = this.authHeader()
        if (auth) headers.authorization = auth
        const response = await fetch(url, { headers, signal })
        if (!response.ok || !response.body) throw new Error(`event stream failed: ${response.status}`)
        if (offlineSince) console.info(`[opencodebot] ${serverID} event stream recovered`)
        retryDelayMs = 2500
        offlineSince = 0
        lastOfflineLogAt = 0
        await readSse(response.body, (event) => onEvent(server, event), signal)
        if (!signal?.aborted) throw new Error("event stream closed")
      } catch (error) {
        if (signal?.aborted) return
        const now = Date.now()
        if (!offlineSince) offlineSince = now
        if (!lastOfflineLogAt || now - lastOfflineLogAt >= 600_000) {
          const state = lastOfflineLogAt ? `still offline after ${formatDuration(now - offlineSince)}` : "offline"
          console.warn(`[opencodebot] ${serverID} event stream ${state}: ${error.message}; retrying in ${formatDuration(retryDelayMs)}`)
          lastOfflineLogAt = now
        }
        await delay(retryDelayMs, signal)
        retryDelayMs = Math.min(retryDelayMs * 2, 120_000)
      }
    }
  }

  url(server, pathname) {
    const url = new URL(pathname, `${server.url}/`)
    if (this.config.opencode.useServerHomeAsDirectory && server.home) {
      url.searchParams.set("directory", server.home)
    }
    return url
  }

  authHeader() {
    const password = this.config.opencode.password
    if (!password) return undefined
    return `Basic ${Buffer.from(`:${password}`).toString("base64")}`
  }
}

export function promptPayload(text, profile, files = []) {
  const inlineFiles = (files || []).filter((file) => file?.type !== "saved_file" && file?.url)
  const savedFiles = (files || []).filter((file) => file?.type === "saved_file")
  const promptText = [savedFilesText(savedFiles), text].filter(Boolean).join("\n\n")
  const payload = {
    parts: [...fileParts(inlineFiles), { type: "text", text: promptText }],
  }
  if (profile?.agent) payload.agent = profile.agent
  if (profile?.model) {
    const model = normalizeModel(profile.model)
    payload.model = { providerID: model.providerID, modelID: model.modelID }
    if (model.variant) payload.variant = model.variant
  }
  return payload
}

function fileParts(files) {
  return (files || []).map((file) => ({
    type: "file",
    mime: file.mime || "application/octet-stream",
    filename: file.filename,
    url: file.url,
  }))
}

function savedFilesText(files) {
  if (!files.length) return ""
  return [
    "Telegram attachments saved locally because they are too large to inline safely:",
    ...files.map((file) => `- ${file.filename || "file"} (${formatBytes(file.size)}, ${file.mime || "application/octet-stream"}): ${file.path || file.localPath}`),
  ].join("\n")
}

function formatBytes(value) {
  const bytes = Number(value || 0)
  if (!Number.isFinite(bytes) || bytes <= 0) return "unknown size"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

function promptModel(model) {
  const value = normalizeModel(model)
  if (!value?.modelID) return undefined
  return { providerID: value.providerID, id: value.modelID }
}

export function profileFromSession(session) {
  if (!session) return {}
  return {
    agent: session.agent,
    model: session.model ? normalizeModel(session.model) : undefined,
  }
}

export function profileFromMessages(messages) {
  if (!Array.isArray(messages)) return {}
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]?.info || messages[index]
    if (message?.role !== "user") continue
    const model = message.model
      ? { providerID: message.providerID, modelID: message.modelID || message.model, variant: message.model?.variant }
      : message.providerID && message.modelID
        ? { providerID: message.providerID, modelID: message.modelID, variant: message.variant }
        : undefined
    return {
      agent: message.agent,
      model: model ? normalizeModel(model) : undefined,
    }
  }
  return {}
}

export function textFromPrompt(prompt) {
  if (!prompt) return ""
  if (typeof prompt === "string") return prompt
  if (typeof prompt.text === "string") return prompt.text
  if (Array.isArray(prompt.parts)) {
    return prompt.parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
  }
  return ""
}

export function titleFromText(text, fallback = "OpenCodez") {
  const line = String(text || "")
    .split(/\r?\n/)
    .find((item) => item.trim())
  return (line || fallback).replace(/\s+/g, " ").trim().slice(0, 80)
}

function normalizeModel(model) {
  if (!model) return undefined
  return {
    providerID: model.providerID,
    modelID: model.modelID || model.id,
    variant: model.variant,
  }
}

async function readSse(body, onEvent, signal) {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ""
  while (!signal?.aborted) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const packet = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = packet
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (!data) continue
      try {
        const event = JSON.parse(data)
        const result = onEvent(event)
        if (result && typeof result.then === "function") {
          const startedAt = Date.now()
          result
            .then(() => {
              const elapsedMs = durationMs(startedAt)
              if (shouldLogSlow(elapsedMs)) logInfo("opencode.event.handler.slow", { type: event.type, durationMs: elapsedMs })
            })
            .catch((error) => logErrorEvent("opencode.event.handler.error", error, { type: event.type }))
        }
      } catch {
        // Ignore malformed keepalive or partial data.
      }
    }
  }
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`
}
