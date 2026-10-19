// Minimal fake LSP server for tests: answers initialize/shutdown and publishes
// one canned error diagnostic for every didOpen.
let buf = Buffer.alloc(0)
const send = (msg) => {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
}
const handle = (msg) => {
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } })
  if (msg.method === 'textDocument/didOpen') {
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: msg.params.textDocument.uri,
        diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'fake problem' }],
      },
    })
  }
  if (msg.method === 'textDocument/didChange') {
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: msg.params.textDocument.uri,
        diagnostics: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, severity: 2, message: `fake problem v${msg.params.textDocument.version}` }],
      },
    })
  }
  if (msg.method === 'textDocument/hover') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { contents: { kind: 'markdown', value: `hover-doc pid=${process.pid} line=${msg.params.position.line}` } },
    })
  }
  if (msg.method === 'textDocument/definition') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [{ uri: msg.params.textDocument.uri, range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } } }],
    })
  }
  if (msg.method === 'textDocument/references') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [{ uri: msg.params.textDocument.uri, range: { start: { line: 9, character: 0 }, end: { line: 9, character: 5 } } }],
    })
  }
  if (msg.method === 'shutdown') send({ jsonrpc: '2.0', id: msg.id, result: null })
  if (msg.method === 'exit') process.exit(0)
}
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const idx = buf.indexOf('\r\n\r\n')
    if (idx < 0) return
    const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, idx).toString('ascii'))
    if (!m) {
      buf = buf.subarray(idx + 4)
      continue
    }
    const len = Number(m[1])
    if (buf.length < idx + 4 + len) return
    const body = buf.subarray(idx + 4, idx + 4 + len)
    buf = buf.subarray(idx + 4 + len)
    try {
      handle(JSON.parse(body.toString('utf8')))
    } catch {}
  }
})
