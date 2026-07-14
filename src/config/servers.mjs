import fs from "node:fs"

export function readServers(filePath) {
  const raw = readServerConfig(filePath)
  const servers = Array.isArray(raw) ? raw : raw?.servers
  const errors = validateServers(servers)
  if (errors.length) throw new Error(`Invalid servers config: ${filePath}\n${errors.map((error) => `- ${error}`).join("\n")}`)
  return servers.map(normalizeServer)
}

function readServerConfig(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new Error(`Invalid servers config: ${filePath}\n- invalid JSON: ${error.message}`)
  }
}

function validateServers(servers) {
  if (!Array.isArray(servers)) return ['root must be an array or an object with a "servers" array']
  if (!servers.length) return ["servers must contain at least one entry"]

  const errors = []
  const ids = new Map()
  for (const [index, server] of servers.entries()) validateServer(server, index, ids, errors)
  return errors
}

function validateServer(server, index, ids, errors) {
  const prefix = `servers[${index}]`
  if (!isRecord(server)) {
    errors.push(`${prefix} must be an object`)
    return
  }

  const id = nonEmptyString(server.id)
  if (!id) {
    errors.push(`${prefix}.id must be a non-empty string`)
  } else {
    if (server.id !== id) errors.push(`${prefix}.id must not have leading or trailing whitespace`)
    if (ids.has(id)) errors.push(`${prefix}.id duplicates servers[${ids.get(id)}].id (${JSON.stringify(id)})`)
    else ids.set(id, index)
  }

  const url = nonEmptyString(server.url)
  if (!url) errors.push(`${prefix}.url must be a non-empty string`)
  else {
    if (server.url !== url) errors.push(`${prefix}.url must not have leading or trailing whitespace`)
    if (!isHttpUrl(url)) errors.push(`${prefix}.url must be an absolute HTTP(S) URL`)
  }

  validateOptionalString(server, "home", prefix, errors)
  validateOptionalString(server, "uploadRoot", prefix, errors)
  validateOptionalString(server, "artifactUploadRoot", prefix, errors)
  validateOptionalString(server, "label", prefix, errors)
  if (server.pathStyle !== undefined && server.pathStyle !== "posix" && server.pathStyle !== "windows") {
    errors.push(`${prefix}.pathStyle must be "posix" or "windows"`)
  }
  if (server.offline_ok !== undefined && typeof server.offline_ok !== "boolean") {
    errors.push(`${prefix}.offline_ok must be a boolean`)
  }

  validateTransfer(server.transfer, prefix, errors)
}

function validateTransfer(transfer, prefix, errors) {
  if (transfer === undefined) return
  if (!isRecord(transfer)) {
    errors.push(`${prefix}.transfer must be an object`)
    return
  }

  const type = transfer.type
  if (type !== "local" && type !== "ssh") {
    errors.push(`${prefix}.transfer.type must be "local" or "ssh"`)
    return
  }
  if (transfer.pathStyle !== undefined && transfer.pathStyle !== "posix" && transfer.pathStyle !== "windows") {
    errors.push(`${prefix}.transfer.pathStyle must be "posix" or "windows"`)
  }
  if (type !== "ssh") return

  if (!nonEmptyString(transfer.host)) errors.push(`${prefix}.transfer.host is required for SSH transfer`)
  validateOptionalString(transfer, "user", `${prefix}.transfer`, errors)
  validateOptionalString(transfer, "identityFile", `${prefix}.transfer`, errors)
  if (transfer.port !== undefined && (!Number.isInteger(transfer.port) || transfer.port < 1 || transfer.port > 65535)) {
    errors.push(`${prefix}.transfer.port must be an integer from 1 to 65535`)
  }
}

function validateOptionalString(value, field, prefix, errors) {
  if (value[field] !== undefined && !nonEmptyString(value[field])) {
    errors.push(`${prefix}.${field} must be a non-empty string when provided`)
  }
}

function normalizeServer(server) {
  const home = server.home ? String(server.home) : undefined
  const uploadRoot = server.uploadRoot ? String(server.uploadRoot) : defaultUploadRoot(home)
  const pathStyle = normalizePathStyle(server.pathStyle || server.transfer?.pathStyle || inferPathStyle(uploadRoot || home))
  return {
    id: String(server.id),
    url: String(server.url).replace(/\/$/, ""),
    home,
    uploadRoot,
    artifactUploadRoot: server.artifactUploadRoot ? String(server.artifactUploadRoot) : undefined,
    pathStyle,
    transfer: normalizeTransfer(server.transfer, pathStyle),
    label: server.label ? String(server.label) : String(server.id),
    offlineOk: Boolean(server.offline_ok),
  }
}

function normalizeTransfer(value = {}, pathStyle = "posix") {
  const type = value.type || "local"
  const transfer = { ...value, type, pathStyle }
  if (type === "ssh") {
    if (value.host) transfer.host = String(value.host)
    if (value.user) transfer.user = String(value.user)
    if (value.port) transfer.port = Number(value.port)
    if (value.identityFile) transfer.identityFile = String(value.identityFile)
  }
  return transfer
}

function defaultUploadRoot(home) {
  if (!home) return undefined
  const style = inferPathStyle(home)
  const separator = style === "windows" ? "\\" : "/"
  return `${String(home).replace(/[\\/]+$/, "")}${separator}.opencodebot${separator}uploads`
}

function inferPathStyle(value = "") {
  const text = String(value)
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\")) return "windows"
  return "posix"
}

function normalizePathStyle(value) {
  return value === "windows" ? "windows" : "posix"
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : ""
}

function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
