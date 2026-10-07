export default (ctx) => {
  globalThis.__pluginCtx = ctx
  ctx.registerTool({
    name: 'greeter',
    description: 'Say hello from a test plugin.',
    async run() {
      return { output: 'hello from plugin' }
    },
  })
}
