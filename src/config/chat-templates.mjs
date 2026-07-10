const defaultChatTemplates = {
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
  sol: {
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "xhigh" },
    opencodezSystem: "codex_gpt_5_6_sol",
  },
}

export function normalizeChatTemplates(value = {}) {
  const merged = { ...defaultChatTemplates, ...(value || {}) }
  return Object.fromEntries(
    Object.entries(merged)
      .map(([name, template]) => [String(name).trim(), normalizeChatTemplate(template)])
      .filter(([name, template]) => name && template),
  )
}

function normalizeChatTemplate(template = {}) {
  const model = normalizeModel(template.model)
  if (!template.agent && !model && !template.opencodezSystem) return null
  return {
    agent: template.agent ? String(template.agent) : undefined,
    model,
    opencodezSystem: template.opencodezSystem ? String(template.opencodezSystem) : undefined,
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
