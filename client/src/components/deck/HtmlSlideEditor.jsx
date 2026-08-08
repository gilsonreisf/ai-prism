import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { buildDeckTokenStyle } from './HtmlSlideFrame.jsx'

// Editable variant of HtmlSlideFrame (task #28 — manual HTML editing, Claude
// Design parity). The sandboxed slide iframe becomes DIRECTLY editable: the DOM
// IS the model. We inject a tiny runtime into the srcDoc that
//   • reports the clicked node (a stable child-index path + a style snapshot),
//   • draws a selection ring over it,
//   • applies inline-style / text patches from the parent live, and
//   • serializes the CLEAN <section> back after every edit.
// Communication is postMessage (the frame is a unique sandbox origin). This is
// the same "edit inline style/attrs of the node you clicked" model Claude Design
// uses — no separate semantic tree, the rendered HTML is the source of truth.
//
// Kept separate from HtmlSlideFrame (which stays a dumb, pointer-inert renderer
// used for thumbnails and off-screen export) so the read-only path carries zero
// editing risk.

const STAGE_W = 1280
const STAGE_H = 720

// The in-iframe runtime, serialized into the srcDoc. Pure vanilla JS; talks to
// the parent only through postMessage with a `prism` discriminator. It never
// leaves marker attributes in the serialized HTML (the selection ring is an
// overlay appended to <body>, outside the <section> we serialize).
const RUNTIME = `
<script>
(function () {
  var ACCENT = getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#2D7FF9';
  var root = document.querySelector('section');
  var overlay = null, hoverBox = null, selectedEl = null, editingEl = null;
  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = '__prism_sel';
    overlay.style.cssText = 'position:absolute;pointer-events:none;z-index:2147483646;border:2px solid ' + ACCENT.trim() + ';border-radius:3px;box-shadow:0 0 0 1px rgba(255,255,255,.5);display:none;';
    document.body.appendChild(overlay);
    hoverBox = document.createElement('div');
    hoverBox.id = '__prism_hover';
    hoverBox.style.cssText = 'position:absolute;pointer-events:none;z-index:2147483645;border:1.5px dashed ' + ACCENT.trim() + '99;border-radius:3px;display:none;';
    document.body.appendChild(hoverBox);
  }
  // element-only child index path from the section root, e.g. "1.0.2"
  function pathOf(el) {
    var parts = [];
    while (el && el !== root) {
      var p = el.parentNode;
      if (!p) break;
      var i = 0, n = p.firstElementChild;
      while (n && n !== el) { i++; n = n.nextElementSibling; }
      parts.unshift(i);
      el = p;
    }
    return parts.join('.');
  }
  function nodeAt(path) {
    if (path === '' || path == null) return root;
    var el = root;
    var parts = String(path).split('.');
    for (var k = 0; k < parts.length; k++) {
      if (!el) return null;
      el = el.children[parseInt(parts[k], 10)];
    }
    return el || null;
  }
  // does this element hold its OWN text (no element children with text)? — those
  // are the leaves the text editor targets.
  function isTextLeaf(el) {
    if (!el) return false;
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i];
      if (c.nodeType === 1) return false; // has an element child
    }
    return (el.textContent || '').trim().length > 0;
  }
  function px(v) { v = parseFloat(v); return isFinite(v) ? Math.round(v * 10) / 10 : 0; }
  function snapshot(el) {
    var cs = getComputedStyle(el);
    var st = el.style;
    return {
      tag: el.tagName.toLowerCase(),
      textLeaf: isTextLeaf(el),
      text: isTextLeaf(el) ? el.textContent : '',
      // computed values give the effective look; inline flags tell the panel
      // which props are explicitly overridden on THIS node.
      computed: {
        fontSize: px(cs.fontSize),
        color: cs.color,
        fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle,
        textAlign: cs.textAlign,
        letterSpacing: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing),
        lineHeight: cs.lineHeight === 'normal' ? '' : (Math.round((parseFloat(cs.lineHeight) / parseFloat(cs.fontSize)) * 100) / 100 || ''),
        textTransform: cs.textTransform,
        backgroundColor: cs.backgroundColor,
        opacity: cs.opacity,
        borderRadius: px(cs.borderTopLeftRadius),
        paddingTop: px(cs.paddingTop),
        paddingRight: px(cs.paddingRight),
        paddingBottom: px(cs.paddingBottom),
        paddingLeft: px(cs.paddingLeft),
      },
      inline: {
        fontSize: !!st.fontSize, color: !!st.color, fontWeight: !!st.fontWeight,
        fontStyle: !!st.fontStyle, textAlign: !!st.textAlign, letterSpacing: !!st.letterSpacing,
        lineHeight: !!st.lineHeight, textTransform: !!st.textTransform,
        background: !!(st.background || st.backgroundColor), opacity: !!st.opacity,
        borderRadius: !!st.borderRadius, padding: !!(st.padding || st.paddingTop),
      },
    };
  }
  function positionOverlay(box, el) {
    if (!el || el === root) { box.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = (r.left + window.scrollX) + 'px';
    box.style.top = (r.top + window.scrollY) + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  }
  function reselect() { if (selectedEl) positionOverlay(overlay, selectedEl); }
  function send(msg) { msg.prism = true; parent.postMessage(msg, '*'); }
  function serialize() {
    var clone = root.cloneNode(true);
    clone.querySelectorAll('[contenteditable]').forEach(function (n) { n.removeAttribute('contenteditable'); });
    send({ kind: 'html', html: clone.outerHTML });
  }
  function selectEl(el, opts) {
    opts = opts || {};
    if (editingEl && editingEl !== el) stopEditing();
    selectedEl = el;
    ensureOverlay();
    positionOverlay(overlay, el);
    if (!opts.silent) send({ kind: 'select', path: pathOf(el), info: snapshot(el) });
  }
  function stopEditing() {
    if (!editingEl) return;
    editingEl.removeAttribute('contenteditable');
    var was = editingEl; editingEl = null;
    serialize();
    if (selectedEl === was) send({ kind: 'select', path: pathOf(was), info: snapshot(was) });
  }
  function startEditing(el) {
    if (!isTextLeaf(el)) return;
    editingEl = el;
    el.setAttribute('contenteditable', 'true');
    el.focus();
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  }
  document.addEventListener('click', function (e) {
    var el = e.target;
    if (el === document.body || el === document.documentElement) { clearSel(); return; }
    if (el === editingEl) return;
    e.preventDefault(); e.stopPropagation();
    selectEl(el);
  }, true);
  document.addEventListener('dblclick', function (e) {
    var el = e.target;
    if (!isTextLeaf(el)) return;
    e.preventDefault(); e.stopPropagation();
    selectEl(el, { silent: true });
    startEditing(el);
  }, true);
  document.addEventListener('mouseover', function (e) {
    var el = e.target;
    if (!el || el === document.body || el === selectedEl || el === editingEl) { if (hoverBox) hoverBox.style.display = 'none'; return; }
    ensureOverlay(); positionOverlay(hoverBox, el);
  }, true);
  document.addEventListener('mouseout', function () { if (hoverBox) hoverBox.style.display = 'none'; }, true);
  document.addEventListener('blur', function (e) { if (e.target === editingEl) stopEditing(); }, true);
  document.addEventListener('keydown', function (e) {
    if (editingEl && (e.key === 'Escape')) { e.preventDefault(); stopEditing(); }
  }, true);
  function clearSel() { selectedEl = null; if (overlay) overlay.style.display = 'none'; send({ kind: 'deselect' }); }
  window.addEventListener('resize', reselect);
  window.addEventListener('message', function (e) {
    var m = e.data || {};
    if (!m.prism) return;
    if (m.kind === 'select') { var el = nodeAt(m.path); if (el) selectEl(el); }
    else if (m.kind === 'clear') { clearSel(); }
    else if (m.kind === 'applyStyle') {
      var el = nodeAt(m.path); if (!el) return;
      for (var k in m.style) {
        if (m.style[k] === null || m.style[k] === '') el.style.removeProperty(k.replace(/[A-Z]/g, function (c){return '-'+c.toLowerCase();}));
        else el.style[k] = m.style[k];
      }
      reselect(); serialize();
      send({ kind: 'select', path: pathOf(el), info: snapshot(el) });
    }
    else if (m.kind === 'setText') {
      var t = nodeAt(m.path); if (!t) return;
      t.textContent = m.text; reselect(); serialize();
    }
  });
  // report readiness so the parent can push an initial selection if needed
  send({ kind: 'ready' });
})();
<\/script>`

function buildEditableSrcDoc(sectionHtml, tokenStyle) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style data-ds-tokens>${tokenStyle}</style>
<style>
  html,body{margin:0;padding:0;width:${STAGE_W}px;height:${STAGE_H}px;overflow:hidden;
    background:var(--background,#fff);font-family:var(--font-body,var(--font-sans,system-ui));
    cursor:default;}
  section.slide,section{box-sizing:border-box;width:${STAGE_W}px;height:${STAGE_H}px;
    position:relative;overflow:hidden;}
  [contenteditable]{outline:none;cursor:text;}
</style>
</head><body>${sectionHtml || ''}${RUNTIME}</body></html>`
}

// forwardRef so the parent inspector can push edits imperatively (applyStyle,
// setText, select, clear) without re-mounting the iframe on every keystroke.
const HtmlSlideEditor = forwardRef(function HtmlSlideEditor(
  { html, template, title = 'slide', className = '', background = '#0e1a1f', onSelect, onDeselect, onChange },
  ref
) {
  const wrapRef = useRef(null)
  const frameRef = useRef(null)
  const [scale, setScale] = useState(0.5)
  const tokenStyle = useMemo(() => buildDeckTokenStyle(template), [template])
  // srcDoc is rebuilt only when the HTML actually changes from OUTSIDE (slide
  // switch, NL edit) — live inline-style edits go through postMessage, so we
  // must not reset the doc on every self-originated change. We track the last
  // html we rendered and the last html we emitted, and skip re-render when they
  // match (an echo of our own edit).
  const lastEmitted = useRef(html)
  const [srcHtml, setSrcHtml] = useState(html)
  useEffect(() => {
    if (html !== lastEmitted.current) {
      setSrcHtml(html)
      lastEmitted.current = html
    }
  }, [html])
  const srcDoc = useMemo(() => buildEditableSrcDoc(srcHtml, tokenStyle), [srcHtml, tokenStyle])

  useEffect(() => {
    if (!wrapRef.current) return
    const el = wrapRef.current
    const update = () => setScale(el.clientWidth / STAGE_W)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const onMsg = (e) => {
      const m = e.data
      if (!m || !m.prism || e.source !== frameRef.current?.contentWindow) return
      if (m.kind === 'select') onSelect?.(m.path, m.info)
      else if (m.kind === 'deselect') onDeselect?.()
      else if (m.kind === 'html') {
        lastEmitted.current = m.html
        onChange?.(m.html)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [onSelect, onDeselect, onChange])

  const post = (msg) => frameRef.current?.contentWindow?.postMessage({ prism: true, ...msg }, '*')
  useImperativeHandle(ref, () => ({
    applyStyle: (path, style) => post({ kind: 'applyStyle', path, style }),
    setText: (path, text) => post({ kind: 'setText', path, text }),
    select: (path) => post({ kind: 'select', path }),
    clear: () => post({ kind: 'clear' }),
  }))

  return (
    <div ref={wrapRef} className={`w-full overflow-hidden ${className}`} style={{ aspectRatio: '16/9', background }}>
      <iframe
        ref={frameRef}
        title={title}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        className="border-0 origin-top-left"
        style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})` }}
      />
    </div>
  )
})

export default HtmlSlideEditor
