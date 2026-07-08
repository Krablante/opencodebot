const DEFAULT_OPENROUTER_MODEL = "openai/whisper-large-v3-turbo"
const DEFAULT_OPENROUTER_URL = "https://openrouter.ai/api/v1/audio/transcriptions"
const DEFAULT_OPENROUTER_LANGUAGE = "ru"
const DEFAULT_PROMPT = "Русская голосовая заметка. Сохраняй технические названия, команды, пути и сокращения латиницей."

export function normalizeSpeechConfig(settings = {}, env = {}) {
  const openrouter = settings.openrouter || {}
  const apiKeyEnv = openrouter.apiKeyEnv || settings.apiKeyEnv || "OPENROUTER_API_KEY"
  return {
    enabled: settings.enabled === true,
    maxFileBytes: numberAtLeast(settings.maxFileBytes, 25_000_000, 1024),
    queueConcurrency: numberAtLeast(settings.queueConcurrency, 1, 1),
    statusMessage: settings.statusMessage || "Transcribing voice...",
    openrouter: {
      apiKeyEnv,
      apiKey: env[apiKeyEnv],
      url: openrouter.url || settings.url || DEFAULT_OPENROUTER_URL,
      model: openrouter.model || settings.model || DEFAULT_OPENROUTER_MODEL,
      language: normalizeOpenRouterLanguage(settings, openrouter),
      temperature: numberOrDefault(openrouter.temperature ?? settings.temperature, 0),
      responseFormat: openrouter.responseFormat || settings.responseFormat || "json",
      prompt: openrouter.prompt ?? settings.prompt ?? DEFAULT_PROMPT,
      referer: openrouter.referer || settings.referer || "https://github.com/Krablante/opencodez",
      title: openrouter.title || settings.title || "opencodebot speech module",
      timeoutMs: numberAtLeast(openrouter.timeoutMs ?? settings.timeoutMs, 120_000, 1000),
    },
  }
}

function normalizeOpenRouterLanguage(settings, openrouter) {
  const value = Object.hasOwn(openrouter, "language")
    ? openrouter.language
    : Object.hasOwn(settings, "language")
      ? settings.language
      : DEFAULT_OPENROUTER_LANGUAGE
  if (value === null) return null
  const text = String(value ?? "").trim()
  if (!text) return DEFAULT_OPENROUTER_LANGUAGE
  if (text.toLowerCase() === "auto") return null
  return text.toLowerCase()
}

function numberAtLeast(value, fallback, min) {
  const number = Number(value)
  return Number.isFinite(number) && number >= min ? Math.floor(number) : fallback
}

function numberOrDefault(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}
