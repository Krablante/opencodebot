// Keep the deadline alive until response-body processing has finished as well.
export async function withRequestTimeout({ signal, timeoutMs }, operation, label = "Request") {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  timer.unref?.()
  const onAbort = () => controller.abort(signal.reason)
  if (signal?.aborted) onAbort()
  else signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const result = await operation(controller.signal)
    controller.signal.throwIfAborted()
    return result
  } catch (error) {
    controller.signal.throwIfAborted()
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}
