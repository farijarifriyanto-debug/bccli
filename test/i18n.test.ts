import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { helpText, parseCliArgs } from '../src/args'
import { SLASH_COMMANDS } from '../src/commands'
import { getLanguage, langFromArgv, locale, parseLang, resolveLanguage, setLanguage, t } from '../src/i18n'
import { ID } from '../src/i18n/id'
import { sessionText, statusText } from '../src/slash/info'

afterEach(() => setLanguage('id')) // test/setup.ts runs the suite in Indonesian

test('t() fills placeholders, keeps unknown ones, and falls back to the English text', () => {
  setLanguage('en')
  expect(t('Restored: {files}', { files: 'a.txt' })).toBe('Restored: a.txt')
  expect(t('Restored: {files}')).toBe('Restored: {files}')
  expect(t('Restored: {files}', { other: 'x' })).toBe('Restored: {files}')
  expect(t('A sentence nobody translated.')).toBe('A sentence nobody translated.')
  setLanguage('id')
  expect(t('Restored: {files}', { files: 'a.txt' })).toBe('Dikembalikan: a.txt')
  expect(t('A sentence nobody translated.')).toBe('A sentence nobody translated.')
  expect(locale()).toBe('id-ID')
  setLanguage('en')
  expect(locale()).toBe('en-US')
})

test('language choice: --lang beats BCCLI_LANG beats the config beats English', () => {
  expect(resolveLanguage([], {}, undefined)).toBe('en')
  expect(resolveLanguage([], {}, 'id')).toBe('id')
  expect(resolveLanguage([], { BCCLI_LANG: 'en' }, 'id')).toBe('en')
  expect(resolveLanguage(['--lang', 'id'], { BCCLI_LANG: 'en' }, 'en')).toBe('id')
  expect(resolveLanguage(['--lang=en'], { BCCLI_LANG: 'id' }, 'id')).toBe('en')
  expect(resolveLanguage([], { BCCLI_LANG: 'fr' }, undefined)).toBe('en') // unknown values are ignored
  expect(parseLang('id_ID.UTF-8')).toBe('id')
  expect(parseLang('EN-us')).toBe('en')
  expect(parseLang('')).toBeUndefined()
  expect(langFromArgv(['-p', 'x'])).toBeUndefined()
})

test('--lang is validated and parsed', () => {
  setLanguage('en')
  expect(parseCliArgs(['--lang', 'id']).lang).toBe('id')
  expect(parseCliArgs([]).lang).toBeUndefined()
  expect(() => parseCliArgs(['--lang', 'xx'])).toThrow('--lang must be one of: en, id')
  setLanguage('id')
  expect(() => parseCliArgs(['--lang', 'xx'])).toThrow('--lang harus salah satu dari: en, id')
})

test('the same screens come out in English and in Indonesian', () => {
  const status = { version: '1', modelRef: 'a/b', providerLabel: 'A', mode: 'default', cwd: '/w', mcp: [], usage: { inputTokens: 2000, outputTokens: 10 }, lastInputTokens: 0 }
  setLanguage('en')
  expect(statusText(status)).toContain('Session tokens: 2k in · 10 out')
  expect(helpText()).toContain('Usage:')
  expect(helpText()).toContain('--lang <en|id>')
  expect(t(SLASH_COMMANDS.find((c) => c.name === 'undo')!.description)).toBe('undo the file edits of the last turn')
  expect(sessionText({ file: 'f', started: new Date(Date.UTC(2026, 8, 27, 12)), messages: 3, usage: { inputTokens: 0, outputTokens: 0 }, modelRef: 'm' })).toMatch(/Started: .*2026/)
  setLanguage('id')
  expect(statusText(status)).toContain('Token sesi: 2k masuk · 10 keluar')
  expect(helpText()).toContain('Pemakaian:')
  expect(t(SLASH_COMMANDS.find((c) => c.name === 'undo')!.description)).toBe('batalkan edit file giliran terakhir')
  expect(getLanguage()).toBe('id')
})

// ---- static guards over the source: no untranslated key, no stray Indonesian, no unused translation ----

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(name) && !path.endsWith(join('i18n', 'id.ts')) ? [path] : []
  })
}
const FILES = sourceFiles('src').map((path) => ({ path, text: readFileSync(path, 'utf8') }))
const LITERAL = [String.raw`'(?:[^'\\\n]|\\.)*'`, String.raw`"(?:[^"\\\n]|\\.)*"`, '`(?:[^`\\\\]|\\\\.)*`'].join('|')
const decode = (literal: string): string => new Function(`return ${literal}`)() as string

/** Keys of the form t('...') / t("...") / t(`...`) with a plain string first argument. */
function usedKeys(): { file: string; key: string }[] {
  const out: { file: string; key: string }[] = []
  for (const { path, text } of FILES) {
    for (const m of text.matchAll(new RegExp(String.raw`(?<![\w.$])t\(\s*(${LITERAL})`, 'g'))) {
      if (m[1].startsWith('`') && m[1].includes('${')) continue // interpolated: not a catalog key
      out.push({ file: path, key: decode(m[1]) })
    }
  }
  return out
}

/** Every string literal in the source, decoded, plus every t() key (those can sit inside a template literal). */
function allLiterals(): Set<string> {
  const set = new Set<string>(usedKeys().map((k) => k.key))
  for (const { text } of FILES) for (const m of text.matchAll(new RegExp(LITERAL, 'g'))) if (!m[0].includes('${')) set.add(decode(m[0]))
  return set
}

test('every t("...") key in the code has an Indonesian translation', () => {
  const missing = usedKeys().filter(({ key }) => !(key in ID))
  expect(missing.map((m) => `${m.file}: ${m.key}`)).toEqual([])
})

test('every Indonesian translation is still used by the code (no stale entries)', () => {
  const literals = allLiterals()
  const stale = Object.keys(ID).filter((key) => !literals.has(key))
  expect(stale).toEqual([])
})

test('translations keep the same {placeholders} as their English key', () => {
  const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  const bad = Object.entries(ID).filter(([en, id]) => names(en).join() !== names(id).join())
  expect(bad.map(([en]) => en)).toEqual([])
})

test('the source has no Indonesian text outside i18n/id.ts', () => {
  const INDONESIAN =
    /\b(tidak|belum|sudah|atau|yang|untuk|dengan|dari|gagal|berhasil|ketik|perintah|jawaban|dihapus|tersimpan|kosong|tersedia|harus|dibatalkan|silakan|pesan|sesi|folder ini|baris|langkah|izin|berpikir|antri|jalankan|hanya|mengedit|rencana|ringkasan|keluar|detik|disetujui|sekarang)\b/i
  const found: string[] = []
  for (const { path, text } of FILES) {
    text.split('\n').forEach((line, i) => {
      const code = line.trim().startsWith('//') || line.trim().startsWith('*') || line.trim().startsWith('/*') ? '' : line.replace(/ \/\/ .*$/, '')
      if (INDONESIAN.test(code)) found.push(`${path}:${i + 1}: ${code.trim().slice(0, 90)}`)
    })
  }
  expect(found).toEqual([])
})
