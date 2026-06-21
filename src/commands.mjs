import { summarizeWords } from "./prompt-queue.mjs"
import { escapeHtml, topicId } from "./telegram.mjs"

export function createTelegramCommandHandlers({ config, state, telegram, promptQueue, multipartPrompts, createPendingTopic }) {
  const handlers = {
    mirror_on: async (message) => {
      await state.setMirrorEnabled(true)
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "Mirror enabled." })
    },
    mirror_off: async (message) => {
      await state.setMirrorEnabled(false)
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "Mirror disabled." })
    },
    new: createPendingTopic,
    help: sendHelp,
    start: sendHelp,
    q: handleQueueCommand,
  }

  return {
    async handle(message, command, promptKey) {
      const handler = handlers[command.name]
      if (!handler) return false
      await multipartPrompts.flushKey(promptKey)
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

    const result = await promptQueue.enqueue(binding, input)
    if (result.status === "queued") {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: topicId(message),
        text: `Queued prompt #${result.position}: <code>${escapeHtml(summarizeWords(input, 10))}</code>`,
      })
    }
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
      "<code>/new [server] [template] [title]</code> - create a topic and wait for the first prompt.",
      "<code>/q &lt;prompt&gt;</code> - queue a prompt for this topic/session.",
      "<code>/q status</code> - show queued prompts.",
      "<code>/q delete &lt;number&gt;</code> - remove a queued prompt.",
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
