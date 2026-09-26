declare const __VERSION__: string | undefined

export const VERSION: string = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0-dev'
