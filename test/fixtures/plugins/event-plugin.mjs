export function activate(ctx) {
  const push = (label) => {
    globalThis.__pluginOrder = [...(globalThis.__pluginOrder ?? []), label]
  }
  ctx.on('SessionStart', () => push('first'))
  ctx.on('SessionStart', () => {
    push('second')
    throw new Error('handler boom')
  })
  ctx.on('SessionStart', () => push('third'))
}
