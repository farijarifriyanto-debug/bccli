export interface ProviderPreset {
  id: string
  name: string
  baseURL: string
  apiKeyEnv?: string
  local?: boolean
}

// Verified 2026-09-27 (each /models endpoint answers 200/401 with or without a key).
export const PRESETS: ProviderPreset[] = [
  { id: 'bc-cloud', name: 'BotConnector Cloud', baseURL: 'https://api.botconnector.id/v1', apiKeyEnv: 'BOTCONNECTOR_API_KEY' },
  { id: 'openrouter', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
  { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
  { id: 'gemini', name: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY' },
  { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  { id: 'groq', name: 'Groq', baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY' },
  { id: 'ollama-cloud', name: 'Ollama Cloud', baseURL: 'https://ollama.com/v1', apiKeyEnv: 'OLLAMA_API_KEY' },
  { id: 'ollama', name: 'Ollama lokal', baseURL: 'http://127.0.0.1:11434/v1', local: true },
  { id: 'lmstudio', name: 'LM Studio lokal', baseURL: 'http://127.0.0.1:1234/v1', local: true },
]
