// Simple event emitter for checkout completion notifications
// WS clients register by sessionId, and get notified when payment completes

const listeners = new Map()

export function onCheckoutComplete(sessionId, callback) {
  listeners.set(sessionId, callback)
}

export function removeCheckoutListener(sessionId) {
  listeners.delete(sessionId)
}

export function emitCheckoutComplete(sessionId, data) {
  const cb = listeners.get(sessionId)
  if (cb) {
    cb(data)
    listeners.delete(sessionId)
  }
}
