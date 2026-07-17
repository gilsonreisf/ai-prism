// Thin wrappers around the browser Web Speech API for dictation (speech->text)
// and TTS (text->speech). Works in Chrome/Edge; degrades gracefully elsewhere.

const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)

export const dictationSupported = !!SR
export const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window

/**
 * Create a speech recognizer.
 * @param {object} opts { lang, continuous, interimResults, onResult, onFinal, onEnd, onError }
 *   onResult(text) — running transcript (interim + final)
 *   onFinal(text)  — a finalized utterance
 */
export function createRecognizer(opts = {}) {
  if (!SR) return null
  const rec = new SR()
  rec.lang = opts.lang || 'pt-BR'
  rec.continuous = opts.continuous ?? true
  rec.interimResults = opts.interimResults ?? true

  rec.onresult = (e) => {
    let interim = ''
    let final = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript
      if (e.results[i].isFinal) final += t
      else interim += t
    }
    if (final && opts.onFinal) opts.onFinal(final.trim())
    if (opts.onResult) opts.onResult((final + interim).trim())
  }
  rec.onend = () => opts.onEnd && opts.onEnd()
  rec.onerror = (e) => opts.onError && opts.onError(e)
  return rec
}

let currentUtterance = null

export function speak(text, opts = {}) {
  if (!ttsSupported || !text) return
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = opts.lang || 'pt-BR'
  u.rate = opts.rate || 1.02
  u.pitch = opts.pitch || 1.0

  // prefer a voice matching the language
  const voices = window.speechSynthesis.getVoices()
  const match = voices.find((v) => v.lang === u.lang) || voices.find((v) => v.lang?.startsWith(u.lang.slice(0, 2)))
  if (match) u.voice = match

  if (opts.onStart) u.onstart = opts.onStart
  if (opts.onEnd) u.onend = opts.onEnd
  currentUtterance = u
  window.speechSynthesis.speak(u)
}

export function stopSpeaking() {
  if (ttsSupported) window.speechSynthesis.cancel()
  currentUtterance = null
}

// Strip markdown so TTS reads naturally.
export function plainForSpeech(md) {
  return (md || '')
    .replace(/```[\s\S]*?```/g, ' bloco de código. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>~|]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
