#!/usr/bin/env node
import fsp from "node:fs/promises"
import { loadConfig } from "../src/config.mjs"
import { TelegramClient } from "../src/telegram.mjs"

const command = process.argv[2] || "status"
const confirmed = process.argv.includes("--yes") || process.env.OPENCODEBOT_TELEGRAM_LOCAL_CONFIRM === "1"

async function main() {
  const config = loadConfig()
  if (command === "status") return status(config)
  if (command === "doctor") return doctor(config)
  if (command === "enable") return enable(config)
  if (command === "disable") return disable(config)
  usage()
  process.exitCode = 2
}

async function status(config) {
  printConfig(config)
  await checkLocalFilesRoot(config)
  await checkGetMe(config)
}

async function doctor(config) {
  printConfig(config)
  checkLocalEnv(config)
  await checkLocalFilesRoot(config)
  await checkGetMe(config)
}

async function enable(config) {
  if (!confirmed) {
    console.log("enable calls Telegram logOut on the cloud Bot API before the bot can use a local Bot API server.")
    console.log("Run again with --yes after the telegram-bot-api sidecar is up and config telegram.botApi.mode is local.")
    process.exitCode = 2
    return
  }
  checkTelegramToken(config)
  const cloud = new TelegramClient(config.telegram.token, { mode: "cloud", rootUrl: "https://api.telegram.org", fileRootUrl: "https://api.telegram.org" })
  await cloud.logOut()
  console.log("cloud Bot API logOut completed. Keep the local telegram-bot-api sidecar running, then use doctor/status to verify getMe.")
}

async function disable(config) {
  if (!confirmed) {
    console.log("disable calls Telegram close on the configured Bot API endpoint and may require waiting before cloud Bot API works again.")
    console.log("Run again with --yes while telegram.botApi.mode still points at the local Bot API server, then switch config back to cloud.")
    process.exitCode = 2
    return
  }
  checkTelegramToken(config)
  const client = new TelegramClient(config.telegram.token, config.telegram.botApi)
  await client.close()
  console.log("Bot API close completed. Telegram documents a short restriction window before switching back to cloud Bot API.")
}

function printConfig(config) {
  const botApi = config.telegram.botApi
  console.log(`mode=${botApi.mode}`)
  console.log(`rootUrl=${botApi.rootUrl}`)
  console.log(`localFilesRoot=${botApi.localFilesRoot}`)
  console.log(`spoolDir=${botApi.spoolDir}`)
}

function checkLocalEnv(config) {
  const botApi = config.telegram.botApi
  console.log(`TELEGRAM_API_ID=${botApi.apiIdPresent ? "present" : "missing"}`)
  console.log(`TELEGRAM_API_HASH=${botApi.apiHashPresent ? "present" : "missing"}`)
  if (botApi.mode === "local" && (!botApi.apiIdPresent || !botApi.apiHashPresent)) {
    throw new Error("local mode requires TELEGRAM_API_ID and TELEGRAM_API_HASH in token.env")
  }
}

async function checkLocalFilesRoot(config) {
  const root = config.telegram.botApi.localFilesRoot
  try {
    const stat = await fsp.stat(root)
    console.log(`localFilesRootAccessible=${stat.isDirectory()}`)
  } catch (error) {
    console.log(`localFilesRootAccessible=false (${error.code || error.message})`)
  }
}

async function checkGetMe(config) {
  if (!config.telegram.token) {
    console.log("getMe=skipped (telegram token missing)")
    return
  }
  try {
    const client = new TelegramClient(config.telegram.token, config.telegram.botApi)
    const me = await client.getMe()
    console.log(`getMe=ok username=${me.username || "unknown"}`)
  } catch (error) {
    console.log(`getMe=failed ${error.message}`)
    process.exitCode = 1
  }
}

function checkTelegramToken(config) {
  if (!config.telegram.token) throw new Error("telegram bot token is missing")
}

function usage() {
  console.log("Usage: npm run telegram-local -- status|doctor|enable|disable [--yes]")
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
