import fs from "node:fs"

export function readServers(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"))
  const servers = Array.isArray(raw) ? raw : raw.servers
  if (!Array.isArray(servers)) return []
  return servers
    .filter((server) => server && server.id && server.url)
    .map(normalizeServer)
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
  const type = value.type === "ssh" ? "ssh" : "local"
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
