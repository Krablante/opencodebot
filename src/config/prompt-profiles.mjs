const defaultPromptProfiles = {
  d4flash: {
    agent: "build",
    model: { providerID: "deepseek", modelID: "deepseek-v4-flash", variant: "max" },
    opencodezSystem: "default",
  },
  d4pro: {
    agent: "build",
    model: { providerID: "deepseek", modelID: "deepseek-v4-pro", variant: "max" },
    opencodezSystem: "default",
  },
  luna: {
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5.6-luna", variant: "xhigh" },
    opencodezSystem: "codex_gpt_5_6_luna_terra",
  },
  terra: {
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5.6-terra", variant: "xhigh" },
    opencodezSystem: "codex_gpt_5_6_luna_terra",
  },
  solm: solProfile("medium"),
  solh: solProfile("high"),
  sol: solProfile("xhigh"),
  solmax: solProfile("max"),
}

function solProfile(variant) {
  return {
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5.6-sol", variant },
    opencodezSystem: "codex_gpt_5_6_sol",
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
  if (typeof model === "string") return { modelID: model }
  const providerID = model.providerID !== undefined ? String(model.providerID) : undefined
  const modelID = model.modelID !== undefined ? String(model.modelID) : undefined
  if (!modelID) return undefined
  const normalized = { providerID, modelID }
  if (model.variant) normalized.variant = String(model.variant)
  return normalized
}
