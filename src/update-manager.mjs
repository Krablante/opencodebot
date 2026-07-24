import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { escapeHtml } from "./telegram.mjs"
import { classifyChangedPaths, isGitRevision, scheduledCheckDue, shortRevision, summarizeUpdateCommits } from "./update-shared.mjs"

const GITHUB_API_VERSION = "2026-03-10"
const SCHEDULE_INTERVAL_MS = 60_000
const STATUS_INTERVAL_MS = 2_500
const SCHEDULE_RETRY_MS = 15 * 60_000
const EMPTY_KEYBOARD = { inline_keyboard: [] }

export function createUpdateManager({ config, state, telegram, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  return new UpdateManager({ config, state, telegram, fetchImpl, now })
}

class UpdateManager {
  constructor({ config, state, telegram, fetchImpl, now }) {
    this.config = config
    this.state = state
    this.telegram = telegram
    this.fetchImpl = fetchImpl
    this.now = now
    this.runtimeDir = config.updates.runtimeDir
    this.requestPath = path.join(this.runtimeDir, "request.json")
    this.statusPath = path.join(this.runtimeDir, "status.json")
    this.runnerInfoPath = path.join(this.runtimeDir, "runner.json")
    this.checkPromise = null
    this.scheduledRunning = false
    this.scheduleRetryAt = 0
    this.scheduleTimer = null
    this.statusTimer = null
  }

  async start() {
    if (!this.config.updates.enabled) return
    await fs.mkdir(this.runtimeDir, { recursive: true })
    await this.reconcileStatus()
    this.scheduleTimer = setInterval(() => void this.runScheduledCheck(), SCHEDULE_INTERVAL_MS)
    this.scheduleTimer.unref?.()
    void this.runScheduledCheck()
    if (this.state.data.updates?.activeRun) this.startStatusPolling()
  }

  stop() {
    clearInterval(this.scheduleTimer)
    clearInterval(this.statusTimer)
    this.scheduleTimer = null
    this.statusTimer = null
  }

  async checkNow({ chatId, topicId = 0 }) {
    if (!this.config.updates.enabled) {
      await this.telegram.sendMessage({ chatId, topicId, text: "⏸️ <b>Update checks are disabled.</b>" })
      return
    }
    if (!isGitRevision(this.config.updates.currentRevision)) {
      await this.telegram.sendMessage({
        chatId,
        topicId,
        text: "⚠️ <b>Update check is not ready yet.</b>\nThe running image has no Git revision metadata. Rebuild opencodebot once with the current deployment workflow.",
      })
      return
    }

    const waiting = await this.telegram.sendMessage({
      chatId,
      topicId,
      text: "🔎 <b>Checking GitHub for opencodebot updates…</b>",
    })
    try {
      const result = await this.checkRemote()
      if (result.kind === "current") {
        await this.telegram.editMessageText({
          chatId,
          messageId: waiting.message_id,
          text: formatCurrentMessage(result, this.config.updates),
          replyMarkup: EMPTY_KEYBOARD,
        })
        return
      }
      if (result.kind === "blocked") {
        await this.telegram.editMessageText({
          chatId,
          messageId: waiting.message_id,
          text: formatBlockedMessage(result),
          replyMarkup: EMPTY_KEYBOARD,
        })
        return
      }
      await this.publishOffer({ chatId, topicId, result, replaceMessageId: waiting.message_id })
    } catch (error) {
      await this.telegram.editMessageText({
        chatId,
        messageId: waiting.message_id,
        text: `❌ <b>Could not check for updates.</b>\n${escapeHtml(friendlyError(error))}`,
        replyMarkup: EMPTY_KEYBOARD,
      })
    }
  }

  async handleCallback(query) {
    const match = /^upd:(apply|later):([0-9a-f]{40})$/.exec(String(query?.data || ""))
    if (!match) return false
    const [, action, targetSha] = match
    const chatId = query.message?.chat?.id
    const messageId = query.message?.message_id
    const offer = this.findOffer(chatId, messageId, targetSha)
    if (!offer) {
      await this.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "This update offer has expired. Run /update again.",
        showAlert: true,
      })
      return true
    }

    if (action === "later") {
      await this.telegram.answerCallbackQuery({ callbackQueryId: query.id, text: "Deferred until the next daily check." })
      const localDate = scheduledCheckDue({
        now: this.now(),
        timeZone: this.config.updates.timeZone,
        hour: 0,
        minute: 0,
      }).date
      await this.state.update((data) => {
        data.updates.dismissedSha = targetSha
        data.updates.dismissedDate = localDate
        data.updates.offers = data.updates.offers.filter((candidate) => candidate.messageId !== messageId)
      })
      await this.telegram.editMessageText({
        chatId,
        messageId,
        text: `⏸️ <b>Update deferred</b>\n\n<code>${shortRevision(offer.baseSha)}</code> → <code>${shortRevision(targetSha)}</code>\nI’ll check again tomorrow at ${escapeHtml(this.config.updates.checkAt)} ${escapeHtml(this.config.updates.timeZone)}.`,
        replyMarkup: EMPTY_KEYBOARD,
      })
      return true
    }

    if (this.state.data.updates.activeRun) {
      await this.telegram.answerCallbackQuery({ callbackQueryId: query.id, text: "An update is already running.", showAlert: true })
      return true
    }
    if (this.config.updates.currentRevision !== offer.baseSha) {
      await this.telegram.answerCallbackQuery({ callbackQueryId: query.id, text: "The running version changed. Run /update again.", showAlert: true })
      return true
    }
    if (!(await fileExists(this.runnerInfoPath))) {
      await this.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "The host update runner is not installed.",
        showAlert: true,
      })
      return true
    }

    await this.telegram.answerCallbackQuery({ callbackQueryId: query.id, text: "Update queued. The bot will restart when ready." })
    const run = {
      id: randomUUID(),
      baseSha: offer.baseSha,
      targetSha,
      chatId,
      topicId: offer.topicId || 0,
      messageId,
      compareUrl: offer.compareUrl,
      summary: offer.summary,
      components: offer.components,
      commitCount: offer.commitCount,
      requestedAt: new Date().toISOString(),
      lastStage: "queued",
    }
    await this.state.update((data) => {
      data.updates.activeRun = run
    })
    try {
      await fs.rm(this.statusPath, { force: true })
      await writeJsonAtomic(this.requestPath, {
        id: run.id,
        baseSha: run.baseSha,
        targetSha: run.targetSha,
        requestedAt: run.requestedAt,
      })
    } catch (error) {
      await this.state.update((data) => {
        data.updates.activeRun = null
      })
      await this.telegram.editMessageText({
        chatId,
        messageId,
        text: `❌ <b>Could not queue the update.</b>\n${escapeHtml(friendlyError(error))}`,
        replyMarkup: EMPTY_KEYBOARD,
      })
      return true
    }

    await this.telegram.editMessageText({
      chatId,
      messageId,
      text: formatProgressMessage(run, { stage: "queued" }),
      replyMarkup: EMPTY_KEYBOARD,
    })
    this.startStatusPolling()
    return true
  }

  async runScheduledCheck() {
    if (!this.config.updates.enabled || this.scheduledRunning || Date.now() < this.scheduleRetryAt) return
    const schedule = scheduledCheckDue({
      now: this.now(),
      timeZone: this.config.updates.timeZone,
      hour: this.config.updates.checkHour,
      minute: this.config.updates.checkMinute,
      lastScheduledDate: this.state.data.updates.lastScheduledDate,
    })
    if (!schedule.due) return
    this.scheduledRunning = true
    try {
      if (!isGitRevision(this.config.updates.currentRevision)) {
        await this.markScheduledComplete(schedule.date)
        return
      }
      const result = await this.checkRemote()
      await this.markScheduledComplete(schedule.date)
      if (result.kind !== "available") return
      const updates = this.state.data.updates
      if (updates.dismissedSha === result.targetSha && updates.dismissedDate === schedule.date) return
      if (updates.lastNotifiedSha === result.targetSha && updates.lastNotifiedDate === schedule.date) return
      const chatId = this.state.chatId || this.config.telegram.chatId
      if (!chatId) return
      await this.publishOffer({ chatId, topicId: 0, result })
    } catch (error) {
      this.scheduleRetryAt = Date.now() + SCHEDULE_RETRY_MS
      console.error(`Scheduled update check failed: ${friendlyError(error)}`)
    } finally {
      this.scheduledRunning = false
    }
  }

  async checkRemote() {
    if (!this.checkPromise) {
      this.checkPromise = this.fetchComparison().finally(() => {
        this.checkPromise = null
      })
    }
    const result = await this.checkPromise
    await this.state.update((data) => {
      data.updates.lastCheckedAt = new Date().toISOString()
      data.updates.lastCheckKind = result.kind
    })
    return result
  }

  async fetchComparison() {
    const updates = this.config.updates
    const baseSha = updates.currentRevision
    const apiUrl = `https://api.github.com/repos/${updates.repository}/compare/${baseSha}...${encodeURIComponent(updates.branch)}?per_page=100&page=1`
    const response = await this.fetchImpl(apiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "opencodebot-update-checker",
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      const reset = response.headers?.get?.("x-ratelimit-reset")
      const suffix = reset ? ` Rate limit resets at ${new Date(Number(reset) * 1000).toISOString()}.` : ""
      throw new Error(`GitHub returned HTTP ${response.status}.${suffix}`)
    }
    const payload = await response.json()
    if (payload.status === "identical") {
      return { kind: "current", currentSha: baseSha, checkedAt: new Date().toISOString() }
    }
    if (payload.status !== "ahead") {
      return { kind: "blocked", currentSha: baseSha, status: payload.status || "unknown" }
    }
    const targetSha = String(payload.head_commit?.sha || payload.commits?.at(-1)?.sha || "").toLowerCase()
    if (!isGitRevision(targetSha)) throw new Error("GitHub compare response did not include a valid target revision")
    const commits = Array.isArray(payload.commits) ? payload.commits : []
    const changedPaths = Array.isArray(payload.files) ? payload.files.map((file) => file.filename) : []
    const summary = summarizeUpdateCommits(commits)
    summary.unlistedCommitCount = Math.max(0, (Number(payload.ahead_by) || commits.length) - commits.length)
    return {
      kind: "available",
      baseSha,
      targetSha,
      commitCount: Number(payload.ahead_by) || commits.length,
      summary,
      components: classifyChangedPaths(changedPaths),
      compareUrl: `https://github.com/${updates.repository}/compare/${baseSha}...${targetSha}`,
    }
  }

  async publishOffer({ chatId, topicId, result, replaceMessageId }) {
    const text = formatOfferMessage(result)
    const replyMarkup = offerKeyboard(result)
    let message
    if (replaceMessageId) {
      message = await this.telegram.editMessageText({ chatId, messageId: replaceMessageId, text, replyMarkup })
      message ||= { message_id: replaceMessageId }
    } else {
      message = await this.telegram.sendMessage({ chatId, topicId, text, replyMarkup })
    }
    const localDate = scheduledCheckDue({
      now: this.now(),
      timeZone: this.config.updates.timeZone,
      hour: 0,
      minute: 0,
    }).date
    const offer = {
      baseSha: result.baseSha,
      targetSha: result.targetSha,
      commitCount: result.commitCount,
      summary: result.summary,
      components: result.components,
      compareUrl: result.compareUrl,
      chatId,
      topicId,
      messageId: message.message_id,
      offeredAt: new Date().toISOString(),
    }
    await this.state.update((data) => {
      data.updates.offers = [...data.updates.offers.filter((candidate) => !(candidate.chatId === chatId && candidate.messageId === offer.messageId)), offer].slice(-12)
      data.updates.lastNotifiedSha = result.targetSha
      data.updates.lastNotifiedDate = localDate
    })
  }

  findOffer(chatId, messageId, targetSha) {
    return this.state.data.updates.offers.find((offer) => (
      String(offer.chatId) === String(chatId)
      && Number(offer.messageId) === Number(messageId)
      && offer.targetSha === targetSha
    ))
  }

  async markScheduledComplete(date) {
    this.scheduleRetryAt = 0
    await this.state.update((data) => {
      data.updates.lastScheduledDate = date
    })
  }

  startStatusPolling() {
    if (this.statusTimer) return
    this.statusTimer = setInterval(() => void this.reconcileStatus(), STATUS_INTERVAL_MS)
    this.statusTimer.unref?.()
    void this.reconcileStatus()
  }

  async reconcileStatus() {
    const run = this.state.data.updates?.activeRun
    if (!run) {
      clearInterval(this.statusTimer)
      this.statusTimer = null
      return
    }
    const status = await readJson(this.statusPath)
    if (!status || status.id !== run.id || status.stage === run.lastStage) return
    if (status.stage === "succeeded" || status.stage === "failed") {
      await this.finishRun(run, status)
      return
    }
    await this.telegram.editMessageText({
      chatId: run.chatId,
      messageId: run.messageId,
      text: formatProgressMessage(run, status),
      replyMarkup: EMPTY_KEYBOARD,
    })
    await this.state.update((data) => {
      if (data.updates.activeRun?.id === run.id) data.updates.activeRun.lastStage = status.stage
    })
  }

  async finishRun(run, status) {
    const components = status.components || run.components
    const text = status.stage === "succeeded"
      ? formatSuccessMessage(run, { ...status, components })
      : formatFailureMessage(run, status)
    try {
      await this.telegram.editMessageText({ chatId: run.chatId, messageId: run.messageId, text, replyMarkup: EMPTY_KEYBOARD })
    } catch {
      await this.telegram.sendMessage({ chatId: run.chatId, topicId: run.topicId, text })
    }
    await this.state.update((data) => {
      data.updates.activeRun = null
      data.updates.offers = data.updates.offers.filter((offer) => offer.targetSha !== run.targetSha)
    })
    await fs.rm(this.statusPath, { force: true })
    clearInterval(this.statusTimer)
    this.statusTimer = null
  }
}

function offerKeyboard(result) {
  return {
    inline_keyboard: [
      [{ text: "View all changes ↗", url: result.compareUrl }],
      [
        { text: "Update & restart", callback_data: `upd:apply:${result.targetSha}` },
        { text: "Not now", callback_data: `upd:later:${result.targetSha}` },
      ],
    ],
  }
}

function formatOfferMessage(result) {
  const lines = [
    "🆕 <b>opencodebot update available</b>",
    "",
    `<code>${shortRevision(result.baseSha)}</code> → <code>${shortRevision(result.targetSha)}</code> · ${result.commitCount} ${result.commitCount === 1 ? "commit" : "commits"}`,
  ]
  appendSummary(lines, result.summary)
  appendCompanionNotice(lines, result.components, false)
  lines.push("", "Only opencodebot will be rebuilt and restarted.")
  return lines.join("\n")
}

function formatCurrentMessage(result, updates) {
  return [
    "✅ <b>opencodebot is up to date</b>",
    "",
    `Version: <code>${shortRevision(result.currentSha)}</code>`,
    `Next automatic check: ${escapeHtml(updates.checkAt)} ${escapeHtml(updates.timeZone)}`,
  ].join("\n")
}

function formatBlockedMessage(result) {
  return [
    "⚠️ <b>Automatic update is blocked</b>",
    "",
    `GitHub reports the deployed revision as <code>${escapeHtml(result.status)}</code> relative to the configured branch.`,
    "The bot was not changed. Inspect the repository manually.",
  ].join("\n")
}

function formatProgressMessage(run, status) {
  const labels = {
    queued: "Waiting for the host update runner…",
    preparing: "Verifying the repository and target revision…",
    installing: "Installing locked dependencies…",
    checking: "Running local checks and smoke tests…",
    building: "Building the new opencodebot image…",
    restarting: "Restarting opencodebot…",
    verifying: "Running live health checks…",
    rolling_back: "Restoring the previous bot image…",
  }
  return [
    "⏳ <b>Updating opencodebot</b>",
    "",
    `<code>${shortRevision(run.baseSha)}</code> → <code>${shortRevision(run.targetSha)}</code>`,
    escapeHtml(labels[status.stage] || "Working…"),
    "",
    "OpenCodez will not be changed or restarted.",
  ].join("\n")
}

function formatSuccessMessage(run, status) {
  const lines = [
    "✅ <b>opencodebot updated</b>",
    "",
    `<code>${shortRevision(run.baseSha)}</code> → <code>${shortRevision(run.targetSha)}</code>`,
  ]
  if (status.durationMs) lines.push(`Completed in ${formatDuration(status.durationMs)}.`)
  appendSummary(lines, run.summary)
  appendCompanionNotice(lines, status.components, true)
  lines.push("", "OpenCodez was not changed or restarted.")
  return lines.join("\n")
}

function formatFailureMessage(run, status) {
  const lines = [
    "❌ <b>opencodebot update failed</b>",
    "",
    `<code>${shortRevision(run.baseSha)}</code> → <code>${shortRevision(run.targetSha)}</code>`,
    escapeHtml(status.error || "The host update runner reported an unknown error."),
  ]
  if (status.rolledBack) lines.push("", "The previous bot image was restored.")
  else if (status.serviceMayHaveChanged) lines.push("", "The replacement started but rollback did not complete. Inspect the live service.")
  else lines.push("", "The running bot was left unchanged.")
  return lines.join("\n")
}

function appendSummary(lines, summary) {
  if (!summary) return
  for (const section of summary.sections || []) {
    lines.push("", `${section.icon} <b>${escapeHtml(section.title)}</b>`)
    for (const item of section.items) lines.push(`• ${escapeHtml(item)}`)
  }
  if (summary.maintenanceCount) lines.push("", `⚙️ Technical maintenance: ${summary.maintenanceCount}`)
  if (summary.omittedCount) lines.push(`…and ${summary.omittedCount} more user-facing changes.`)
  if (summary.unlistedCommitCount) lines.push(`…and ${summary.unlistedCommitCount} more commits in the full comparison.`)
}

function appendCompanionNotice(lines, components, completed) {
  const names = []
  if (components?.plugin) names.push("OpenCodez artifact plugin")
  if (components?.skill) names.push("telegram-artifact-send skill")
  if (!names.length) return
  lines.push("", "⚠️ <b>Companion source changes detected</b>")
  for (const name of names) lines.push(`• ${escapeHtml(name)}`)
  lines.push(completed
    ? "Their installed OpenCodez copies were not updated. Apply them manually when convenient."
    : "Their installed OpenCodez copies will not be updated automatically.")
}

function formatDuration(durationMs) {
  const seconds = Math.max(1, Math.round(Number(durationMs) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function friendlyError(error) {
  const message = String(error?.message || error || "Unknown error")
  return (process.env.HOME ? message.replaceAll(process.env.HOME, "~") : message).slice(0, 500)
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.${process.pid}.tmp`
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  await fs.rename(temp, filePath)
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return null
    console.error(`Could not read update status: ${friendlyError(error)}`)
    return null
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}
