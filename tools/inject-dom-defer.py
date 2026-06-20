"""inject-dom-defer.py
Fix: walkthrough + gamehub IIFEs reference DOM elements that live AFTER the main
<script> tag. Wrap element access in DOMContentLoaded so they run after full parse.
"""
import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('docs/ecosystem-map.html', encoding='utf-8') as f:
    html = f.read()
orig = len(html)
checks = []

def patch(old, new, label):
    global html
    n = html.count(old)
    assert n == 1, f'{label!r}: {n}x\n  {old[:60]!r}'
    html = html.replace(old, new, 1)
    checks.append(label)

# ── 1. Walkthrough IIFE ─────────────────────────────────────────────────────
patch(
    '  document.getElementById(\'wt-next\').onclick=()=>show(cur+1);\n'
    '  document.getElementById(\'wt-prev\').onclick=()=>show(cur-1);\n'
    '  document.getElementById(\'wt-skip\').onclick=close;\n'
    '  document.getElementById(\'wt-bg\').onclick=close;\n'
    '  document.getElementById(\'wt-reopen\').onclick=()=>show(0);\n'
    '  setTimeout(()=>{ if(!localStorage.getItem(\'wt_seen\')) show(0); }, 900);\n'
    '}());',

    '  document.addEventListener(\'DOMContentLoaded\',function(){\n'
    '    document.getElementById(\'wt-next\').onclick=()=>show(cur+1);\n'
    '    document.getElementById(\'wt-prev\').onclick=()=>show(cur-1);\n'
    '    document.getElementById(\'wt-skip\').onclick=close;\n'
    '    document.getElementById(\'wt-bg\').onclick=close;\n'
    '    document.getElementById(\'wt-reopen\').onclick=()=>show(0);\n'
    '    setTimeout(()=>{ if(!localStorage.getItem(\'wt_seen\')) show(0); }, 900);\n'
    '  });\n'
    '}());',
    'JS: walkthrough IIFE → DOMContentLoaded'
)

# ── 2. Gamehub IIFE ─────────────────────────────────────────────────────────
patch(
    '(function(){\n'
    '  const hub=document.getElementById(\'gamehub\');\n'
    '  const gamebtn=document.getElementById(\'gamebtn\');\n'
    '  if(gamebtn) gamebtn.onclick=()=>{ hub.classList.add(\'open\'); ghShowSelect(); };\n'
    '  document.getElementById(\'gh-close\').onclick=()=>hub.classList.remove(\'open\');\n'
    '  hub.addEventListener(\'click\',e=>{ if(e.target===hub) hub.classList.remove(\'open\'); });\n'
    '}());',

    '(function(){\n'
    '  document.addEventListener(\'DOMContentLoaded\',function(){\n'
    '    const hub=document.getElementById(\'gamehub\');\n'
    '    const gamebtn=document.getElementById(\'gamebtn\');\n'
    '    if(gamebtn&&hub) gamebtn.onclick=()=>{ hub.classList.add(\'open\'); ghShowSelect(); };\n'
    '    const ghc=document.getElementById(\'gh-close\');\n'
    '    if(ghc&&hub){ ghc.onclick=()=>hub.classList.remove(\'open\'); }\n'
    '    if(hub) hub.addEventListener(\'click\',e=>{ if(e.target===hub) hub.classList.remove(\'open\'); });\n'
    '  });\n'
    '}());',
    'JS: gamehub IIFE → DOMContentLoaded'
)

with open('docs/ecosystem-map.html', 'w', encoding='utf-8') as f:
    f.write(html)

print(f'Done. {len(html):,} bytes ({len(html)-orig:+,})')
for c in checks: print(f'  OK: {c}')
