export const EXIT_GRACE_MS = 1000

export interface ExitDeps {
  setExitCode: (code: number) => void
  exit: (code: number) => void
  setTimer: (fn: () => void, ms: number) => { unref: () => void }
}

// Windows + Node 24: calling process.exit() while handles from a completed
// fetch (undici pool sockets) are still settling trips libuv's
// `UV_HANDLE_CLOSING` assertion (src/win/async.c) and the process dies with
// -1073740791. Letting the event loop drain first (exitCode only) exits
// cleanly in ~1ms; the unref'd grace timer never fires in that case and only
// force-exits if some other handle refuses to release the loop.
export function settleExit(code: number, deps?: Partial<ExitDeps>): void {
  const d: ExitDeps = {
    setExitCode: (c) => {
      process.exitCode = c
    },
    exit: (c) => process.exit(c),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    ...deps,
  }
  d.setExitCode(code)
  const force = d.setTimer(() => d.exit(code), EXIT_GRACE_MS)
  force.unref()
}
