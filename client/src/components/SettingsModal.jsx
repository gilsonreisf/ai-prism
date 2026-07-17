import * as Icon from './Icons.jsx'
import DeckTemplatesSettings from './DeckTemplatesSettings.jsx'
import AdminSettings from './AdminSettings.jsx'

const PERSONAS = [
  { emoji: '🤖', name: 'Padrão', prompt: '' },
  { emoji: '🎯', name: 'Conciso', prompt: 'Responda de forma direta e objetiva. Use listas quando útil. Evite preâmbulos.' },
  { emoji: '👔', name: 'Executivo', prompt: 'Você é um consultor sênior. Foque em impacto de negócio, riscos e recomendações acionáveis, com linguagem executiva.' },
  { emoji: '🧑‍💻', name: 'Engenheiro', prompt: 'Você é um engenheiro de software experiente. Dê respostas técnicas precisas, com exemplos de código bem comentados e boas práticas.' },
  { emoji: '📊', name: 'Analista de dados', prompt: 'Você é um analista de dados. Ao receber dados, identifique tendências, anomalias e gere conclusões acionáveis com clareza.' },
  { emoji: '🎓', name: 'Professor', prompt: 'Explique conceitos de forma didática, passo a passo, com analogias simples e exemplos.' },
]

export default function SettingsModal({
  open,
  onClose,
  systemPrompt,
  setSystemPrompt,
  isAdmin = false,
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl animate-fade-in">
        <div className="flex items-center justify-between px-5 h-14 border-b border-[var(--border)]">
          <h2 className="font-bold flex items-center gap-2">
            <Icon.Settings size={18} /> Configurações da conversa
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]"
          >
            <Icon.Close size={18} />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="text-sm font-semibold">Persona</label>
            <div className="grid grid-cols-3 gap-2 mt-2">
              {PERSONAS.map((p) => {
                const active = (systemPrompt || '') === p.prompt
                return (
                  <button
                    key={p.name}
                    onClick={() => setSystemPrompt(p.prompt)}
                    className={`rounded-xl border p-2.5 text-center transition ${
                      active
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                        : 'border-[var(--border)] hover:bg-[var(--surface-2)]'
                    }`}
                  >
                    <div className="text-xl">{p.emoji}</div>
                    <div className="text-[11px] mt-1 font-medium">{p.name}</div>
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <label className="text-sm font-semibold">Instruções do sistema (system prompt)</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={4}
              placeholder="Ex.: Você é um assistente da minha empresa. Responda sempre em português…"
              className="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm outline-none focus:border-[var(--accent)] resize-none"
            />
          </div>

          <div className="pt-1 border-t border-[var(--border)]" />
          <DeckTemplatesSettings open={open} isAdmin={isAdmin} />
          {isAdmin && (
            <>
              <div className="pt-1 border-t border-[var(--border)]" />
              <AdminSettings open={open} />
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--border)] flex justify-end">
          <button
            onClick={onClose}
            className="rounded-xl bg-[var(--accent)] hover:brightness-110 text-white font-semibold text-sm px-5 py-2"
          >
            Concluído
          </button>
        </div>
      </div>
    </div>
  )
}
