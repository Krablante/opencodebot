import fs from "node:fs/promises"
import path from "node:path"

export class GroqSpeechClient {
  constructor(config, env = process.env, fetchImpl = globalThis.fetch) {
    this.config = config || {}
    this.env = env
    this.fetch = fetchImpl
  }

  isConfigured() {
    return Boolean(this.apiKey())
  }

  apiKey() {
    return this.config.apiKey || this.env[this.config.apiKeyEnv]
  }

  async transcribeFile(file, modelProfile) {
    const apiKey = this.apiKey()
    if (!apiKey) throw new Error(`Missing ${this.config.apiKeyEnv}`)
    const audio = await fs.readFile(file.localPath)
    const body = new FormData()
    body.append("file", new Blob([audio], { type: file.mime || "application/octet-stream" }), groqFilename(file))
    body.append("model", modelProfile.apiModel)
    if (modelProfile.language) body.append("language", modelProfile.language)
    if (modelProfile.prompt) body.append("prompt", modelProfile.prompt)
    if (modelProfile.responseFormat) body.append("response_format", modelProfile.responseFormat)
    body.append("temperature", String(modelProfile.temperature ?? 0))

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)
    timeout.unref?.()
    try {
      const response = await this.fetch(this.config.url, {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}` },
        body,
      })
      const raw = await response.text()
      if (!response.ok) throw new Error(`Groq STT failed (${response.status}): ${raw.slice(0, 500)}`)
      const text = parseTranscription(raw, modelProfile.responseFormat)
      if (!text) throw new Error("Groq STT returned an empty transcript")
      return {
        text,
        model: modelProfile.apiModel,
        modelProfile,
        raw,
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

function parseTranscription(raw, responseFormat) {
  if (responseFormat === "text") return raw.trim()
  try {
    return String(JSON.parse(raw)?.text || "").trim()
  } catch {
    return raw.trim()
  }
}

function groqFilename(file) {
  const filename = path.basename(file.filename || file.localPath)
  return path.extname(filename).toLowerCase() === ".oga" ? `${filename.slice(0, -4)}.ogg` : filename
}
