import fs from "node:fs"

export function loadEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {}
  const env = {}
  const text = fs.readFileSync(filePath, "utf8")
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const index = trimmed.indexOf("=")
    if (index === -1) continue
    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

export function pickValue(env, names) {
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && String(value).trim()) return String(value).trim()
  }
  return undefined
}

export function pickToken(env, names) {
  const explicit = pickValue(env, names)
  if (explicit) return explicit
  for (const value of Object.values(env)) {
    const text = String(value).trim()
    if (/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(text)) return text
  }
  return undefined
}

export function readNumberList(env, names) {
  const values = []
  for (const name of names) {
    const value = env[name]
    if (!value) continue
    for (const item of String(value).split(/[\s,]+/)) {
      if (/^-?\d+$/.test(item)) values.push(Number(item))
    }
  }
  if (!values.length) {
    for (const [key, value] of Object.entries(env)) {
      if (!/(USER|ALLOWED|OWNER).*ID/i.test(key)) continue
      if (/^-?\d+$/.test(String(value).trim())) values.push(Number(value))
    }
  }
  return values
}

export function readFirstNumber(env, names) {
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && /^-?\d+$/.test(String(value).trim())) return Number(value)
  }
  return null
}

export function uniqueNumbers(values) {
  return [...new Set(values.map(Number).filter(Number.isSafeInteger))]
}

export function normalizeStringList(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback
  return [...new Set(source.map((item) => String(item).trim()).filter(Boolean))]
}

export function numberAtLeast(value, fallback, min) {
  const number = Number(value)
  return Number.isFinite(number) && number >= min ? Math.floor(number) : fallback
}

export function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "")
}
