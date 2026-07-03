import { summarizeWords } from "./prompt-queue.mjs"
import { escapeHtml, topicId } from "./telegram.mjs"

export const telegramBotCommands = [
  { command: "new", description: "Create a new OpenCodez session topic" },
  { command: "session", description: "Show current topic and OpenCodez session info" },
  { command: "artifacts_here", description: "Use this topic for agent artifact uploads" },
  { command: "q", description: "Queue prompts for the current session" },
  { command: "kill", description: "Stop the current run and clear queued prompts" },
  { command: "notify_on", description: "Enable final-answer DMs" },
  { command: "notify_off", description: "Disable final-answer DMs" },
  { command: "notify_status", description: "Show final-answer DM status" },
  { command: "mirror_on", description: "Enable web-to-Telegram mirroring" },
  { command: "mirror_off", description: "Disable web-to-Telegram mirroring" },
  { command: "help", description: "Show commands and templates" },
  { command: "start", description: "Show help" },
]

export function createTelegramCommandHandlers({ config, state, telegram, opencode, promptQueue, multipartPrompts, createPendingTopic }) {
  const handlers = {
    mirror_on: async (message) => {
      await state.setMirrorEnabled(true)
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "Mirror enabled." })
    },
    mirror_off: async (message) => {
      await state.setMirrorEnabled(false)
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "Mirror disabled." })
    },
    artifacts_here: handleArtifactsHere,
    session: handleSessionInfo,
    new: createPendingTopic,
    help: sendHelp,
    start: sendHelp,
    q: handleQueueCommand,
    kill: handleKillCommand,
    notify_on: handleNotifyOn,
    notify_off: handleNotifyOff,
    notify_status: handleNotifyStatus,
  }

  return {
    async handle(message, command, promptKey) {
      const handler = handlers[command.name]
      if (!handler) return false
      if (command.name === "kill") multipartPrompts.discardKey(promptKey)
      else await multipartPrompts.flushKey(promptKey)
      await handler(message, command.args)
      return true
    },
  }

  async function handleQueueCommand(message, args) {
    const binding = state.findBindingByTopic(message.chat.id, topicId(message))
    if (!binding) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "No OpenCodez session is bound to this topic. Use /new to create a topic, or run /q inside an existing OpenCodez topic." })
      return
    }

    const input = String(args || "").trim()
    if (!input || input.toLowerCase() === "status") {
      await sendQueueStatus(message, binding)
      return
    }

    if (/^delete\b/i.test(input) && !/^delete\s+\d+$/i.test(input)) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "Usage: <code>/q delete &lt;number&gt;</code>" })
      return
    }

    const deleteMatch = input.match(/^delete\s+(\d+)$/i)
    if (deleteMatch) {
      const removed = promptQueue.delete(binding, Number(deleteMatch[1]))
      const text = removed
        ? `Deleted queued prompt #${removed.index}: <code>${escapeHtml(removed.summary)}</code>`
        : `No queued prompt #${escapeHtml(deleteMatch[1])}.`
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text })
      return
    }

    const result = await promptQueue.enqueue(binding, input, { sourceMessageId: message.message_id })
    if (result.status === "queued") {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: topicId(message),
        text: `Queued prompt #${result.position}: <code>${escapeHtml(summarizeWords(input, 10))}</code>`,
      })
    }
  }

  async function handleKillCommand(message) {
    const currentTopicId = topicId(message)
    const binding = state.findBindingByTopic(message.chat.id, currentTopicId)
    if (!binding) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: currentTopicId, text: "No OpenCodez session is bound to this topic. Use /new to create a topic, or run /kill inside an existing OpenCodez topic." })
      return
    }
    if (!opencode?.abortSession) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: currentTopicId, text: "OpenCodez abort API is not available." })
      return
    }

    const wasBusy = promptQueue.isBusy(binding)
    await opencode.abortSession(binding.serverID, binding.sessionID, { directory: binding.directory })
    const cleared = promptQueue.clear(binding, "Killed by /kill")
    const lines = [
      wasBusy ? "Stop signal sent to the current OpenCodez run." : "Stop signal sent to OpenCodez.",
      cleared.length ? `Cleared ${cleared.length} queued prompt(s).` : "No queued prompts were pending.",
    ]
    await telegram.sendMessage({ chatId: message.chat.id, topicId: currentTopicId, text: lines.join("\n") })
  }

  async function handleNotifyOn(message) {
    if (config.finalNotifications?.enabled === false) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "Final DM notifications are disabled in config." })
      return
    }
    const userIds = configuredFinalNotificationUserIds()
    if (!userIds.length) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "No final notification userIds are configured." })
      return
    }
    const enabled = []
    const failed = []
    for (const userID of userIds) {
      try {
        await telegram.sendMessage({
          chatId: userID,
          text: "🔔 Final answer notifications enabled\n🏁 I will DM you when a mirrored topic gets its final answer\n🔗 The DM includes the source topic, an Open topic button, and context quotes",
        })
        await state.enableFinalNotificationsFor(userID)
        enabled.push(userID)
      } catch (error) {
        failed.push({ userID, error })
      }
    }
    if (failed.length) {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: topicId(message),
        text: [
          enabled.length ? `🔔 Enabled for ${enabled.length} configured recipient(s).` : "🔴 No configured recipients were enabled.",
          "Some configured recipients cannot receive DMs yet:",
          ...failed.map((item) => `<code>${escapeHtml(item.userID)}</code>: <code>${escapeHtml(item.error.message)}</code>`),
          "Open a private chat with this bot from that account, press Start or send /start, then run /notify_on again.",
        ].join("\n"),
      })
      return
    }
    await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: `🔔 Final DM notifications enabled for ${enabled.length} configured recipient(s).` })
  }

  async function handleNotifyOff(message) {
    const userIds = configuredFinalNotificationUserIds()
    for (const userID of userIds) await state.disableFinalNotificationsFor(userID)
    await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: `🔕 Final DM notifications disabled for ${userIds.length} configured recipient(s).` })
  }

  async function handleNotifyStatus(message) {
    const userIds = configuredFinalNotificationUserIds()
    const enabled = config.finalNotifications?.enabled !== false ? userIds.filter((userID) => state.finalNotificationsEnabledFor(userID)) : []
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: topicId(message),
      text: [
        config.finalNotifications?.enabled === false ? "🔕 Final DM notifications are disabled in config." : "🔔 Final DM notifications config",
        `Configured recipients: <code>${escapeHtml(String(userIds.length))}</code>`,
        `Enabled recipients: <code>${escapeHtml(String(enabled.length))}</code>`,
      ].join("\n"),
    })
  }

  function configuredFinalNotificationUserIds() {
    return [...new Set((config.finalNotifications?.userIds || []).map(String))]
  }

  async function handleArtifactsHere(message) {
    const currentTopicId = topicId(message)
    if (!currentTopicId) {
      await telegram.sendMessage({ chatId: message.chat.id, text: "Run /artifacts_here inside a Telegram forum topic." })
      return
    }
    const existing = state.findBindingByTopic(message.chat.id, currentTopicId)
    const target = await state.setArtifactsTopic({
      chatId: message.chat.id,
      topicId: currentTopicId,
      title: existing?.title || `Topic ${currentTopicId}`,
      setBy: message.from?.id,
    })
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: currentTopicId,
      text: [
        "Artifacts topic configured.",
        "This is now the only agent artifact target; any previous artifacts topic was forgotten.",
        "Web/session mirroring is disabled for this topic.",
        `Target: <code>${escapeHtml(String(target.chatId))}</code> / <code>${escapeHtml(String(target.topicId))}</code>`,
      ].join("\n"),
    })
  }

  async function handleSessionInfo(message) {
    const currentTopicId = topicId(message)
    const activeBinding = state.findBindingByTopic(message.chat.id, currentTopicId)
    const storedBinding = activeBinding || state.findAnyBindingByTopic(message.chat.id, currentTopicId)
    const server = storedBinding ? config.opencode.servers.find((item) => item.id === storedBinding.serverID) : null
    const artifactsTopic = state.artifactsTopic()
    const thisIsArtifactsTopic = state.isArtifactsTopic(message.chat.id, currentTopicId)
    let session = null
    let sessionError = ""
    if (storedBinding?.serverID && storedBinding?.sessionID && opencode?.getSession) {
      try {
        session = await opencode.getSession(storedBinding.serverID, storedBinding.sessionID, { directory: storedBinding.directory })
      } catch (error) {
        sessionError = error.message
      }
    }
    const sessionUrl = sessionWebUrl(server, storedBinding?.sessionID, session)
    const lines = [
      "🧭 <b>Session</b>",
      "",
      "💬 <b>Telegram</b>",
      `chat_id: <code>${escapeHtml(String(message.chat.id))}</code>`,
      `topic_id: <code>${escapeHtml(String(currentTopicId || 0))}</code>`,
      `message_id: <code>${escapeHtml(String(message.message_id))}</code>`,
      "",
    ]
    if (storedBinding) {
      lines.push(
        "🔗 <b>Binding</b>",
        `status: ${activeBinding ? "🟢 active" : "⚪ disabled"}`,
        `server: <code>${escapeHtml(storedBinding.serverID || "")}</code>`,
        `session: <code>${escapeHtml(storedBinding.sessionID || "")}</code>`,
        storedBinding.disabledReason ? `reason: <code>${escapeHtml(storedBinding.disabledReason)}</code>` : null,
        storedBinding.title ? `title: <code>${escapeHtml(storedBinding.title)}</code>` : null,
        "",
      )
    } else {
      lines.push("🔗 <b>Binding</b>", "status: ⚪ no OpenCodez session bound", "")
    }
    if (storedBinding) {
      const directory = session?.directory || storedBinding.directory
      lines.push(
        "🖥 <b>OpenCodez</b>",
        server?.url ? `server_url: <code>${escapeHtml(server.url)}</code>` : "server_url: unavailable",
        directory ? `directory: <code>${escapeHtml(directory)}</code>` : null,
        session?.agent || storedBinding.agent ? `agent: <code>${escapeHtml(session?.agent || storedBinding.agent)}</code>` : null,
        modelLine(session?.model || storedBinding.model),
        sessionUrl ? `url: <code>${escapeHtml(sessionUrl)}</code>` : "url: unavailable",
        sessionError ? `lookup_error: <code>${escapeHtml(sessionError)}</code>` : null,
        "",
      )
    }
    lines.push(
      "📦 <b>Artifacts</b>",
      `this_topic: ${thisIsArtifactsTopic ? "🟢 yes" : "⚪ no"}`,
      artifactsTopic ? `current_topic_id: <code>${escapeHtml(String(artifactsTopic.topicId || 0))}</code>` : "current_topic_id: none",
      artifactsTopic?.title ? `current_title: <code>${escapeHtml(artifactsTopic.title)}</code>` : null,
    )
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: currentTopicId,
      text: lines.filter(Boolean).join("\n"),
      replyMarkup: sessionUrl ? { inline_keyboard: [[{ text: "Open session", url: sessionUrl }]] } : undefined,
    })
  }

  async function sendHelp(message) {
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: topicId(message),
      text: helpText(),
    })
  }

  function helpText() {
    const templates = Object.keys(config.chatTemplates || {}).join(", ") || "none"
    return [
      "<b>OpenCodez Bot</b>",
      "",
      "<code>/new [server] [template] [dir:&lt;path&gt;] [title]</code> - create a topic and wait for the first prompt.",
      "<code>/session</code> - show current topic, binding, session URL, and artifact target info.",
      "<code>/q &lt;prompt&gt;</code> - queue a prompt for this topic/session.",
      "<code>/q status</code> - show queued prompts.",
      "<code>/q delete &lt;number&gt;</code> - remove a queued prompt.",
      "<code>/kill</code> - stop the current run and clear queued prompts.",
      "<code>/artifacts_here</code> - make this topic the artifact target and file dropbox.",
      "Drop files there with an optional server id caption; no caption uses the default server.",
      "<code>/notify_on</code> / <code>/notify_off</code> - toggle final-answer DMs for configured recipients.",
      "<code>/notify_status</code> - show configured final-answer DM status.",
      "<code>/mirror_on</code> / <code>/mirror_off</code> - toggle web-to-Telegram mirroring.",
      "",
      `Templates: <code>${escapeHtml(templates)}</code>`,
      "Files: send files/photos with a caption, or send files first and prompt text next.",
    ].join("\n")
  }

  async function sendQueueStatus(message, binding) {
    const items = promptQueue.status(binding)
    if (!items.length) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "Queue is empty." })
      return
    }
    const lines = items.map((item) => `${item.index}. <code>${escapeHtml(item.summary)}</code>`)
    await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: `Queued prompts:\n${lines.join("\n")}` })
  }
}

function sessionWebUrl(server, sessionID, session) {
  const baseUrl = String(server?.url || "").replace(/\/+$/, "")
  const directory = session?.directory
  if (!baseUrl || !sessionID || !directory) return ""
  const encodedDirectory = Buffer.from(String(directory)).toString("base64").replace(/=+$/, "")
  return `${baseUrl}/${encodeURIComponent(encodedDirectory)}/session/${encodeURIComponent(sessionID)}`
}

function modelLine(model) {
  if (!model) return null
  const provider = model.providerID ? `${model.providerID}/` : ""
  const id = model.modelID || model.id || ""
  const variant = model.variant ? ` ${model.variant}` : ""
  const value = `${provider}${id}${variant}`.trim()
  return value ? `model: <code>${escapeHtml(value)}</code>` : null
}
