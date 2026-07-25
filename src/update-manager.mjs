import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { escapeHtml } from "./telegram.mjs"
import { t } from "./i18n/index.mjs"
import { classifyChangedPaths, isGitRevision, scheduledCheckDue, shortRevision, summarizeUpdateCommits } from "./update-shared.mjs"

const GITHUB_API_VERSION = "2026-03-10"
const SCHEDULE_INTERVAL_MS = 60_000
const STATUS_INTERVAL_MS = 2_500
const SCHEDULE_RETRY_MS = 15 * 60_000
const STALE_RUN_MS = 35 * 60_000
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
    this.processingPath = path.join(this.runtimeDir, "request.processing.json")
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
      await this.telegram.sendMessage({ chatId, topicId, text: t("updates.disabled") })
      return
    }
    if (!isGitRevision(this.config.updates.currentRevision)) {
      await this.telegram.sendMessage({
        chatId,
        topicId,
        text: t("updates.notReady"),
      })
      return
    }

    const waiting = await this.telegram.sendMessage({
      chatId,
      topicId,
      text: t("updates.checking"),
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
        text: t("updates.checkFailed", { errorHtml: escapeHtml(friendlyError(error)) }),
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
        text: t("updates.offerExpired"),
        showAlert: true,
      })
      return true
    }

    if (action === "later") {
      await this.telegram.answerCallbackQuery({ callbackQueryId: query.id, text: t("updates.deferredCallback") })
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
        text: t("updates.deferred", { from: shortRevision(offer.baseSha), to: shortRevision(targetSha), checkAt: escapeHtml(this.config.updates.checkAt), timeZone: escapeHtml(this.config.updates.timeZone) }),
        replyMarkup: EMPTY_KEYBOARD,
      })
      return true
    }

    if (offer.components?.controlPlane?.length) {
      await this.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        text: t("updates.controlPlane"),
        showAlert: true,
      })
      return true
    }

    if (this.state.data.updates.activeRun) {
      await this.telegram.answerCallbackQuery({ callbackQueryId: query.id, text: t("updates.alreadyRunning"), showAlert: true })
      return true
    }
    if (this.config.updates.currentRevision !== offer.baseSha) {
      await this.telegram.answerCallbackQuery({ callbackQueryId: query.id, text: t("updates.versionChanged"), showAlert: true })
      return true
    }
    if (!(await fileExists(this.runnerInfoPath))) {
      await this.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        text: t("updates.runnerMissing"),
        showAlert: true,
      })
      return true
    }

    await this.telegram.answerCallbackQuery({ callbackQueryId: query.id, text: t("updates.queued") })
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
        text: t("updates.queueFailed", { errorHtml: escapeHtml(friendlyError(error)) }),
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
    const loadedStatus = await readJson(this.statusPath)
    const status = loadedStatus?.id === run.id ? loadedStatus : null
    if (status?.stage === "succeeded" || status?.stage === "failed") {
      await this.finishRun(run, status)
      return
    }
    if (runIsStale(run, status, this.now())) {
      await fs.rm(this.requestPath, { force: true })
      await fs.rm(this.processingPath, { force: true })
      await this.finishRun(run, {
        stage: "failed",
        error: t("updates.staleRunner"),
        serviceMayHaveChanged: ["restarting", "verifying", "rolling_back"].includes(status?.stage),
      })
      return
    }
    if (!status || status.stage === run.lastStage) return
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
  if (result.components?.controlPlane?.length) {
    return {
      inline_keyboard: [
        [{ text: t("updates.viewChanges"), url: result.compareUrl }],
        [{ text: t("updates.notNow"), callback_data: `upd:later:${result.targetSha}` }],
      ],
    }
  }
  return {
    inline_keyboard: [
      [{ text: t("updates.viewChanges"), url: result.compareUrl }],
      [
        { text: t("updates.apply"), callback_data: `upd:apply:${result.targetSha}` },
        { text: t("updates.notNow"), callback_data: `upd:later:${result.targetSha}` },
      ],
    ],
  }
}

function formatOfferMessage(result) {
  const lines = [
    t("updates.offerTitle"),
    "",
    `<code>${shortRevision(result.baseSha)}</code> → <code>${shortRevision(result.targetSha)}</code> · ${t("updates.commits", { count: result.commitCount })}`,
  ]
  appendSummary(lines, result.summary)
  appendCompanionNotice(lines, result.components, false)
  if (result.components?.controlPlane?.length) appendManualUpdateNotice(lines, result.components.controlPlane)
  else lines.push("", t("updates.onlyBot"))
  return lines.join("\n")
}

function formatCurrentMessage(result, updates) {
  return [
    t("updates.currentTitle"),
    "",
    t("updates.version", { revision: shortRevision(result.currentSha) }),
    t("updates.nextCheck", { checkAt: escapeHtml(updates.checkAt), timeZone: escapeHtml(updates.timeZone) }),
  ].join("\n")
}

function formatBlockedMessage(result) {
  return [
    t("updates.blockedTitle"),
    "",
    t("updates.blockedStatus", { statusHtml: escapeHtml(result.status) }),
    t("updates.blockedHelp"),
  ].join("\n")
}

function formatProgressMessage(run, status) {
  const stageKey = `updates.stage.${status.stage}`
  return [
    t("updates.progressTitle"),
    "",
    `<code>${shortRevision(run.baseSha)}</code> → <code>${shortRevision(run.targetSha)}</code>`,
    escapeHtml(Object.hasOwn({ queued: 1, preparing: 1, installing: 1, checking: 1, building: 1, restarting: 1, verifying: 1, rolling_back: 1 }, status.stage) ? t(stageKey) : t("updates.stage.working")),
    "",
    t("updates.opencodeUntouched"),
  ].join("\n")
}

function formatSuccessMessage(run, status) {
  const lines = [
    t("updates.successTitle"),
    "",
    `<code>${shortRevision(run.baseSha)}</code> → <code>${shortRevision(run.targetSha)}</code>`,
  ]
  if (status.durationMs) lines.push(t("updates.completedIn", { duration: formatDuration(status.durationMs) }))
  appendSummary(lines, run.summary)
  appendCompanionNotice(lines, status.components, true)
  lines.push("", t("updates.opencodeWasUntouched"))
  return lines.join("\n")
}

function formatFailureMessage(run, status) {
  const lines = [
    t("updates.failureTitle"),
    "",
    `<code>${shortRevision(run.baseSha)}</code> → <code>${shortRevision(run.targetSha)}</code>`,
    escapeHtml(status.error || t("updates.unknownRunnerError")),
  ]
  if (status.rolledBack) lines.push("", t("updates.rolledBack"))
  else if (status.serviceMayHaveChanged) lines.push("", t("updates.rollbackIncomplete"))
  else lines.push("", t("updates.botUnchanged"))
  return lines.join("\n")
}

function appendSummary(lines, summary) {
  if (!summary) return
  for (const section of summary.sections || []) {
    lines.push("", `${section.icon} <b>${escapeHtml(section.title)}</b>`)
    for (const item of section.items) lines.push(`• ${escapeHtml(item)}`)
  }
  if (summary.maintenanceCount) lines.push("", t("updates.maintenance", { count: summary.maintenanceCount }))
  if (summary.omittedCount) lines.push(t("updates.omittedChanges", { count: summary.omittedCount }))
  if (summary.unlistedCommitCount) lines.push(t("updates.omittedCommits", { count: summary.unlistedCommitCount }))
}

function appendCompanionNotice(lines, components, completed) {
  const names = []
  if (components?.plugin) names.push("OpenCodez artifact plugin")
  if (components?.skill) names.push("telegram-artifact-send skill")
  if (!names.length) return
  lines.push("", t("updates.companionTitle"))
  for (const name of names) lines.push(`• ${escapeHtml(name)}`)
  lines.push(completed
    ? t("updates.companionCompleted")
    : t("updates.companionPending"))
}

function appendManualUpdateNotice(lines, paths) {
  const composeChanged = paths.some((value) => /^(?:docker-)?compose(?:\.[^/]+)?\.ya?ml$/i.test(value))
  const installerChanged = paths.includes("scripts/install-update-runner.mjs")
  const commands = ["git pull"]
  if (installerChanged) commands.push("npm run update-runner:install")
  commands.push(composeChanged ? "npm run deploy:all" : "npm run deploy:bot")
  lines.push("", t("updates.manualTitle"))
  lines.push(t("updates.manualReason"))
  for (const changedPath of paths) lines.push(`• <code>${escapeHtml(changedPath)}</code>`)
  lines.push("", t("updates.runOnHost"), `<code>${escapeHtml(commands.join(" && "))}</code>`)
}

function runIsStale(run, status, now) {
  const timestamp = Date.parse(status?.updatedAt || run?.requestedAt || "")
  return Number.isFinite(timestamp) && now.getTime() - timestamp > STALE_RUN_MS
}

function formatDuration(durationMs) {
  const seconds = Math.max(1, Math.round(Number(durationMs) / 1000))
  if (seconds < 60) return t("common.duration.seconds", { value: seconds })
  return t("common.duration.minutes", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })
}

function friendlyError(error) {
  const message = String(error?.message || error || t("updates.unknownError"))
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
