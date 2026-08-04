export function logicalTurnStartIndex(messages, assistantMessageID) {
  if (!Array.isArray(messages) || !messages.length) return -1
  const stopIndex = assistantMessageIndex(messages, assistantMessageID)
  const references = compactionReferences(messages)
  for (let index = stopIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (messageRole(message) !== "user") continue
    const id = messageID(message)
    const rootID = references.replayRoots.get(id) || references.markerRoots.get(id)
    if (rootID) {
      const rootIndex = referencedRootIndex(messages, references, rootID)
      if (rootIndex >= 0) return rootIndex
      continue
    }
    if (isInternalUserMessage(message)) continue
    return index
  }
  return -1
}

function referencedRootIndex(messages, references, initialID) {
  let id = initialID
  const visited = new Set()
  while (id && !visited.has(id)) {
    visited.add(id)
    const parent = references.replayRoots.get(id) || references.markerRoots.get(id)
    if (!parent) break
    id = parent
  }
  return messages.findIndex((message) => messageID(message) === id)
}

export function logicalTurnSliceReady(messages, assistantMessageID, hasMore, lookbehindMessages = 20) {
  if (!Array.isArray(messages) || !messages.length) return false
  const stopIndex = assistantMessageIndex(messages, assistantMessageID)
  let nearestUserIndex = -1
  for (let index = stopIndex - 1; index >= 0; index -= 1) {
    if (messageRole(messages[index]) !== "user") continue
    nearestUserIndex = index
    break
  }
  if (nearestUserIndex < 0) return false
  const startIndex = logicalTurnStartIndex(messages, assistantMessageID)
  if (startIndex < 0) return !hasMore
  if (!hasMore) return true
  const lookbehind = messages.slice(0, startIndex)
  // A replay follows its compaction marker and summary directly; one full page without another user proves an external turn.
  const requiredLookbehind = Math.max(2, lookbehindMessages)
  return lookbehind.some((message) => messageRole(message) === "user") || lookbehind.length >= requiredLookbehind
}

export function logicalTurnRootID(messages, userMessageID) {
  if (!Array.isArray(messages) || !userMessageID) return ""
  const userIndex = messages.findIndex((message) => messageID(message) === userMessageID)
  if (userIndex < 0) return ""
  const startIndex = logicalTurnStartIndex(messages.slice(0, userIndex + 1))
  return startIndex >= 0 ? messageID(messages[startIndex]) : ""
}

export function isInternalUserMessage(message) {
  if (messageRole(message) !== "user") return false
  const parts = Array.isArray(message?.parts) ? message.parts : []
  if (parts.some((part) => part?.type === "compaction")) return true
  const inputs = parts.filter((part) => part?.type === "text" || part?.type === "file")
  return inputs.length > 0 && inputs.every((part) => part.synthetic === true)
}

function compactionReferences(messages) {
  const markerRoots = new Map()
  const replayRoots = new Map()
  for (const message of messages) {
    const markerID = messageID(message)
    for (const part of message?.parts || []) {
      if (part?.type !== "compaction" || !part.turn_id) continue
      if (markerID) markerRoots.set(markerID, String(part.turn_id))
      if (part.replay_id) replayRoots.set(String(part.replay_id), String(part.turn_id))
    }
  }
  return { markerRoots, replayRoots }
}

function assistantMessageIndex(messages, assistantMessageID) {
  if (assistantMessageID) {
    const index = messages.findIndex((message) => messageID(message) === assistantMessageID)
    if (index >= 0) return index
  }
  return messages.length
}

function messageID(message) {
  return String(message?.info?.id || message?.id || "")
}

function messageRole(message) {
  return String(message?.info?.role || message?.role || "")
}
