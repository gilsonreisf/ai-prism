import { useCallback, useState } from 'react'

// Shared image-attachment state for the AI tweak prompts (Deck + Spreadsheet
// studios). Mirrors the Composer's paste-to-attach behavior, but keeps images
// as base64 data URLs so they ride along in the tweak endpoint's JSON body
// (those endpoints are plain JSON, not multipart) and reach the model as vision
// input via attachImagesToLastUserTurn on the server.
//
// Each image is { id, name, dataUrl }. Non-image clipboard content is ignored
// (left to the input's default paste). A modest cap keeps the request bounded.
const MAX_IMAGES = 4
const MAX_BYTES = 6 * 1024 * 1024 // ~6MB/image — matches the media request ceiling
const RASTER_MAX = 1024 // longest side of a rasterized SVG (keeps the PNG small)

function readAsDataUrl(file) {
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : null)
    r.onerror = () => resolve(null)
    r.readAsDataURL(file)
  })
}

// The gateway's vision API only accepts raster image data URLs — an
// `image/svg+xml` payload is rejected ("Invalid data URL ... base64 image").
// Rasterize an SVG data URL to a PNG data URL via an offscreen canvas, on a
// white ground (SVGs are usually transparent). Returns null if the SVG can't be
// decoded (caller then drops the attachment rather than sending a bad URL).
function rasterizeSvg(svgDataUrl) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, RASTER_MAX / Math.max(img.width || RASTER_MAX, img.height || RASTER_MAX, 1))
        const w = Math.max(1, Math.round((img.width || RASTER_MAX) * scale))
        const h = Math.max(1, Math.round((img.height || RASTER_MAX) * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/png'))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = svgDataUrl
  })
}

export function usePromptImages() {
  const [images, setImages] = useState([])

  const addFiles = useCallback(async (list) => {
    const files = Array.from(list || []).filter((f) => (f.type || '').startsWith('image/') && f.size <= MAX_BYTES)
    if (!files.length) return
    const read = await Promise.all(
      files.map(async (f) => {
        let dataUrl = await readAsDataUrl(f)
        if (!dataUrl) return null
        // the model's vision API rejects SVG — rasterize to PNG before attaching
        if (/^data:image\/svg\+xml/i.test(dataUrl)) {
          dataUrl = await rasterizeSvg(dataUrl)
          if (!dataUrl) return null
        }
        return { id: `${f.name}:${f.size}:${Math.random().toString(36).slice(2, 8)}`, name: f.name || 'imagem.png', dataUrl }
      }),
    )
    setImages((prev) => [...prev, ...read.filter(Boolean)].slice(0, MAX_IMAGES))
  }, [])

  // Paste-to-attach: pull image file items off the clipboard. Returns true when
  // it consumed images (caller should preventDefault so the binary isn't also
  // dropped as text into the prompt box).
  const onPaste = useCallback(
    (e) => {
      const items = e.clipboardData?.items
      if (!items) return false
      const files = []
      for (const it of items) {
        if (it.kind === 'file' && (it.type || '').startsWith('image/')) {
          const blob = it.getAsFile()
          if (blob) files.push(blob)
        }
      }
      if (!files.length) return false
      e.preventDefault()
      addFiles(files)
      return true
    },
    [addFiles],
  )

  const removeAt = useCallback((id) => setImages((prev) => prev.filter((im) => im.id !== id)), [])
  const clear = useCallback(() => setImages([]), [])

  return { images, addFiles, onPaste, removeAt, clear }
}
