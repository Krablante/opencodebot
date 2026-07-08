import fs from "node:fs/promises"
import path from "node:path"

export class OpenRouterSpeechClient {
  constructor(config, env = process.env, fetchImpl = globalThis.fetch) {
    this.config = config
    this.env = env
    this.fetch = fetchImpl
  }

  isConfigured() {
    return Boolean(this.apiKey())
  }

  apiKey() {
    return this.config.apiKey || this.env[this.config.apiKeyEnv]
  }

  async transcribeFile(file) {
    const apiKey = this.apiKey()
    if (!apiKey) throw new Error(`Missing ${this.config.apiKeyEnv}`)
    const audio = await fs.readFile(file.localPath)
    const format = audioFormat(file)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)
    timeout.unref?.()
    try {
      const response = await this.fetch(this.config.url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": this.config.referer,
          "X-Title": this.config.title,
        },
        body: JSON.stringify(this.requestBody(audio, format)),
      })
      const bodyText = await response.text()
      const parsed = parseJson(bodyText)
      if (!response.ok) {
        const message = openRouterErrorMessage(parsed, bodyText)
        throw new Error(`OpenRouter STT failed (${response.status}): ${message}`)
      }
      const text = typeof parsed?.text === "string" ? parsed.text.trim() : ""
      if (!text) throw new Error("OpenRouter STT returned an empty transcript")
      return {
        text,
        model: this.config.model,
        format,
        raw: parsed,
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  requestBody(audio, format) {
    const body = {
      model: this.config.model,
      input_audio: {
        data: audio.toString("base64"),
        format,
      },
      temperature: this.config.temperature,
      response_format: this.config.responseFormat,
    }
    if (this.config.language) body.language = this.config.language
    if (this.config.prompt) {
      body.provider = { options: { groq: { prompt: this.config.prompt } } }
    }
    return body
  }
}

export function audioFormat(file) {
  const ext = path.extname(file.filename || file.localPath || "").toLowerCase().replace(/^\./, "")
  if (["ogg", "oga", "opus"].includes(ext)) return "ogg"
  if (["mp3", "wav", "flac", "m4a", "mp4", "webm"].includes(ext)) return ext
  const mime = String(file.mime || "").toLowerCase()
  if (mime.includes("ogg") || mime.includes("opus")) return "ogg"
  if (mime.includes("mpeg")) return "mp3"
  if (mime.includes("wav")) return "wav"
  if (mime.includes("flac")) return "flac"
  if (mime.includes("mp4")) return "mp4"
  if (mime.includes("webm")) return "webm"
  return "ogg"
}

function parseJson(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function openRouterErrorMessage(parsed, bodyText) {
  if (parsed?.error?.message) return parsed.error.message
  if (parsed?.message) return parsed.message
  return String(bodyText || "unknown error").slice(0, 500)
}
