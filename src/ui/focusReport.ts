// Terminals with focus reporting on send ESC[I / ESC[O when the window gains/loses focus; Ink strips the ESC, leaving "[I" / "[O".
export const isFocusReport = (input: string): boolean => input === '[I' || input === '[O'
