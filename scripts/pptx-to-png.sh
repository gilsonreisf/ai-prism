#!/bin/bash
# Converts a .pptx into per-slide PNGs (macOS: PowerPoint via AppleScript for
# PDF export, then PyMuPDF for rasterization). Usage: scripts/pptx-to-png.sh file.pptx [dpi]
# PowerPoint's AppleEvent handling is flaky right after force-kills — the
# script launches with explicit delays and a hard timeout, and retries once.
set -euo pipefail
PPTX="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
DPI="${2:-80}"
PDF="${PPTX%.pptx}.pdf"
OUTDIR="${PPTX%.pptx}_png"

# PowerPoint (sandboxed) may lack TCC permission to write into /tmp-style
# paths — the export silently hangs. Round-trip through ~/Documents, which
# it can always write to.
WORK="$HOME/Documents/prism-qa"
mkdir -p "$WORK"
cp "$PPTX" "$WORK/__convert.pptx"

export_pdf() {
  osascript <<EOF
with timeout of 180 seconds
tell application "Microsoft PowerPoint"
  launch
  delay 2
  open POSIX file "$WORK/__convert.pptx"
  delay 2
  set pres to active presentation
  save pres in POSIX file "$WORK/__convert.pdf" as save as PDF
  close pres saving no
end tell
end timeout
EOF
}

if ! export_pdf; then
  echo "retrying after PowerPoint restart..." >&2
  pkill -9 -x "Microsoft PowerPoint" 2>/dev/null || true
  sleep 5
  open -a "Microsoft PowerPoint"
  # 10s settle proved flaky (-1712/-9074 persist); ~25s is reliably enough
  sleep 25
  export_pdf
fi
mv "$WORK/__convert.pdf" "$PDF"
rm -f "$WORK/__convert.pptx"

mkdir -p "$OUTDIR"
python3 - "$PDF" "$OUTDIR" "$DPI" <<'PY'
import sys, fitz
pdf, outdir, dpi = sys.argv[1], sys.argv[2], int(sys.argv[3])
doc = fitz.open(pdf)
for i, page in enumerate(doc):
    page.get_pixmap(dpi=dpi).save(f"{outdir}/slide_{i:02d}.png")
print(f"{len(doc)} slides -> {outdir}")
PY
