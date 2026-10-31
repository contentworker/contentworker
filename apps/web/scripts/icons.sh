#!/usr/bin/env bash
# Renders the Home Screen and manifest icons in public/ from the favicon's mark: ink on Ledger
# paper, opaque (iOS fills transparency with black). The mark sits inside the central 60%, so the
# same art also works as a maskable icon. Needs rsvg-convert (brew install librsvg).
set -euo pipefail
cd "$(dirname "$0")/../public"
art='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#ffffff"/><g transform="translate(4.8 4.8) scale(0.6)" fill="none" stroke="#0a0a0a" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="3"/><rect x="7.5" y="7.5" width="9" height="3" rx="0.75" fill="#0a0a0a" stroke="none"/><path d="M7.5 14h9"/><path d="M7.5 17h5"/></g></svg>'
for size in 180 192 512; do
  name=$([ "$size" = 180 ] && echo apple-touch-icon.png || echo "icon-$size.png")
  printf '%s' "$art" | rsvg-convert -w "$size" -h "$size" -o "$name"
done
