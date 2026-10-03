export const ABORTED = Symbol('aborted')

/** Resolves with the promise's value, or with ABORTED as soon as the signal fires. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED)
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** Collects an async iterable, giving up (and telling the iterator to stop) as soon as the signal fires. */
export async function collectUntilAbort<T>(iterable: AsyncIterable<T>, signal: AbortSignal | undefined, onItem: (item: T) => void): Promise<boolean> {
  const iterator = iterable[Symbol.asyncIterator]()
  try {
    for (;;) {
      const next = signal ? await raceAbort(iterator.next(), signal) : await iterator.next()
      if (next === ABORTED) return false
      if (next.done) return true
      onItem(next.value)
    }
  } finally {
    // Queued behind a step that is still running; it ends the walk as soon as that step returns.
    Promise.resolve(iterator.return?.(undefined)).catch(() => {})
  }
}
