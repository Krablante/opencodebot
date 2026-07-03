import path from "node:path"

import { trimTrailingSlash } from "./common.mjs"

export const telegramLocalMaxFileBytes = 2_000_000_000

const telegramCloudRootUrl = "https://api.telegram.org"
const telegramLocalRootUrl = "http://telegram-bot-api:8081"
const telegramLocalFilesRoot = "/var/lib/telegram-bot-api"
const telegramLocalSpoolDir = path.join(telegramLocalFilesRoot, "opencodebot-spool")

export function normalizeTelegramBotApi(value = {}, env = {}, projectRoot = process.cwd()) {
  const mode = value?.mode === "local" ? "local" : "cloud"
  const rootUrl = trimTrailingSlash(value?.rootUrl || value?.apiBaseUrl || env.TELEGRAM_BOT_API_ROOT_URL || (mode === "local" ? telegramLocalRootUrl : telegramCloudRootUrl))
  const fileRootUrl = trimTrailingSlash(value?.fileRootUrl || env.TELEGRAM_BOT_API_FILE_ROOT_URL || rootUrl)
  const localFilesRoot = normalizeAbsolute(value?.localFilesRoot || env.TELEGRAM_BOT_API_LOCAL_FILES_ROOT || telegramLocalFilesRoot)
  const spoolDir = normalizeAbsolute(value?.spoolDir || env.OPENCODEBOT_ARTIFACT_SPOOL_DIR || (mode === "local" ? telegramLocalSpoolDir : path.join(projectRoot, "state", "artifacts")))
  return {
    mode,
    rootUrl,
    fileRootUrl,
    localFilesRoot,
    spoolDir,
    local: mode === "local",
    apiIdPresent: Boolean(env.TELEGRAM_API_ID),
    apiHashPresent: Boolean(env.TELEGRAM_API_HASH),
  }
}

function normalizeAbsolute(value) {
  return path.resolve(String(value || "."))
}
