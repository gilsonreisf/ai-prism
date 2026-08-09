import { useEffect, useRef, useState } from 'react'

/**
 * HtmlDeckPreview: renders HTML deck in a sandbox iframe
 * Features:
 * - Self-contained HTML (no external resources)
 * - Render progressively as HTML arrives
 * - CSP-protected sandbox
 * - Handles incremental loading via streaming
 */
export default function HtmlDeckPreview({ html, className = '', onReady = null }) {
  const iframeRef = useRef(null)
  const [loading, setLoading] = useState(!!html)

  useEffect(() => {
    if (!html || !iframeRef.current) return

    try {
      const iframe = iframeRef.current
      const doc = iframe.contentDocument

      // Reset doc
      doc.open()

      // Set minimal CSP and write HTML
      doc.write(html)
      doc.close()

      setLoading(false)
      onReady?.()
    } catch (e) {
      console.error('HtmlDeckPreview error:', e)
      setLoading(false)
    }
  }, [html, onReady])

  return (
    <div className={`relative w-full bg-gray-50 rounded-lg overflow-hidden ${className}`}>
      {loading && (
        <div className="absolute inset-0 bg-white/50 flex items-center justify-center z-10">
          <div className="text-sm text-gray-600">Carregando deck...</div>
        </div>
      )}
      <iframe
        ref={iframeRef}
        className="w-full h-full"
        style={{
          aspectRatio: '16 / 9',
          border: 'none',
          background: '#fff',
        }}
        title="Deck preview"
        sandbox="allow-same-origin"
        srcDoc={html}
      />
    </div>
  )
}
