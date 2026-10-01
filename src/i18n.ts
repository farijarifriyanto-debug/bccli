import { ID } from './i18n/id'

export type Lang = 'en' | 'id'
export const LANGS: readonly Lang[] = ['en', 'id']

let current: Lang = 'en'

export function parseLang(value: string | undefined): Lang | undefined {
  const v = value?.trim().toLowerCase().split(/[-_.]/)[0]
  return (LANGS as readonly string[]).includes(v ?? '') ? (v as Lang) : undefined
}

export function setLanguage(lang: Lang): void {
  current = lang
}

export function getLanguage(): Lang {
  return current
}

/** Locale for dates and numbers, matching the UI language. */
export const locale = (): string => (current === 'id' ? 'id-ID' : 'en-US')

/**
 * User-facing text. The English sentence is the key; Indonesian lives in i18n/id.ts.
 * Placeholders are `{name}`. Text the model reads (tool results, prompts) is plain English and does not go through here.
 */
export function t(en: string, params?: Record<string, string | number>): string {
  const template = current === 'id' ? (ID[en] ?? en) : en
  return params ? template.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match)) : template
}

/** `--lang x` or `--lang=x` from raw argv, so even argument errors can be shown in the right language. */
export function langFromArgv(argv: string[]): Lang | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lang') return parseLang(argv[i + 1])
    if (argv[i].startsWith('--lang=')) return parseLang(argv[i].slice(7))
  }
  return undefined
}

/** --lang, then BCCLI_LANG, then the `language` of the global config, then English. */
export function resolveLanguage(argv: string[], env: NodeJS.ProcessEnv, fromConfig?: string): Lang {
  return langFromArgv(argv) ?? parseLang(env.BCCLI_LANG) ?? parseLang(fromConfig) ?? 'en'
}
