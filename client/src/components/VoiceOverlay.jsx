import { useEffect, useRef, useState } from 'react'
import * as Icon from './Icons.jsx'
import {
  createRecognizer,
  dictationSupported,
  speak,
  stopSpeaking,
  plainForSpeech,
} from '../lib/speech.js'
import { useT } from '../lib/i18n.jsx'

export default function VoiceOverlay({ open, onClose, onSend }) {
  const t = useT()
  const LABELS = {
    listening: t('voice.listening'),
    thinking: t('voice.thinking'),
    speaking: t('voice.speaking'),
    idle: t('voice.idle'),
  }
  const [status, setStatus] = useState('idle')
  const [transcript, setTranscript] = useState('')
  const [reply, setReply] = useState('')
  const recRef = useRef(null)
  const activeRef = useRef(false)
  const statusRef = useRef('idle')

  const set = (s) => {
    statusRef.current = s
    setStatus(s)
  }

  const startListening = () => {
    if (!activeRef.current) return
    setTranscript('')
    set('listening')
    const rec = createRecognizer({
      lang: 'pt-BR',
      continuous: false,
      interimResults: true,
      onResult: setTranscript,
      onFinal: handleUtterance,
      onEnd: () => {
        if (activeRef.current && statusRef.current === 'listening') startListening()
      },
      onError: () => {},
    })
    if (!rec) return
    recRef.current = rec
    try {
      rec.start()
    } catch {}
  }

  const handleUtterance = async (text) => {
    if (!text || !text.trim() || !activeRef.current) return
    try {
      recRef.current?.stop()
    } catch {}
    set('thinking')
    try {
      const ans = await onSend(text)
      if (!activeRef.current) return
      setReply(ans || '')
      set('speaking')
      speak(plainForSpeech(ans), {
        lang: 'pt-BR',
        onEnd: () => {
          if (activeRef.current) startListening()
        },
      })
    } catch {
      if (activeRef.current) startListening()
    }
  }

  useEffect(() => {
    if (open) {
      activeRef.current = true
      setReply('')
      setTranscript('')
      startListening()
    } else {
      activeRef.current = false
      try {
        recRef.current?.stop()
      } catch {}
      stopSpeaking()
      set('idle')
    }
    return () => {
      activeRef.current = false
      try {
        recRef.current?.stop()
      } catch {}
      stopSpeaking()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const ring =
    status === 'speaking'
      ? 'from-blue-500 via-emerald-400 to-lava'
      : status === 'thinking'
        ? 'from-amber-400 to-lava'
        : 'from-lava to-orange-400'

  return (
    <div className="fixed inset-0 z-50 bg-[var(--bg)]/95 backdrop-blur-xl flex flex-col items-center justify-center">
      <button
        onClick={onClose}
        className="absolute top-5 right-5 p-2.5 rounded-full hover:bg-[var(--surface-3)] text-[var(--muted)]"
      >
        <Icon.Close size={22} />
      </button>

      {!dictationSupported && (
        <p className="text-[var(--muted)] mb-6 max-w-sm text-center px-6">
          {t('voice.unsupported')}
        </p>
      )}

      <div className="relative grid place-items-center mb-10">
        <div
          className={`absolute w-56 h-56 rounded-full bg-gradient-to-br ${ring} opacity-20 blur-2xl ${
            status !== 'idle' ? 'animate-pulse' : ''
          }`}
        />
        <div
          className={`w-40 h-40 rounded-full bg-gradient-to-br ${ring} grid place-items-center shadow-2xl transition-transform ${
            status === 'listening' ? 'scale-105' : 'scale-100'
          }`}
        >
          <div className="w-[150px] h-[150px] rounded-full bg-[var(--bg)]/70 backdrop-blur grid place-items-center text-white">
            <Icon.Waveform size={44} />
          </div>
        </div>
      </div>

      <div className="text-lg font-semibold mb-2">{LABELS[status]}</div>
      <div className="min-h-[3rem] max-w-lg text-center px-6 text-[var(--muted)]">
        {status === 'listening' && transcript}
        {status === 'speaking' && <span className="text-[var(--text)]">{reply.slice(0, 240)}</span>}
      </div>

      <div className="flex items-center gap-3 mt-8">
        <button
          onClick={() => {
            stopSpeaking()
            startListening()
          }}
          className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] px-5 py-2.5 text-sm font-medium"
        >
          <Icon.Mic size={16} /> {t('voice.speakAgain')}
        </button>
        <button
          onClick={onClose}
          className="flex items-center gap-2 rounded-full bg-[var(--accent)] hover:brightness-110 text-white px-5 py-2.5 text-sm font-semibold"
        >
          {t('voice.end')}
        </button>
      </div>
      <p className="absolute bottom-5 text-[11px] text-[var(--faint)]">
        {t('voice.footer')}
      </p>
    </div>
  )
}
