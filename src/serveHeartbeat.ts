export interface Heartbeat {
  /** Sends the first ping and schedules the check loop. Idempotent until stop(). */
  start(): void
  /** Marks the last ping as answered (ws 'pong' event). */
  pong(): void
  /** Clears the timer; no further pings or terminations. */
  stop(): void
}

/**
 * ws heartbeat with deadline: every interval a ping goes out; a ping left
 * unanswered by the next tick terminates the socket (connection, not stream).
 * Modeled on the DSH gateway's `websocketHeartbeatIntervalMs` behavior.
 */
export function createHeartbeat(intervalMs: number, ping: () => void, terminate: () => void): Heartbeat {
  let awaitingPong = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const tick = (): void => {
    if (stopped) return
    if (awaitingPong) {
      terminate()
      timer = null
      return
    }
    awaitingPong = true
    ping()
    timer = setTimeout(tick, intervalMs)
  }

  return {
    start(): void {
      if (stopped || timer) return
      awaitingPong = true
      ping()
      timer = setTimeout(tick, intervalMs)
    },
    pong(): void {
      awaitingPong = false
    },
    stop(): void {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
