import { en } from "./en.mjs"
import { ru } from "./ru.mjs"

const catalogs = { en, ru }
const aliases = new Map([
  ["en", "en"],
  ["eng", "en"],
  ["english", "en"],
  ["ru", "ru"],
  ["rus", "ru"],
  ["russian", "ru"],
])

let language = "en"
let stateStore = null

validateCatalogs()

export function configureI18n({ state, defaultLanguage = "en" }) {
  stateStore = state || null
  language = normalizeLanguage(state?.data?.ui?.language)
    || normalizeLanguage(defaultLanguage)
    || "en"
  return language
}

export function getLanguage() {
  return language
}

export function normalizeLanguage(value) {
  return aliases.get(String(value || "").trim().toLowerCase()) || null
}

export async function setLanguage(value) {
  const normalized = normalizeLanguage(value)
  if (!normalized) return null
  if (stateStore) {
    await stateStore.update((data) => {
      data.ui = data.ui && typeof data.ui === "object" && !Array.isArray(data.ui) ? data.ui : {}
      data.ui.language = normalized
    })
  }
  language = normalized
  return normalized
}

export function t(key, values = {}) {
  const message = catalogs[language]?.[key]
  if (message === undefined) throw new Error(`Unknown i18n key: ${key}`)
  return typeof message === "function" ? message(values) : interpolate(message, values)
}

export function tFor(selectedLanguage, key, values = {}) {
  const normalized = normalizeLanguage(selectedLanguage)
  if (!normalized) throw new Error(`Unsupported interface language: ${selectedLanguage}`)
  const message = catalogs[normalized][key]
  if (message === undefined) throw new Error(`Unknown i18n key: ${key}`)
  return typeof message === "function" ? message(values) : interpolate(message, values)
}

export function catalogKeys() {
  return Object.keys(en).sort()
}

function interpolate(template, values) {
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name) => String(values[name] ?? ""))
}

function validateCatalogs() {
  const baseline = Object.keys(en).sort()
  const translated = Object.keys(ru).sort()
  if (baseline.length !== translated.length || baseline.some((key, index) => key !== translated[index])) {
    const missing = baseline.filter((key) => !Object.hasOwn(ru, key))
    const extra = translated.filter((key) => !Object.hasOwn(en, key))
    throw new Error(`i18n catalog mismatch: missing=${missing.join(",")} extra=${extra.join(",")}`)
  }
  for (const key of baseline) {
    if (typeof en[key] !== typeof ru[key]) throw new Error(`i18n catalog type mismatch for ${key}`)
  }
}
