import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import * as Icon from './Icons.jsx'
import Logo from './Logo.jsx'
import BlockRenderer from './blocks/BlockRenderer.jsx'
import LoadingChip from './blocks/LoadingChip.jsx'
import { exportMessageToPdf } from '../pdfExport.js'

const MARKER = '\n\n--- ANEXOS ---'
const FENCE_START = '```prism-block'
const PLACEHOLDER_RE = /\{\{(block:\d+|toolcall:[^}]+)\}\}/g

function stripAttachments(content) {
  const i = content.indexOf(MARKER)
  return i >= 0 ? content.slice(0, i) : content
}

// Scans one prose chunk for a still-typing ```prism-block fence (only
// possible while streaming — resolved fences never appear raw, they're
// swapped for a {{block:N}} placeholder in one shot) and emits a loading
// chip in its place instead of the raw, meaningless JSON fence text.
function pushProse(segments, s, streaming) {
  if (!streaming) {
    if (s.trim()) segments.push({ kind: 'md', text: s })
    return
  }
  let i = 0
  while (true) {
    const start = s.indexOf(FENCE_START, i)
    if (start === -1) {
      const tail = s.slice(i)
      if (tail.trim()) segments.push({ kind: 'md', text: tail })
      break
    }
    const before = s.slice(i, start)
    if (before.trim()) segments.push({ kind: 'md', text: before })
    const end = s.indexOf('```', start + FENCE_START.length)
    segments.push({ kind: 'loading' })
    if (end === -1) break // fence still open — model is still typing it
    i = end + 3
  }
}

/**
 * Splits message text into an ordered list of renderable segments — markdown
 * prose, resolved chart/insight blocks, tool-call chips, and (while
 * streaming) loading chips right where the model is mid-way through emitting
 * a ```prism-block fence — so everything lands exactly where it happened in
 * the conversation instead of piling up in separate groups.
 *
 * Both `{{block:N}}` and `{{toolcall:ID}}` are inline position markers the
 * backend writes into `content` (mirrored client-side during live streaming
 * — see the `tool_call` SSE handler in App.jsx) — never shown to the model,
 * purely so this renderer can reconstruct the original order.
 */
function splitSegments(text, blocks, toolCalls, streaming) {
  const segments = []
  let last = 0
  let m
  PLACEHOLDER_RE.lastIndex = 0
  while ((m = PLACEHOLDER_RE.exec(text))) {
    pushProse(segments, text.slice(last, m.index), streaming)
    const [kind, ref] = m[1].split(':')
    if (kind === 'block') {
      const block = blocks?.[Number(ref)]
      if (block) segments.push({ kind: 'block', block })
    } else {
      const tc = toolCalls?.find((t) => String(t.id) === ref)
      if (tc) segments.push({ kind: 'toolcall', tc })
    }
    last = PLACEHOLDER_RE.lastIndex
  }
  pushProse(segments, text.slice(last), streaming)
  return segments
}

// Collapsible trace of one tool call — mirrors the Databricks Playground
// pattern of showing "used tool X" above the answer, expandable to inspect
// exactly what was sent/returned (handy for verifying the model's math).
// Shown while the assistant is streaming but hasn't produced visible text yet —
// i.e. it's "thinking": on the first round the model is reading context and
// deciding whether to call a tool, and between tool rounds it's deciding what
// to do with a result. Without this the UI showed only a bare blinking cursor,
// which reads as a frozen/failed request. Cycles through a few labels so the
// wait feels alive.
const THINKING_LABELS = ['Pensando', 'Analisando o pedido', 'Escolhendo a melhor abordagem', 'Preparando a resposta']
function ThinkingIndicator({ compact = false }) {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (compact) return
    const id = setInterval(() => setI((n) => (n + 1) % THINKING_LABELS.length), 2200)
    return () => clearInterval(id)
  }, [compact])
  return (
    <span className="inline-flex items-center gap-2 text-[var(--muted)] text-sm">
      <span className="inline-flex gap-1" aria-hidden>
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-bounce" style={{ animationDelay: '300ms' }} />
      </span>
      {!compact && <span>{THINKING_LABELS[i]}…</span>}
    </span>
  )
}

function ToolCallChip({ tc }) {
  const [open, setOpen] = useState(false)
  const running = tc.status === 'running'
  const error = tc.status === 'error'
  const isPython = tc.name === 'execute_python'
  const isGenie = tc.name?.startsWith('genie__')
  const isGenieOne = tc.name === 'ask_genie_one'
  const isVectorSearch = tc.name?.startsWith('vs__')
  const isMcpExternal = tc.name?.startsWith('mcpext__')
  const richResult = !isPython
  const code = isPython ? tc.args?.code : null

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] mb-2 overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs"
      >
        <Icon.ChevronRight
          size={13}
          className={`shrink-0 text-[var(--faint)] transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {isPython ? (
          <Icon.Terminal size={14} className="shrink-0" />
        ) : isGenie ? (
          <Icon.GenieSpaces size={16} />
        ) : isGenieOne ? (
          <Icon.GenieOne size={16} />
        ) : isVectorSearch ? (
          <Icon.VectorSearch size={16} />
        ) : isMcpExternal ? (
          <Icon.McpExternal size={16} />
        ) : (
          <Icon.UcFunctions size={16} />
        )}
        <span className="font-semibold flex-1 truncate">{tc.label || tc.name}</span>
        {running && (
          <span className="block w-3 h-3 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin shrink-0" />
        )}
        {!running && error && <Icon.AlertTriangle size={14} className="text-red-400 shrink-0" />}
        {!running && !error && <Icon.Check size={14} className="text-[var(--accent)] shrink-0" />}
        {!running && tc.durationMs != null && (
          <span className="text-[var(--faint)] shrink-0">{(tc.durationMs / 1000).toFixed(1)}s</span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 text-xs">
          {code ? (
            <div className="prose-chat text-xs [&_pre]:my-0">
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {'```python\n' + code + '\n```'}
              </Markdown>
            </div>
          ) : (isGenie || isGenieOne) && tc.args?.question ? (
            // Genie's question is natural language, often long — render it in
            // full as rich text instead of a truncated font-mono key:value line.
            <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] p-2.5">
              <div className="text-[10px] uppercase tracking-wide text-[var(--faint)] mb-1">Pergunta</div>
              <div className="prose-chat text-xs">
                <Markdown remarkPlugins={[remarkGfm]}>{tc.args.question}</Markdown>
              </div>
            </div>
          ) : (
            tc.args &&
            Object.keys(tc.args).length > 0 && (
              <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] p-2.5 space-y-1 font-mono">
                {Object.entries(tc.args).map(([k, v]) => (
                  <div key={k} className="break-words whitespace-pre-wrap">
                    <span className="text-[var(--faint)]">{k}:</span> {String(v)}
                  </div>
                ))}
              </div>
            )
          )}
          {tc.result != null && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--faint)] mb-1">
                {error ? 'Erro' : 'Resultado'}
              </div>
              {richResult && !error ? (
                // These tools answer in markdown (prose, tables, a SQL fence,
                // links) — render it properly instead of dumping raw ** and |
                // characters into a plain <pre> block.
                <div className="prose-chat text-xs rounded-lg bg-[var(--surface)] border border-[var(--border)] p-2.5 overflow-x-auto">
                  <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                    {tc.result}
                  </Markdown>
                </div>
              ) : (
                <pre
                  className={`rounded-lg border p-2.5 overflow-x-auto whitespace-pre-wrap ${
                    error
                      ? 'bg-red-500/10 border-red-500/30 text-red-300'
                      : 'bg-[var(--surface)] border-[var(--border)]'
                  }`}
                >
                  {tc.result}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function fmtCost(c) {
  if (c < 0.01) return '<$0.01'
  return '$' + c.toFixed(c < 1 ? 3 : 2)
}

function CopyBtn({ text, label = 'Copiar' }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1400)
      }}
      className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--faint)] hover:text-[var(--text)] transition"
      title={label}
    >
      {done ? <Icon.Check size={14} /> : <Icon.Copy size={14} />}
    </button>
  )
}

export default function Message({ msg, models, onSpeak, onRegenerate, onSwitchVariant, onEditUser, onOpenDeck, onOpenSpreadsheet, canRegenerate, streaming, isLatest, onSubmitAnswers }) {
  const isUser = msg.role === 'user'
  const text = stripAttachments(msg.content)
  const toolCalls = msg.toolCalls || msg.tool_calls
  const segments = isUser ? [] : splitSegments(text, msg.blocks, toolCalls, streaming)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const exportRef = useRef(null)
  // legacy safety net: messages persisted before {{toolcall:ID}} markers
  // existed have tool calls but no matching marker in their content — show
  // those (only those) the old way, grouped above the answer
  const referencedToolCallIds = new Set(
    segments.filter((s) => s.kind === 'toolcall').map((s) => s.tc.id)
  )
  const unreferencedToolCalls = (toolCalls || []).filter((tc) => !referencedToolCallIds.has(tc.id))
  // for copy/speak: plain prose only, placeholders (and any dangling live
  // fence) stripped since they're not meant to be read/copied literally
  const plainText = text
    .replace(PLACEHOLDER_RE, '')
    .replace(/```prism-block[\s\S]*?(```|$)/g, '')
    .trim()
  let attachments = []
  try {
    if (msg.attachments) attachments = JSON.parse(msg.attachments)
  } catch {}

  const variants = msg.variants
  const variantIndex = variants ? variants.findIndex((v) => v.id === msg.id) : -1
  const hasVariants = variants && variants.length > 1 && variantIndex !== -1

  const meta = models.find((m) => m.id === msg.model)
  const pt = msg.prompt_tokens
  const ct = msg.completion_tokens
  let cost = null
  if (meta && (pt || ct)) {
    cost = ((pt || 0) / 1e6) * meta.in + ((ct || 0) / 1e6) * meta.out
  }

  if (isUser) {
    const commitEdit = () => {
      const trimmed = draft.trim()
      setEditing(false)
      if (trimmed && trimmed !== text) onEditUser(msg.id, trimmed)
      else setDraft(text)
    }

    if (editing) {
      return (
        <div className="flex justify-end animate-fade-in">
          <div className="max-w-[85%] md:max-w-[75%] w-full">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  commitEdit()
                }
                if (e.key === 'Escape') {
                  setEditing(false)
                  setDraft(text)
                }
              }}
              rows={Math.min(10, Math.max(2, draft.split('\n').length))}
              className="w-full rounded-2xl rounded-tr-md bg-[var(--bubble-user)] px-4 py-2.5 text-[0.95rem] leading-relaxed outline-none border border-[var(--accent)] resize-none"
            />
            <div className="flex justify-end gap-2 mt-1.5">
              <button
                onClick={() => {
                  setEditing(false)
                  setDraft(text)
                }}
                className="text-xs px-3 py-1.5 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] transition"
              >
                Cancelar
              </button>
              <button
                onClick={commitEdit}
                className="text-xs px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white font-semibold hover:brightness-110 transition"
              >
                Salvar e regenerar
              </button>
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="flex justify-end items-center gap-1.5 animate-fade-in group/msg">
        {onEditUser && !streaming && (
          <button
            onClick={() => {
              setDraft(text)
              setEditing(true)
            }}
            className="shrink-0 p-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--faint)] hover:text-[var(--text)] opacity-0 group-hover/msg:opacity-100 transition"
            title="Editar"
          >
            <Icon.Pencil size={13} />
          </button>
        )}
        <div className="max-w-[85%] md:max-w-[75%]">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 justify-end mb-1.5">
              {attachments.map((a, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 text-[11px] bg-[var(--surface-3)] text-[var(--muted)] rounded-md px-2 py-1"
                >
                  <Icon.File size={12} /> {a}
                </span>
              ))}
            </div>
          )}
          <div className="rounded-2xl rounded-tr-md bg-[var(--bubble-user)] px-4 py-2.5 text-[0.95rem] leading-relaxed whitespace-pre-wrap">
            {text}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-3 animate-fade-in">
      <div className="shrink-0 mt-0.5 w-8 h-8 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] grid place-items-center text-[var(--text)]">
        <Logo size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div ref={exportRef}>
          {unreferencedToolCalls.length > 0 && (
            <div>
              {unreferencedToolCalls.map((tc, i) => (
                <ToolCallChip key={tc.id || i} tc={tc} />
              ))}
            </div>
          )}
          <div className="prose-chat">
            {segments.length ? (
              segments.map((seg, i) => {
                if (seg.kind === 'md') {
                  return (
                    <Markdown key={i} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                      {seg.text}
                    </Markdown>
                  )
                }
                if (seg.kind === 'block') return <BlockRenderer key={i} blocks={[seg.block]} onOpenDeck={onOpenDeck} onOpenSpreadsheet={onOpenSpreadsheet} isLatest={isLatest} onSubmitAnswers={onSubmitAnswers} />
                if (seg.kind === 'toolcall') return <ToolCallChip key={i} tc={seg.tc} />
                if (seg.kind === 'loading') return <LoadingChip key={i} />
                return null
              })
            ) : streaming ? (
              <ThinkingIndicator />
            ) : null}
            {/* Streaming indicator keyed off the LAST segment, not `text` —
                `text` still contains the {{toolcall:ID}} markers, so it's
                truthy the moment any tool runs and can't distinguish "typing
                prose" from "just finished a tool call". When the trailing
                segment is prose the model is actively writing → a live cursor.
                When it's a tool chip (or there's no segment yet), the model is
                between/after tool rounds deciding what's next → a full thinking
                indicator so the wait never reads as frozen. */}
            {streaming && segments.length > 0 && segments[segments.length - 1].kind === 'md' && (
              <span className="stream-cursor" />
            )}
            {streaming && segments.length > 0 && segments[segments.length - 1].kind !== 'md' && (
              <div className="mt-2"><ThinkingIndicator /></div>
            )}
          </div>
        </div>

        {!streaming && (
          // flex-wrap in two cohesive groups: when the chat column narrows
          // (Studio focus mode) the buttons stay on one line and the
          // model/token/cost info drops to its own line — never overflowing
          <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 mt-2 text-[11px] text-[var(--faint)]">
          <span className="inline-flex items-center gap-1">
            {hasVariants && (
              <span className="inline-flex items-center gap-0.5 mr-0.5">
                <button
                  disabled={variantIndex === 0}
                  onClick={() => onSwitchVariant(variants[variantIndex - 1].id)}
                  className="p-1 rounded-md hover:bg-[var(--surface-3)] hover:text-[var(--text)] disabled:opacity-30 disabled:hover:bg-transparent transition"
                  title="Versão anterior"
                >
                  <Icon.ChevronLeft size={13} />
                </button>
                <span className="tabular-nums px-0.5">
                  {variantIndex + 1}/{variants.length}
                </span>
                <button
                  disabled={variantIndex === variants.length - 1}
                  onClick={() => onSwitchVariant(variants[variantIndex + 1].id)}
                  className="p-1 rounded-md hover:bg-[var(--surface-3)] hover:text-[var(--text)] disabled:opacity-30 disabled:hover:bg-transparent transition"
                  title="Próxima versão"
                >
                  <Icon.ChevronRight size={13} />
                </button>
                <span className="mx-1 w-px h-3 bg-[var(--border)]" />
              </span>
            )}
            <CopyBtn text={plainText} />
            <button
              onClick={() => onSpeak(plainText)}
              className="p-1 rounded-md hover:bg-[var(--surface-3)] hover:text-[var(--text)] transition"
              title="Ouvir resposta"
            >
              <Icon.Speaker size={14} />
            </button>
            <button
              onClick={() => exportMessageToPdf(exportRef.current, 'Resposta — AI Prism')}
              className="p-1 rounded-md hover:bg-[var(--surface-3)] hover:text-[var(--text)] transition"
              title="Exportar como PDF"
            >
              <Icon.FileText size={14} />
            </button>
            {canRegenerate && (
              <button
                onClick={onRegenerate}
                className="p-1 rounded-md hover:bg-[var(--surface-3)] hover:text-[var(--text)] transition"
                title="Regenerar"
              >
                <Icon.Regenerate size={14} />
              </button>
            )}
          </span>
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            {meta && <span className="font-medium text-[var(--muted)]">{meta.label}</span>}
            {(pt || ct) && (
              <span title="Tokens entrada / saída">
                · {pt ?? '–'}↑ {ct ?? '–'}↓
              </span>
            )}
            {cost != null && (
              <span title="Custo estimado (preços de lista públicos)">· ~{fmtCost(cost)}</span>
            )}
          </span>
          </div>
        )}
      </div>
    </div>
  )
}
