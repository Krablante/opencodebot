export function formatToolLine(tool, input = {}, ok = true, suffix = "") {
  const action = toolAction(tool, input)
  const tail = suffix ? ` ${suffix}` : ""
  return `${ok ? "✅" : "❌"} ${action}${tail}`
}

export function isTaskTool(tool) {
  return compactToolName(tool) === "task"
}

export function shortUsefulResult(properties) {
  const text = textFromContent(properties.content)
  if (text) return trim(text, 120)
  if (Array.isArray(properties.outputPaths) && properties.outputPaths.length) return trim(properties.outputPaths.join(", "), 120)
  return ""
}

export function shortError(properties) {
  const error = properties.error || properties.result
  if (!error) return "failed"
  if (typeof error === "string") return trim(error, 160)
  return trim(error.message || error.name || JSON.stringify(error), 160)
}

export function toolNameSet(names) {
  const values = new Set()
  for (const name of names || []) {
    const normalized = normalizeToolName(name)
    const compact = compactToolName(name)
    if (normalized) values.add(normalized)
    if (compact) values.add(compact)
  }
  return values
}

export function isHiddenTool(tool, hiddenTools) {
  if (!tool || !hiddenTools?.size) return false
  return hiddenTools.has(normalizeToolName(tool)) || hiddenTools.has(compactToolName(tool))
}

export function toolSummaryLabel(tool, input = {}) {
  switch (inferTool(tool, input)) {
    case "read":
      return "Read"
    case "grep":
      return "Search"
    case "glob":
      return "Glob"
    case "bash":
      return "Shell"
    case "skill":
      return "Skill"
    case "todowrite":
      return "Todo"
    case "apply_patch":
      return "Patch"
    case "edit":
      return "Edit"
    case "write":
      return "Write"
    default:
      return titleCase(inferTool(tool, input) || tool || "tool")
  }
}

export function changedFilesForTool(tool, input = {}) {
  switch (inferTool(tool, input)) {
    case "apply_patch":
      return patchFiles(input.patchText)
    case "edit":
    case "write":
      return uniqueStrings([input.filePath || input.path])
    default:
      return []
  }
}

function toolAction(tool, input) {
  const inferred = inferTool(tool, input)
  switch (inferred) {
    case "read":
      return compactJoin("Read", compactPath(input.filePath), kv("offset", input.offset), kv("limit", input.limit))
    case "grep":
      return compactJoin("Search", quote(input.pattern), compactPath(input.path), input.include ? `include=${input.include}` : "")
    case "glob":
      return compactJoin("Glob", quote(input.pattern), compactPath(input.path))
    case "bash":
      return compactJoin("Shell", input.description || trimOneLine(input.command, 90))
    case "skill":
      return compactJoin("Skill", input.name)
    case "todowrite":
      return compactJoin("Todo", Array.isArray(input.todos) ? `${input.todos.length} items` : "update")
    case "task":
      return compactJoin(titleCase(input.subagent_type || "subagent"), input.description || "subagent")
    case "apply_patch":
      return compactJoin("Patch files", patchFileSummary(input))
    default:
      return compactJoin(titleCase(inferred || tool || "tool"), safeInputSummary(input))
  }
}

function inferTool(tool, input) {
  if (tool && tool !== "tool") return tool
  if (input.filePath) return "read"
  if (input.command) return "bash"
  if (input.subagent_type) return "task"
  if (input.todos) return "todowrite"
  if (input.patchText) return "apply_patch"
  if (input.name && Object.keys(input).length === 1) return "skill"
  if (input.pattern && input.include) return "grep"
  if (input.pattern) return "glob"
  return tool
}

function compactJoin(...parts) {
  return parts.filter(Boolean).join(" ")
}

function compactPath(value) {
  if (!value) return ""
  const text = String(value)
  const parts = text.split("/").filter(Boolean)
  return parts.length ? parts[parts.length - 1] : text
}

function patchFileSummary(input) {
  const files = patchFiles(input?.patchText)
  if (!files.length) return ""
  return `(${summarizeList(files.map(compactPath), 5, "; ")})`
}

function patchFiles(patchText) {
  const files = []
  for (const line of String(patchText || "").split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) || line.match(/^\*\*\* Move to: (.+)$/)
    if (match) files.push(match[1].trim())
  }
  return uniqueStrings(files)
}

function summarizeList(values, maxItems, separator = ", ") {
  const items = values.filter(Boolean)
  if (items.length <= maxItems) return items.join(separator)
  return `${items.slice(0, maxItems).join(separator)}; +${items.length - maxItems}`
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))]
}

function kv(name, value) {
  return value === undefined || value === null || value === "" ? "" : `${name}=${value}`
}

function quote(value) {
  return value ? `“${trimOneLine(value, 70)}”` : ""
}

function safeInputSummary(input) {
  const blocked = /(token|secret|password|key|credential)/i
  return Object.entries(input || {})
    .filter(([key, value]) => !blocked.test(key) && ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 3)
    .map(([key, value]) => `${key}=${trimOneLine(value, 40)}`)
    .join(" ")
}

function trimOneLine(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function titleCase(value) {
  const text = String(value || "tool").replace(/[_-]+/g, " ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function textFromContent(content) {
  if (!Array.isArray(content)) return ""
  return content
    .map((item) => {
      if (typeof item === "string") return item
      if (item?.type === "text") return item.text
      if (item?.text) return item.text
      return ""
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}

function trim(text, max) {
  const value = String(text || "").trim()
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}...`
}

function normalizeToolName(tool) {
  return String(tool || "").trim().toLowerCase()
}

function compactToolName(tool) {
  return normalizeToolName(tool).replace(/[^a-z0-9]/g, "")
}
