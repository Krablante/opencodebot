import { isDeepStrictEqual } from "node:util"

const defaultPromptProfiles = {
  d4flash: {
    agent: "build",
    model: { providerID: "deepseek", modelID: "deepseek-flash", variant: "max" },
    opencodezSystem: "default",
  },
  solm: solProfile("medium"),
  sol: solProfile("high"),
  solx: solProfile("xhigh"),
}

function solProfile(variant) {
  return openaiProfile("gpt-6.2-sol", variant, "codex_gpt_6_2_sol")
}

function openaiProfile(modelID, variant, opencodezSystem) {
  return { agent: "build", model: { providerID: "openai", modelID, variant }, opencodezSystem }
}

function previousSolProfile(variant) {
  return openaiProfile("gpt-6.1-sol", variant, "codex_gpt_6_1_sol")
}

const formerPromptProfiles = {
  d4pro: { agent: "build", model: { providerID: "deepseek", modelID: "deepseek-v4-pro", variant: "max" }, opencodezSystem: "default" },
  luna: openaiProfile("gpt-6-luna", "xhigh", "codex_gpt_6_luna"),
  lunah: openaiProfile("gpt-6-luna", "high", "codex_gpt_6_luna"),
  lunamax: openaiProfile("gpt-6-luna", "max", "codex_gpt_6_luna"),
  terra: openaiProfile("gpt-5.6-terra", "xhigh", "codex_gpt_5_6_luna_terra"),
  gpt6: openaiProfile("gpt-6-astra", "high", "codex_gpt_6_astra"),
  gpt6m: openaiProfile("gpt-6-astra", "medium", "codex_gpt_6_astra"),
  solh: previousSolProfile("high"),
  solmax: previousSolProfile("max"),
}

const previousPromptProfiles = {
  ...formerPromptProfiles,
  solm: previousSolProfile("medium"),
  sol: previousSolProfile("high"),
  solx: previousSolProfile("xhigh"),
}

const modelUpgrades = {
  "gpt-6.1-sol": { modelID: "gpt-6.2-sol", system: "codex_gpt_6_2_sol" },
  "gpt-6-astra": { modelID: "gpt-6.2-astra", system: "codex_gpt_6_2_astra" },
  "gpt-5.6-terra": { modelID: "gpt-6.1-terra", system: "codex_gpt_6_1_terra" },
}

export function upgradeBuiltInPromptProfiles(profiles) {
  for (const [name, profile] of Object.entries(profiles)) {
    const previous = Object.hasOwn(previousPromptProfiles, name) ? previousPromptProfiles[name] : undefined
    const upgrade = previous && modelUpgrades[previous.model.modelID]
    if (!upgrade || !profile) continue
    const prefix = profile.opencodezSystem === `builtin:${previous.opencodezSystem}` ? "builtin:" : ""
    if (!isDeepStrictEqual(profile, { ...previous, opencodezSystem: `${prefix}${previous.opencodezSystem}` })) continue
    profiles[name] = openaiProfile(upgrade.modelID, previous.model.variant, `${prefix}${upgrade.system}`)
  }
  return profiles
}

export function importFormerPromptProfiles() {
  return upgradeBuiltInPromptProfiles(structuredClone(formerPromptProfiles))
}

export function normalizePromptProfiles(value = {}) {
  const merged = { ...defaultPromptProfiles, ...(value || {}) }
  return Object.fromEntries(
    Object.entries(merged)
      .map(([name, profile]) => [String(name).trim(), normalizePromptProfile(profile)])
      .filter(([name, profile]) => name && profile),
  )
}

function normalizePromptProfile(profile = {}) {
  if (!profile || typeof profile !== "object") return null
  const model = normalizeModel(profile.model)
  if (!profile.agent && !model && !profile.opencodezSystem) return null
  return {
    agent: profile.agent ? String(profile.agent) : undefined,
    model,
    opencodezSystem: profile.opencodezSystem ? String(profile.opencodezSystem) : undefined,
  }
}

function normalizeModel(model) {
  if (!model) return undefined
  if (typeof model === "string") {
    const slash = model.indexOf("/")
    return slash > 0 ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } : { modelID: model }
  }
  const providerID = model.providerID !== undefined ? String(model.providerID) : undefined
  const modelID = model.modelID !== undefined ? String(model.modelID) : undefined
  if (!modelID) return undefined
  const normalized = { providerID, modelID }
  if (model.variant) normalized.variant = String(model.variant)
  return normalized
}
