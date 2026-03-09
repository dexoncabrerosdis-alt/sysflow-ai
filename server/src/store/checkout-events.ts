const listeners = new Map<string, (data: Record<string, unknown>) => void>()

export function onCheckoutComplete(sessionId: string, callback: (data: Record<string, unknown>) => void): void {
  listeners.set(sessionId, callback)
}

export function removeCheckoutListener(sessionId: string): void {
  listeners.delete(sessionId)
}

export function emitCheckoutComplete(sessionId: string, data: Record<string, unknown>): void {
  const cb = listeners.get(sessionId)
  if (cb) {
    cb(data)
    listeners.delete(sessionId)
  }
}
