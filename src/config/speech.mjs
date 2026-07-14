const DEFAULT_MODEL = "openai/whisper-large-v3-turbo"
const DEFAULT_LANGUAGE = "ru"
const DEFAULT_PROMPT = "Русская голосовая заметка. Сохраняй технические названия, команды, пути и сокращения латиницей."
const PROVIDER_DEFAULTS = {
  openrouter: {
    label: "OpenRouter",
    url: "https://openrouter.ai/api/v1/audio/transcriptions",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  groq: {
    label: "Groq",
    url: "https://api.groq.com/openai/v1/audio/transcriptions",
    apiKeyEnv: "GROQ_API_KEY",
  },
}

export function normalizeSpeechConfig(settings = {}, env = {}) {
  const openrouter = settings.openrouter || {}
  const providers = Object.fromEntries(Object.entries(PROVIDER_DEFAULTS).map(([id, defaults]) => [
    id,
    normalizeProvider(id, settings[id], defaults, env),
  ]))
  const defaults = {
    language: normalizeLanguage(Object.hasOwn(settings, "language") ? settings.language : openrouter.language),
    temperature: numberOrDefault(settings.temperature ?? openrouter.temperature, 0),
    responseFormat: settings.responseFormat || openrouter.responseFormat || "json",
    prompt: settings.prompt ?? openrouter.prompt ?? DEFAULT_PROMPT,
  }
  const models = normalizeModels(settings, openrouter, defaults, providers)
  const requestedDefault = String(settings.defaultModel || openrouter.model || settings.model || models[0]?.id || DEFAULT_MODEL)

  return {
    enabled: settings.enabled === true,
    maxFileBytes: numberAtLeast(settings.maxFileBytes, 25_000_000, 1024),
    queueConcurrency: numberAtLeast(settings.queueConcurrency, 1, 1),
    statusMessage: settings.statusMessage || "Transcribing voice...",
    defaultModel: models.some((model) => model.id === requestedDefault) ? requestedDefault : models[0].id,
    models,
    providers,
  }
}

function normalizeProvider(id, value, defaults, env) {
  const settings = value || {}
  const apiKeyEnv = String(settings.apiKeyEnv || defaults.apiKeyEnv)
  return {
    id,
    label: defaults.label,
    apiKeyEnv,
    apiKey: env[apiKeyEnv],
    url: settings.url || defaults.url,
    timeoutMs: numberAtLeast(settings.timeoutMs, 120_000, 1000),
    referer: id === "openrouter" ? settings.referer || "https://github.com/Krablante/opencodez" : null,
    title: id === "openrouter" ? settings.title || "opencodebot speech module" : null,
  }
}

function normalizeModels(settings, openrouter, defaults, providers) {
  const source = Array.isArray(settings.models) && settings.models.length
    ? settings.models
    : Array.isArray(openrouter.models) && openrouter.models.length
      ? openrouter.models
      : [{ id: openrouter.model || settings.model || DEFAULT_MODEL, label: openrouter.label || settings.label, upstreamProvider: openrouter.provider || settings.provider }]
  const seen = new Set()
  const models = []
  for (const entry of source) {
    const item = typeof entry === "string" ? { id: entry } : entry || {}
    const id = String(item.id || "").trim()
    if (!id || seen.has(id)) continue
    const apiProvider = String(item.apiProvider || "openrouter").trim().toLowerCase()
    if (!providers[apiProvider]) throw new Error(`Unsupported speech API provider: ${apiProvider}`)
    seen.add(id)
    models.push({
      id,
      apiProvider,
      apiModel: String(item.apiModel || item.model || id).trim(),
      label: String(item.label || item.name || friendlyModelLabel(id)).trim(),
      provider: providers[apiProvider].label,
      upstreamProvider: String(item.upstreamProvider || item.provider || "").trim(),
      price: String(item.price || "").trim(),
      language: normalizeLanguage(Object.hasOwn(item, "language") ? item.language : defaults.language),
      temperature: numberOrDefault(item.temperature, defaults.temperature),
      responseFormat: String(item.responseFormat || defaults.responseFormat),
      prompt: String(item.prompt ?? defaults.prompt),
    })
  }
  if (!models.length) throw new Error("At least one speech model is required")
  return models
}

function friendlyModelLabel(id) {
  return id.split("/").pop().replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
}

function normalizeLanguage(value) {
  if (value === null) return null
  const text = String(value ?? DEFAULT_LANGUAGE).trim()
  if (!text) return DEFAULT_LANGUAGE
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
