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
  return {
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-6.1-sol", variant },
    opencodezSystem: "codex_gpt_6_1_sol",
  }
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
