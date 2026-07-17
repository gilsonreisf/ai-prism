import { useState } from 'react'
import * as Icon from '../Icons.jsx'

// The clarifying-questions step of the deck flow (see DECK_POLICY in
// server/blocks.js) — the model authors these fresh for each request, so
// this component only knows how to render whatever shape shows up, never a
// fixed question set. Interactivity is entirely derived from `isLatest`
// (passed down from App.jsx based on the message's position in the list) —
// once a later message exists (the user answered, or is browsing history),
// this renders read-only. No "answered" flag is ever persisted anywhere.
export default function DeckQuestionsBlock({ block, isLatest, onSubmitAnswers }) {
  const [answers, setAnswers] = useState({})
  const [customText, setCustomText] = useState({})
  const [submitted, setSubmitted] = useState(false)

  const questions = block.questions || []
  const interactive = isLatest && !submitted

  const setSingle = (qid, value) => setAnswers((a) => ({ ...a, [qid]: value }))
  const setText = (qid, value) => setAnswers((a) => ({ ...a, [qid]: value }))
  const setCustom = (qid, value) => setCustomText((c) => ({ ...c, [qid]: value }))
  const toggleMulti = (qid, value) =>
    setAnswers((a) => {
      const cur = new Set(a[qid] || [])
      if (cur.has(value)) cur.delete(value)
      else cur.add(value)
      return { ...a, [qid]: Array.from(cur) }
    })

  const submit = () => {
    const lines = questions.map((q) => {
      const custom = (customText[q.id] || '').trim()
      let value
      if (q.type === 'multi') {
        const picked = answers[q.id] || []
        const all = custom ? [...picked, custom] : picked
        value = all.length ? all.join(', ') : '(não especificado)'
      } else if (q.type === 'text') {
        value = (answers[q.id] || '').trim() || '(não especificado)'
      } else {
        value = custom || answers[q.id] || '(não especificado)'
      }
      return `- ${q.label}: ${value}`
    })
    setSubmitted(true)
    onSubmitAnswers?.(`Perguntas respondidas:\n${lines.join('\n')}`)
  }

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4 my-3 space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Icon.Presentation size={16} className="text-[var(--accent)]" />
        <span>{interactive ? 'Perguntas sobre o deck' : 'Perguntas respondidas'}</span>
        {!interactive && <Icon.Check size={14} className="text-[var(--accent)]" />}
      </div>

      {block.intro && <p className="text-sm text-[var(--muted)] -mt-2">{block.intro}</p>}

      <div className="space-y-4">
        {questions.map((q) => (
          <div key={q.id}>
            <div className="text-sm font-medium">{q.label}</div>
            {q.description && <div className="text-xs text-[var(--faint)] mt-0.5">{q.description}</div>}

            {q.type !== 'text' && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {(q.options || []).map((opt) => {
                  // a filled "Outros" wins over the picked chip on single
                  // questions (see submit) — reflect that in the chip state
                  const overridden = q.type === 'single' && (customText[q.id] || '').trim()
                  const active = (q.type === 'multi' ? (answers[q.id] || []).includes(opt) : answers[q.id] === opt) && !overridden
                  return (
                    <button
                      key={opt}
                      type="button"
                      disabled={!interactive}
                      onClick={() => (q.type === 'multi' ? toggleMulti(q.id, opt) : setSingle(q.id, opt))}
                      className={`text-xs rounded-full border px-3 py-1.5 transition disabled:cursor-default ${
                        active
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)] font-medium'
                          : interactive
                          ? 'border-[var(--border)] hover:bg-[var(--surface-3)]'
                          : 'border-[var(--border)] opacity-50'
                      }`}
                    >
                      {opt}
                    </button>
                  )
                })}
              </div>
            )}

            {q.type !== 'text' && interactive && (
              <div className="mt-2 flex items-center gap-1.5">
                <span
                  className={`text-[11px] font-medium rounded-full border px-2 py-0.5 shrink-0 transition ${
                    (customText[q.id] || '').trim()
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                      : 'border-[var(--border)] text-[var(--faint)]'
                  }`}
                >
                  Outros
                </span>
                <input
                  value={customText[q.id] || ''}
                  onChange={(e) => setCustom(q.id, e.target.value)}
                  placeholder={
                    q.type === 'multi' ? 'Acrescente uma opção sua…' : 'Ou escreva sua própria resposta…'
                  }
                  className="flex-1 text-xs rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                />
              </div>
            )}

            {q.type === 'text' && (
              <textarea
                value={answers[q.id] || ''}
                onChange={(e) => setText(q.id, e.target.value)}
                disabled={!interactive}
                rows={2}
                placeholder={interactive ? 'Sua resposta...' : ''}
                className="mt-2 w-full text-sm rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-none disabled:opacity-50"
              />
            )}
          </div>
        ))}
      </div>

      {interactive && (
        <button
          onClick={submit}
          className="w-full flex items-center justify-center gap-2 rounded-xl bg-[var(--accent)] hover:brightness-110 text-white font-semibold text-sm py-2 transition"
        >
          Continuar
        </button>
      )}
    </div>
  )
}
