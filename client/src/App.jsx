import { useEffect, useRef, useState, useCallback } from 'react'
import Sidebar from './components/Sidebar.jsx'
import Composer from './components/Composer.jsx'
import Message from './components/Message.jsx'
import Welcome from './components/Welcome.jsx'
import SessionSkeleton from './components/SessionSkeleton.jsx'
import ModelPicker from './components/ModelPicker.jsx'
import ToolsPicker from './components/ToolsPicker.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import VoiceOverlay from './components/VoiceOverlay.jsx'
import HistoryPage from './components/HistoryPage.jsx'
import DeckStudio from './components/DeckStudio.jsx'
import SpreadsheetStudio from './components/SpreadsheetStudio.jsx'
import * as Icon from './components/Icons.jsx'
import { getJSON, patchJSON, postJSON, del, streamChat, streamContinue, streamRegenerate } from './api.js'
import { speak, plainForSpeech } from './lib/speech.js'
import { parseHash, pushHash, replaceHash } from './lib/hashRouter.js'

export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem('prism-theme') || 'dark')
  const [email, setEmail] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [models, setModels] = useState([])
  const [supportedExt, setSupportedExt] = useState([])
  const [sessions, setSessions] = useState([])
  const [currentId, setCurrentId] = useState(null)
  const [messages, setMessages] = useState([])
  const [model, setModel] = useState(localStorage.getItem('prism-model') || '')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [enabledTools, setEnabledTools] = useState([{ kind: 'genie-one' }])
  const [input, setInput] = useState('')
  const [files, setFiles] = useState([])
  const [streaming, setStreaming] = useState(false)
  const [loadingSession, setLoadingSession] = useState(false)
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [deletingId, setDeletingId] = useState(null)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [manualSidebarCollapsed, setManualSidebarCollapsed] = useState(
    () => localStorage.getItem('prism-sidebar-collapsed') === '1'
  )
  const [view, setView] = useState('chat') // 'chat' | 'history'
  const [deckStudioId, setDeckStudioId] = useState(null)
  const [spreadsheetStudioId, setSpreadsheetStudioId] = useState(null)
  // focus mode: while a deck is open the chat shrinks to a narrow side column
  // and the Studio takes the rest of the row (Claude Design-style split);
  // toggleable from the Studio header, remembered across sessions
  const [deckFocus, setDeckFocus] = useState(() => localStorage.getItem('prism-deck-focus') !== '0')
  // auto-collapses when a deck panel opens (mirrors Claude's artifact layout)
  // but stays re-openable: expanding the rail while the Studio is up clears
  // only this flag, never the user's persisted manual preference. Closing the
  // deck falls back to whatever they'd set before.
  const [deckAutoCollapsed, setDeckAutoCollapsed] = useState(false)
  useEffect(() => {
    setDeckAutoCollapsed(!!deckStudioId)
  }, [deckStudioId])
  const sidebarCollapsed = manualSidebarCollapsed || deckAutoCollapsed
  const toggleSidebarCollapse = () => {
    if (sidebarCollapsed) {
      setManualSidebarCollapsed(false)
      setDeckAutoCollapsed(false)
    } else if (deckStudioId) {
      setDeckAutoCollapsed(true)
    } else {
      setManualSidebarCollapsed(true)
    }
  }
  const [toasts, setToasts] = useState([])
  const [searchResults, setSearchResults] = useState(null)
  const [searching, setSearching] = useState(false)

  const abortRef = useRef(null)
  const scrollRef = useRef(null)
  // whether new streaming output should keep the view pinned to the bottom —
  // owned by the user's scroll position, not by the arrival of tokens
  const stickToBottomRef = useRef(true)

  // Small, corner-anchored toast stack — errors are informative, not blocking,
  // so they must never sit on top of the composer or require a click to go
  // away. Each toast auto-dismisses; multiple errors stack instead of
  // clobbering each other.
  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])
  const pushToast = useCallback(
    (message) => {
      if (!message) return
      const id = `${Date.now()}-${Math.random()}`
      setToasts((prev) => [...prev, { id, message }])
      setTimeout(() => dismissToast(id), 6000)
    },
    [dismissToast]
  )

  // theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('prism-theme', theme)
  }, [theme])

  useEffect(() => {
    if (model) localStorage.setItem('prism-model', model)
  }, [model])

  useEffect(() => {
    localStorage.setItem('prism-sidebar-collapsed', manualSidebarCollapsed ? '1' : '0')
  }, [manualSidebarCollapsed])

  useEffect(() => {
    localStorage.setItem('prism-deck-focus', deckFocus ? '1' : '0')
  }, [deckFocus])

  // bootstrap
  useEffect(() => {
    ;(async () => {
      try {
        const me = await getJSON('/api/me')
        setEmail(me.email)
        setIsAdmin(!!me.isAdmin)
        const m = await getJSON('/api/models')
        setModels(m.models)
        setSupportedExt(m.supported_extensions)
        // a saved preference can point at an endpoint that no longer exists in
        // the catalog (ids change as models are updated) — drop it so the UI
        // doesn't sit on a phantom id (which would silently fall back to
        // MODELS[0] server-side on every turn)
        setModel((prev) => (prev && m.models.some((x) => x.id === prev) ? prev : m.models[0]?.id))
        const list = await loadSessions()
        // apply a deep-linked hash (#/history or #/chat/<id>) once sessions
        // are known — `list` is passed explicitly since `sessions` state
        // wouldn't be updated yet within this same closure invocation
        const { view: v, sessionId } = parseHash()
        if (v === 'history') setView('history')
        else if (sessionId) await loadSession(sessionId, list)
      } catch (e) {
        pushToast(e.message)
      } finally {
        setSessionsLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadSessions = useCallback(async () => {
    try {
      const r = await getJSON('/api/sessions')
      setSessions(r.sessions)
      return r.sessions
    } catch (e) {
      pushToast(e.message)
      return []
    }
  }, [])

  // handles browser back/forward — always re-registered with fresh closures
  // via a ref so it never acts on stale `sessions`/`currentId`/`streaming`
  const popHandlerRef = useRef(() => {})
  useEffect(() => {
    const handler = () => popHandlerRef.current()
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  // "Stick to bottom" driven by user intent, not by content: a scroll
  // listener releases the auto-follow the moment the user moves away from the
  // bottom and re-engages it when they come back. The jump itself is instant
  // (never smooth) — a smooth animation still in flight drags the view down
  // WHILE the user is wheeling up, re-sticking them against their will.
  const STICK_TO_BOTTOM_THRESHOLD = 120
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      stickToBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_THRESHOLD
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [view])
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  // pure state transitions — no URL side effects, safe to call from the
  // popstate handler (which must never push a *new* history entry back)
  const resetToNewChat = () => {
    if (streaming) return
    setCurrentId(null)
    setMessages([])
    setSystemPrompt('')
    setEnabledTools([{ kind: 'genie-one' }])
    setInput('')
    setFiles([])
    setSidebarOpen(false)
    setView('chat')
  }

  const loadSession = async (id, sessionsOverride) => {
    if (streaming || loadingSession) return
    setSidebarOpen(false)
    setView('chat')
    if (id === currentId) return
    setCurrentId(id)
    setMessages([])
    setLoadingSession(true)
    try {
      const r = await getJSON(`/api/sessions/${id}/messages`)
      stickToBottomRef.current = true // a freshly opened session starts at its tail
      setMessages(r.messages)
      const s = (sessionsOverride || sessions).find((x) => x.id === id)
      if (s) {
        setModel(s.model)
        setSystemPrompt(s.system_prompt || '')
        setEnabledTools(s.enabled_tools || [])
      }
    } catch (e) {
      pushToast(e.message)
    } finally {
      setLoadingSession(false)
    }
  }

  // navigating wrappers — used by explicit user actions (sidebar, history
  // page); these push a URL so the browser's back/forward buttons work
  const newChat = () => {
    if (streaming) return
    resetToNewChat()
    pushHash('#/chat')
  }

  const openSession = async (id) => {
    if (streaming || loadingSession) return
    await loadSession(id)
    pushHash('#/chat/' + id)
  }

  const openHistory = () => {
    setView('history')
    pushHash('#/history')
  }

  const closeHistory = () => {
    setView('chat')
    pushHash(currentId ? '#/chat/' + currentId : '#/chat')
  }

  popHandlerRef.current = () => {
    const { view: v, sessionId } = parseHash()
    if (v === 'history') setView('history')
    else if (sessionId) loadSession(sessionId)
    else resetToNewChat()
  }

  const removeSession = async (id) => {
    setDeletingId(id)
    try {
      await del(`/api/sessions/${id}`)
      if (id === currentId) newChat()
      setSessions((prev) => prev.filter((s) => s.id !== id))
    } catch (e) {
      pushToast(e.message)
    } finally {
      setDeletingId(null)
    }
  }

  const renameSession = async (id, title) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)))
    try {
      await patchJSON(`/api/sessions/${id}`, { title })
    } catch (e) {
      pushToast(e.message)
    }
  }

  const doSearch = useCallback(async (q) => {
    if (!q) {
      setSearchResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    try {
      const r = await getJSON(`/api/search?q=${encodeURIComponent(q)}`)
      setSearchResults(r.results)
    } catch (e) {
      pushToast(e.message)
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }, [])

  const onChangeModel = async (id) => {
    setModel(id)
    if (currentId) {
      try {
        await patchJSON(`/api/sessions/${currentId}`, { model: id })
      } catch {}
    }
  }

  const onChangeTools = async (tools) => {
    setEnabledTools(tools)
    if (currentId) {
      try {
        await patchJSON(`/api/sessions/${currentId}`, { enabled_tools: tools })
      } catch {}
    }
  }

  // core: send a turn, stream the answer, resolve with final text (for voice)
  const sendMessage = useCallback(
    async (text, fileList = [], opts = {}) => {
      const prompt = (text || '').trim()
      if ((!prompt && fileList.length === 0) || streaming) return ''

      const userMsg = {
        role: 'user',
        content: prompt,
        attachments: fileList.length ? JSON.stringify(fileList.map((f) => f.name)) : null,
      }
      const asstMsg = { role: 'assistant', content: '', model, streaming: true }
      // sending a message is an explicit "take me to the conversation tail"
      stickToBottomRef.current = true
      setMessages((prev) => [...prev, userMsg, asstMsg])
      setInput('')
      setFiles([])
      setStreaming(true)

      const fd = new FormData()
      fd.append(
        'payload',
        JSON.stringify({ sessionId: currentId, model, systemPrompt, prompt, enabledTools })
      )
      for (const f of fileList) fd.append('files', f)

      const ctrl = new AbortController()
      abortRef.current = ctrl
      let acc = ''
      let createdId = null

      try {
        await streamChat(
          fd,
          (ev) => {
            if (ev.type === 'meta') {
              createdId = ev.sessionId
              if (ev.isNew) {
                setCurrentId(ev.sessionId)
                // gives the freshly-created session a URL without adding a
                // back-button entry — the user didn't "navigate" here, the
                // page they're already looking at just now has an id
                replaceHash('#/chat/' + ev.sessionId)
              }
            } else if (ev.type === 'token') {
              acc += ev.value
              setMessages((prev) => {
                const next = [...prev]
                next[next.length - 1] = { ...next[next.length - 1], content: acc }
                return next
              })
            } else if (ev.type === 'usage') {
              setMessages((prev) => {
                const next = [...prev]
                next[next.length - 1] = {
                  ...next[next.length - 1],
                  prompt_tokens: ev.usage.prompt_tokens,
                  completion_tokens: ev.usage.completion_tokens,
                }
                return next
              })
            } else if (ev.type === 'tool_call') {
              // mirrors the server: an inline {{toolcall:ID}} marker placed in
              // content right now (not just a separate toolCalls array) is
              // what lets the chip render inline, at this exact point in the
              // narrative, instead of grouped before the whole answer
              acc += `\n\n{{toolcall:${ev.id}}}\n\n`
              setMessages((prev) => {
                const next = [...prev]
                const last = next[next.length - 1]
                const toolCalls = [
                  ...(last.toolCalls || []),
                  { id: ev.id, name: ev.name, label: ev.label, args: ev.args, status: 'running' },
                ]
                next[next.length - 1] = { ...last, toolCalls, content: acc }
                return next
              })
            } else if (ev.type === 'tool_result') {
              setMessages((prev) => {
                const next = [...prev]
                const last = next[next.length - 1]
                const toolCalls = (last.toolCalls || []).map((tc) =>
                  tc.id === ev.id ? { ...tc, status: ev.status, result: ev.result, durationMs: ev.durationMs } : tc
                )
                next[next.length - 1] = { ...last, toolCalls }
                return next
              })
            } else if (ev.type === 'blocks') {
              // backend swaps the raw ```prism-block fences for {{block:N}}
              // placeholders in `content` — replace wholesale so it matches
              // exactly what gets persisted/reloaded from the session
              acc = ev.content
              setMessages((prev) => {
                const next = [...prev]
                next[next.length - 1] = { ...next[next.length - 1], content: ev.content, blocks: ev.blocks }
                return next
              })
              // this event only fires right when a message finishes streaming
              // (never on session reload), so opening the Studio here is the
              // "watch the deck get built" moment the user asked for
              const freshDeck = ev.blocks.find((b) => b.type === 'deck' && b.deckId)
              if (freshDeck) setDeckStudioId(freshDeck.deckId)
            } else if (ev.type === 'title') {
              setSessions((prev) =>
                prev.map((s) => (s.id === ev.sessionId ? { ...s, title: ev.title } : s))
              )
            } else if (ev.type === 'error') {
              pushToast(ev.error)
              acc += (acc ? '\n\n' : '') + `⚠️ ${ev.error}`
              setMessages((prev) => {
                const next = [...prev]
                next[next.length - 1] = { ...next[next.length - 1], content: acc }
                return next
              })
            }
          },
          ctrl.signal
        )
      } catch (e) {
        if (e.name !== 'AbortError') pushToast(e.message)
      } finally {
        setMessages((prev) => {
          const next = [...prev]
          next[next.length - 1] = { ...next[next.length - 1], streaming: false }
          return next
        })
        setStreaming(false)
        abortRef.current = null
        await loadSessions()
        if (createdId) setCurrentId((c) => c || createdId)
        // reload the thread so the just-streamed user + assistant rows pick up
        // their server-assigned ids (and blocks/tool_calls/variants). Without
        // this, the locally-appended messages have no id, so a later edit/
        // regenerate would POST to /messages/undefined/* — the server then
        // queries `WHERE id = 'undefined'` and Postgres throws
        // "invalid input syntax for type bigint". Mirrors regenerateMessage.
        const reloadId = createdId || currentId
        if (reloadId) {
          try {
            const r = await getJSON(`/api/sessions/${reloadId}/messages`)
            setMessages(r.messages)
          } catch {}
        }
      }
      return acc
    },
    [currentId, model, systemPrompt, enabledTools, streaming, loadSessions]
  )

  // Regenerates one assistant turn in place: the slot keeps its position in
  // the thread, the old answer becomes a browsable version instead of being
  // discarded, and a follow-up reload picks up the server-assigned id +
  // full variants list (simpler and less error-prone than reconstructing it
  // client-side from SSE events alone).
  const regenerateMessage = useCallback(
    async (messageId) => {
      if (streaming || !currentId) return
      const exists = messages.some((m) => m.id === messageId)
      if (!exists) return

      const setTarget = (patch) =>
        setMessages((prev) => {
          const i = prev.findIndex((m) => m.id === messageId)
          if (i === -1) return prev
          const next = [...prev]
          next[i] = typeof patch === 'function' ? patch(next[i]) : { ...next[i], ...patch }
          return next
        })

      setTarget({ content: '', blocks: undefined, toolCalls: undefined, streaming: true })
      setStreaming(true)

      const ctrl = new AbortController()
      abortRef.current = ctrl
      let acc = ''

      try {
        await streamRegenerate(
          currentId,
          messageId,
          { model, systemPrompt, enabledTools },
          (ev) => {
            if (ev.type === 'token') {
              acc += ev.value
              setTarget({ content: acc })
            } else if (ev.type === 'usage') {
              setTarget({ prompt_tokens: ev.usage.prompt_tokens, completion_tokens: ev.usage.completion_tokens })
            } else if (ev.type === 'tool_call') {
              acc += `\n\n{{toolcall:${ev.id}}}\n\n`
              setTarget((m) => ({
                ...m,
                content: acc,
                toolCalls: [...(m.toolCalls || []), { id: ev.id, name: ev.name, label: ev.label, args: ev.args, status: 'running' }],
              }))
            } else if (ev.type === 'tool_result') {
              setTarget((m) => ({
                ...m,
                toolCalls: (m.toolCalls || []).map((tc) =>
                  tc.id === ev.id ? { ...tc, status: ev.status, result: ev.result, durationMs: ev.durationMs } : tc
                ),
              }))
            } else if (ev.type === 'blocks') {
              acc = ev.content
              setTarget({ content: ev.content, blocks: ev.blocks })
              const freshDeck = ev.blocks.find((b) => b.type === 'deck' && b.deckId)
              if (freshDeck) setDeckStudioId(freshDeck.deckId)
            } else if (ev.type === 'error') {
              pushToast(ev.error)
              acc += (acc ? '\n\n' : '') + `⚠️ ${ev.error}`
              setTarget({ content: acc })
            }
          },
          ctrl.signal
        )
      } catch (e) {
        if (e.name !== 'AbortError') pushToast(e.message)
      } finally {
        setStreaming(false)
        abortRef.current = null
        try {
          const r = await getJSON(`/api/sessions/${currentId}/messages`)
          setMessages(r.messages)
        } catch (e) {
          pushToast(e.message)
        }
      }
    },
    [currentId, model, systemPrompt, enabledTools, streaming, messages, pushToast]
  )

  // Recovery for a session that ends on an unanswered user message (server
  // crashed / token expired mid-turn, so the assistant reply was never
  // created). There's no assistant bubble to regenerate, so this appends a
  // fresh streaming one and asks the server to produce the missing reply.
  const continueMessage = useCallback(async () => {
    if (streaming || !currentId) return
    const asstMsg = { role: 'assistant', content: '', model, streaming: true }
    stickToBottomRef.current = true
    setMessages((prev) => [...prev, asstMsg])
    setStreaming(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl
    let acc = ''
    const setLast = (patch) =>
      setMessages((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        next[next.length - 1] = typeof patch === 'function' ? patch(last) : { ...last, ...patch }
        return next
      })

    try {
      await streamContinue(
        currentId,
        { model, systemPrompt, enabledTools },
        (ev) => {
          if (ev.type === 'token') {
            acc += ev.value
            setLast({ content: acc })
          } else if (ev.type === 'usage') {
            setLast({ prompt_tokens: ev.usage.prompt_tokens, completion_tokens: ev.usage.completion_tokens })
          } else if (ev.type === 'tool_call') {
            acc += `\n\n{{toolcall:${ev.id}}}\n\n`
            setLast((m) => ({
              ...m,
              content: acc,
              toolCalls: [...(m.toolCalls || []), { id: ev.id, name: ev.name, label: ev.label, args: ev.args, status: 'running' }],
            }))
          } else if (ev.type === 'tool_result') {
            setLast((m) => ({
              ...m,
              toolCalls: (m.toolCalls || []).map((tc) =>
                tc.id === ev.id ? { ...tc, status: ev.status, result: ev.result, durationMs: ev.durationMs } : tc
              ),
            }))
          } else if (ev.type === 'blocks') {
            acc = ev.content
            setLast({ content: ev.content, blocks: ev.blocks })
            const freshDeck = ev.blocks.find((b) => b.type === 'deck' && b.deckId)
            if (freshDeck) setDeckStudioId(freshDeck.deckId)
          } else if (ev.type === 'error') {
            pushToast(ev.error)
            acc += (acc ? '\n\n' : '') + `⚠️ ${ev.error}`
            setLast({ content: acc })
          }
        },
        ctrl.signal
      )
    } catch (e) {
      if (e.name !== 'AbortError') pushToast(e.message)
    } finally {
      setStreaming(false)
      abortRef.current = null
      try {
        const r = await getJSON(`/api/sessions/${currentId}/messages`)
        setMessages(r.messages)
      } catch (e) {
        pushToast(e.message)
      }
    }
  }, [currentId, model, systemPrompt, enabledTools, streaming, pushToast])

  // Browses to a stored variant without regenerating — persists the choice
  // server-side so it's what a new message (or a session reload) continues from.
  const switchVariant = useCallback(
    async (messageId, targetId) => {
      if (streaming) return
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === messageId)
        if (i === -1) return prev
        const variant = prev[i].variants?.find((v) => v.id === targetId)
        if (!variant) return prev
        const next = [...prev]
        next[i] = { ...variant, variants: prev[i].variants }
        return next
      })
      try {
        await patchJSON(`/api/messages/${targetId}/activate`, {})
      } catch (e) {
        pushToast(e.message)
      }
    },
    [streaming, pushToast]
  )

  // Edits a previously-sent prompt, then regenerates whatever assistant reply
  // followed it — the regenerate call's own refetch picks up both the edited
  // prompt's variants and the new answer in one go.
  const editUserMessage = useCallback(
    async (messageId, newText) => {
      if (streaming || !currentId || messageId == null) return
      const idx = messages.findIndex((m) => m.id === messageId)
      if (idx === -1) return
      const nextMsg = messages[idx + 1]

      try {
        const r = await postJSON(`/api/sessions/${currentId}/messages/${messageId}/edit`, { content: newText })
        setMessages((prev) => {
          const next = [...prev]
          const i = next.findIndex((m) => m.id === messageId)
          if (i !== -1) next[i] = { ...next[i], id: r.id, content: newText }
          return next
        })
        if (nextMsg?.role === 'assistant') await regenerateMessage(nextMsg.id)
      } catch (e) {
        pushToast(e.message)
      }
    },
    [currentId, streaming, messages, pushToast, regenerateMessage]
  )

  const stop = () => {
    abortRef.current?.abort()
    setStreaming(false)
  }

  const speakText = (t) => speak(plainForSpeech(t), { lang: 'pt-BR' })

  const currentTitle = sessions.find((s) => s.id === currentId)?.title

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        open={sidebarOpen}
        email={email}
        sessions={sessions}
        sessionsLoading={sessionsLoading}
        currentId={currentId}
        onNew={newChat}
        onSelect={openSession}
        onDelete={removeSession}
        deletingId={deletingId}
        onRename={renameSession}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onClose={() => setSidebarOpen(false)}
        onOpenHistory={openHistory}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebarCollapse}
        // expanded studio leaves only a narrow chat column — expanding the
        // sidebar there overlays the chat instead of squeezing it further;
        // with the studio in normal (split) mode it opens in-flow and the
        // chat simply shrinks
        overlay={!!deckStudioId && deckFocus}
      />

      {view === 'history' ? (
        <HistoryPage
          sessions={sessions}
          sessionsLoading={sessionsLoading}
          currentId={currentId}
          onSelect={openSession}
          onNew={newChat}
          onDelete={removeSession}
          deletingId={deletingId}
          onRename={renameSession}
          onBack={closeHistory}
          onSearch={doSearch}
          searchResults={searchResults}
          searching={searching}
        />
      ) : (
      <main
        className={`flex-1 flex flex-col min-w-0 ${
          // focus mode: the chat column scales with the window (32%) instead
          // of a fixed 380px, so the composer isn't cramped on big screens
          deckStudioId && deckFocus ? 'md:flex-none md:w-[clamp(400px,32%,560px)] md:border-r md:border-[var(--border)]' : ''
        }`}
      >
        {/* top bar */}
        {/* relative z-40: backdrop-blur makes this header a stacking context;
            without an explicit z-index the ToolsPicker dropdown inside it gets
            painted UNDER later DOM siblings (messages, Deck Studio) */}
        <header className="relative z-40 h-14 shrink-0 flex items-center gap-3 px-3 md:px-5 border-b border-[var(--border)] bg-[var(--bg)]/80 backdrop-blur">
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]"
          >
            <Icon.Menu size={20} />
          </button>
          <ModelPicker models={models} value={model} onChange={onChangeModel} disabled={streaming} />
          <ToolsPicker
            modelSupportsTools={models.find((m) => m.id === model)?.tools !== false}
            enabledTools={enabledTools}
            onChange={onChangeTools}
            disabled={streaming}
          />
          {/* absolutely centered on the header (= visual center of the chat
              column) — as a flex child it would center in the leftover space
              right of the pickers and sit visibly off-center */}
          <div
            className={`absolute left-1/2 -translate-x-1/2 max-w-[36%] text-sm font-medium truncate text-[var(--muted)] pointer-events-none hidden ${
              deckStudioId && deckFocus ? '' : 'md:block'
            }`}
          >
            {currentTitle || ''}
          </div>
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] ml-auto"
            title="Configurações"
          >
            <Icon.Settings size={19} />
          </button>
        </header>

        {/* messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {loadingSession ? (
            <SessionSkeleton />
          ) : messages.length === 0 ? (
            <Welcome />
          ) : (
            <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
              {messages.map((m, i) => (
                <Message
                  key={i}
                  msg={m}
                  models={models}
                  streaming={m.streaming}
                  onSpeak={speakText}
                  canRegenerate={!streaming && m.role === 'assistant'}
                  onRegenerate={() => regenerateMessage(m.id)}
                  onSwitchVariant={(targetId) => switchVariant(m.id, targetId)}
                  onEditUser={(messageId, newText) => editUserMessage(messageId, newText)}
                  onOpenDeck={(deckId) => setDeckStudioId(deckId)}
                  onOpenSpreadsheet={(id) => setSpreadsheetStudioId(id)}
                  isLatest={i === messages.length - 1 && !streaming}
                  onSubmitAnswers={(text) => sendMessage(text, [])}
                />
              ))}
              {/* Recovery: the thread ends on a user message with no assistant
                  reply (server crashed / token expired mid-generation). There's
                  no assistant bubble to regenerate, so offer to produce the
                  missing answer instead of leaving the user stuck. */}
              {!streaming && messages[messages.length - 1]?.role === 'user' && (
                <div className="flex flex-col items-center gap-2 py-2 text-center animate-fade-in">
                  <p className="text-sm text-[var(--muted)]">
                    Esta mensagem ficou sem resposta — a geração foi interrompida.
                  </p>
                  <button
                    onClick={continueMessage}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--accent)] text-white text-sm font-semibold hover:brightness-110 transition"
                  >
                    <Icon.Regenerate size={15} /> Gerar resposta
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* composer */}
        <div className="shrink-0 pb-2">
          <div className="max-w-3xl mx-auto">
            <Composer
              value={input}
              onChange={setInput}
              onSend={(t, f) => sendMessage(t, f)}
              onStop={stop}
              streaming={streaming}
              files={files}
              setFiles={setFiles}
              supportedExt={supportedExt}
              onOpenVoice={() => setVoiceOpen(true)}
            />
          </div>
        </div>
      </main>
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        systemPrompt={systemPrompt}
        setSystemPrompt={setSystemPrompt}
        isAdmin={isAdmin}
      />

      <VoiceOverlay
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        onSend={(t) => sendMessage(t, [], { viaVoice: true })}
      />

      <DeckStudio
        open={!!deckStudioId}
        deckId={deckStudioId}
        onClose={() => setDeckStudioId(null)}
        pushToast={pushToast}
        focus={deckFocus}
        onToggleFocus={() => setDeckFocus((f) => !f)}
      />

      <SpreadsheetStudio
        open={!!spreadsheetStudioId}
        spreadsheetId={spreadsheetStudioId}
        onClose={() => setSpreadsheetStudioId(null)}
        pushToast={pushToast}
        models={models}
        model={model}
      />

      {toasts.length > 0 && (
        <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 w-[min(22rem,calc(100vw-2rem))]">
          {toasts.map((t) => (
            <div
              key={t.id}
              className="flex items-start gap-2 rounded-xl bg-[var(--surface-3)] border border-[var(--border)] px-3.5 py-3 text-sm shadow-xl shadow-black/20 animate-slide-in-right"
            >
              <Icon.AlertTriangle size={16} className="shrink-0 mt-0.5 text-[var(--accent)]" />
              <span className="flex-1 min-w-0 break-words text-[var(--text)]">{t.message}</span>
              <button
                onClick={() => dismissToast(t.id)}
                className="shrink-0 p-0.5 rounded-md text-[var(--faint)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition"
                title="Dispensar"
              >
                <Icon.Close size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
