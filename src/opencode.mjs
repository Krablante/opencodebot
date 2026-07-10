import { durationMs, logErrorEvent, logInfo, shouldLogSlow } from "./logger.mjs"

export const OPENCODE_REQUEST_TIMEOUT_MS = 120_000

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

  async listSessions(serverID, options = {}) {
    const server = this.server(serverID)
    return this.request(server, "/session", this.requestOptions(server, options))
  }

  async getSession(serverID, sessionID, options = {}) {
    return this.request(this.server(serverID), `/session/${encodeURIComponent(sessionID)}`, options)
  }

  async createSession(serverID, options = {}) {
    return this.request(this.server(serverID), "/session", { ...options, method: "POST" })
  }

  async messages(serverID, sessionID, options = {}) {
    return this.request(this.server(serverID), `/session/${encodeURIComponent(sessionID)}/message`, options)
  }

  async promptAsync(serverID, sessionID, payload, options = {}) {
    return this.request(this.server(serverID), `/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      ...options,
      method: "POST",
      body: payload,
    })
  }

  async abortSession(serverID, sessionID, options = {}) {
    return this.request(this.server(serverID), `/session/${encodeURIComponent(sessionID)}/abort`, {
      ...options,
      method: "POST",
    })
  }

  async selectSystemPrompt(serverID, sessionID, name, options = {}) {
    return this.request(this.server(serverID), "/opencodez/prompts/select", {
      ...options,
      method: "POST",
      body: { sessionID, name },
    })
  }

  async request(server, pathname, options = {}) {
    const url = this.url(server, pathname, options)
    const headers = { ...(options.headers || {}) }
    if (options.body !== undefined) headers["content-type"] = "application/json"
    const auth = this.authHeader()
    if (auth) headers.authorization = auth
    const response = await fetchWithTimeout(url, {
      method: options.method || "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    }, OPENCODE_REQUEST_TIMEOUT_MS, `OpenCodez ${server.id} ${pathname}`)
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
    const requestOptions = this.requestOptions(server, { mirror: true })
    let retryDelayMs = 2500
    let offlineSince = 0
    let lastOfflineLogAt = 0
    while (!signal?.aborted) {
      try {
        const url = this.url(server, "/event", requestOptions)
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

  url(server, pathname, options = {}) {
    const url = new URL(pathname, `${server.url}/`)
    const directory = cleanDirectory(options.directory)
    if (directory) {
      url.searchParams.set("directory", directory)
    }
    return url
  }

  requestOptions(server, options = {}) {
    if (options.mirror && this.config.opencode.mirrorScope === "serverHome") {
      return { ...options, directory: options.directory || server.home }
    }
    return options
  }

  defaultNewSessionDirectory(serverID) {
    if (this.config.opencode.newSessionDefaultDirectory !== "serverHome") return undefined
    return this.server(serverID).home || undefined
  }

  authHeader() {
    const password = this.config.opencode.password
    if (!password) return undefined
    return `Basic ${Buffer.from(`:${password}`).toString("base64")}`
  }
}

function cleanDirectory(value) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
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
    "Saved Telegram attachment(s):",
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
    const model = message.model && typeof message.model === "object"
      ? normalizeModel(message.model)
      : message.providerID && (message.modelID || message.model)
        ? { providerID: message.providerID, modelID: message.modelID || message.model, variant: message.variant }
        : undefined
    return {
      agent: message.agent,
      model,
    }
  }
  return {}
}

export function textFromPrompt(prompt) {
  if (!prompt) return ""
  if (typeof prompt === "string") return prompt
  if (typeof prompt.text === "string") return prompt.text
  if (Array.isArray(prompt.parts)) return visibleTextFromParts(prompt.parts)
  return ""
}

export function visibleTextFromParts(parts, joiner = "\n") {
  return (parts || [])
    .filter((part) => part?.type === "text" && part.synthetic !== true && typeof part.text === "string")
    .map((part) => part.text)
    .join(joiner)
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
      let event
      try {
        event = JSON.parse(data)
      } catch {
        continue
      }
      const startedAt = Date.now()
      try {
        await onEvent(event)
      } catch (error) {
        logErrorEvent("opencode.event.handler.error", error, { type: event.type })
      } finally {
        const elapsedMs = durationMs(startedAt)
        if (shouldLogSlow(elapsedMs)) logInfo("opencode.event.handler.slow", { type: event.type, durationMs: elapsedMs })
      }
    }
  }
}

async function fetchWithTimeout(url, options, defaultTimeoutMs, label) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : defaultTimeoutMs
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`${label} timed out after ${formatDuration(timeoutMs)}`)), timeoutMs)
  const onAbort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) onAbort()
  else options.signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const { timeoutMs: _timeoutMs, signal: _signal, ...fetchOptions } = options
    return await fetch(url, { ...fetchOptions, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) throw new Error(`${label} timed out after ${formatDuration(timeoutMs)}`, { cause: error })
    throw error
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener?.("abort", onAbort)
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
