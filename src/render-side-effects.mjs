import { durationMs, logErrorEvent, logInfo, shouldLogSlow } from "./logger.mjs"

export function createRenderSideEffects({ telegram, config, onMirrorMessage, onFinalMessage }) {
  return {
    async notifyMirrorMessage(binding, message) {
      if (!message?.message_id) return
      if (onMirrorMessage) await onMirrorMessage(binding, message)
    },

    async notifyFinalMessage(binding, details) {
      if (!onFinalMessage) return
      try {
        await onFinalMessage(binding, details)
      } catch (error) {
        logErrorEvent("mirror.final_notification_callback.failed", error, {
          serverID: binding.serverID,
          sessionID: binding.sessionID,
          topicId: binding.topicId,
          messageId: details?.messageId,
          assistantMessageID: details?.assistantMessageID,
        })
      }
    },

    async pinMessage(binding, messageId, fields = {}) {
      if (!messageId) return false
      const { serviceMessageAfterId, ...logFields } = fields
      const startedAt = Date.now()
      try {
        await telegram.pinChatMessage({ chatId: binding.chatId, messageId, disableNotification: false })
        const elapsedMs = durationMs(startedAt)
        logMirrorFlush("mirror.pin.sent", binding, { messageId, durationMs: elapsedMs, ...logFields })
        if (shouldLogSlow(elapsedMs)) logMirrorFlush("mirror.pin.slow", binding, { messageId, durationMs: elapsedMs, ...logFields })
        cleanupPinServiceMessage({ telegram, config, binding, serviceMessageAfterId, fields: logFields })
        return true
      } catch (error) {
        logErrorEvent("mirror.pin.failed", error, { serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId, messageId, ...logFields })
        return false
      }
    },

    shouldPinUserPrompts() {
      const mirror = config.mirror || {}
      return mirror.pinUserPrompts ?? true
    },
  }
}

function cleanupPinServiceMessage({ telegram, config, binding, serviceMessageAfterId, fields = {} }) {
  if (config.mirror.deletePinServiceMessages === false) return
  const afterMessageId = Number(serviceMessageAfterId)
  if (!Number.isSafeInteger(afterMessageId) || afterMessageId <= 0) return
  const serviceMessageId = afterMessageId + 1
  setTimeout(async () => {
    try {
      await telegram.deleteMessage({ chatId: binding.chatId, messageId: serviceMessageId, suppressFailureLog: true })
      logMirrorFlush("mirror.pin_service.deleted", binding, { messageId: serviceMessageId, afterMessageId, ...fields })
    } catch (error) {
      if (!/message to delete not found|message can't be deleted|message not found/i.test(error.message)) {
        logErrorEvent("mirror.pin_service.delete.failed", error, { serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId, messageId: serviceMessageId, afterMessageId, ...fields })
      }
    }
  }, 1000).unref?.()
}

function logMirrorFlush(event, binding, fields = {}) {
  logInfo(event, { serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId, ...fields })
}
