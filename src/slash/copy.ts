export function osc52(text: string, inTmux: boolean): string {
  const seq = `\u001B]52;c;${Buffer.from(text).toString('base64')}\u0007`
  // tmux only forwards OSC 52 to the outer terminal inside a DCS passthrough.
  return inTmux ? `\u001BPtmux;${seq.replaceAll('\u001B', '\u001B\u001B')}\u001B\\` : seq
}
