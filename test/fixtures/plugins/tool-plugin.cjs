module.exports = function (ctx) {
  ctx.registerTool({
    name: 'cjs_greeter',
    description: 'cjs test plugin',
    async run() {
      return { output: 'hello from cjs' }
    },
  })
}
