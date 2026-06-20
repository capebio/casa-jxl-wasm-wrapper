"""
Round 13: Arcade / Commander-Keen-style sound effects via Web Audio API.
Pure synthesis — square waves, sweeps, white noise. Zero audio files.
"""
import pathlib

HTML = pathlib.Path("docs/ecosystem-map.html")
html = HTML.read_text(encoding="utf-8")

# ─────────────────────────────────────────────────────────────────────────────
# 1. Add mute toggle button to gh-header (right of × close)
# ─────────────────────────────────────────────────────────────────────────────
OLD_GH_HDR = '    <button id="gh-close">\xd7</button>'
NEW_GH_HDR = ('    <button id="gh-mute" title="Toggle sound" '
              'style="background:none;border:none;color:#9aacbf;font-size:18px;'
              'cursor:pointer;padding:4px 8px;line-height:1">\U0001f50a</button>\n'
              + OLD_GH_HDR)
assert OLD_GH_HDR in html, "gh-close not found"
html = html.replace(OLD_GH_HDR, NEW_GH_HDR)

# ─────────────────────────────────────────────────────────────────────────────
# 2. Timer: add tick sound at integer-second boundaries while time ≤ 5
# ─────────────────────────────────────────────────────────────────────────────
OLD_TIMER = (
    '    psS.timeLeft-=0.1;\n'
    '    const pct=Math.max(0,psS.timeLeft/psS.timeLimit*100);\n'
    '    fill.style.width=pct+\'%\';\n'
    '    fill.style.backgroundPosition=(100-pct)+\'%\';\n'
    '    if(psS.timeLeft<=0){ clearInterval(psS.timer); psTimeout(); }'
)
NEW_TIMER = (
    '    const _prev=psS.timeLeft;\n'
    '    psS.timeLeft-=0.1;\n'
    '    const pct=Math.max(0,psS.timeLeft/psS.timeLimit*100);\n'
    '    fill.style.width=pct+\'%\';\n'
    '    fill.style.backgroundPosition=(100-pct)+\'%\';\n'
    '    if(psS.timeLeft<=5 && Math.ceil(psS.timeLeft)!==Math.ceil(_prev)) SFX.tick();\n'
    '    if(psS.timeLeft<=0){ clearInterval(psS.timer); psTimeout(); }'
)
assert OLD_TIMER in html, "timer interval body not found"
html = html.replace(OLD_TIMER, NEW_TIMER)

# ─────────────────────────────────────────────────────────────────────────────
# 3. psGuess — correct branch: correct sound + delayed victory fanfare
# ─────────────────────────────────────────────────────────────────────────────
OLD_GUESS_CORRECT = (
    '    psS.solved=true;\n'
    '    el.classList.add(\'correct\');\n'
    '    const pts=Math.max(10, Math.floor(psS.timeLeft/psS.timeLimit*100)+psS.level*5);\n'
    '    psS.score+=pts;\n'
    '    psShowFeedback(\'✓ Correct! +\'+pts+\' pts\', true);\n'
    '    psShowVictory(pts);\n'
    '    psColorCycle();\n'
    '    psFireConfetti();\n'
    '    setTimeout(()=>{\n'
    '      if(!psS.shh) psS.level++;\n'
    '      psNextRound();\n'
    '    }, 3200);'
)
NEW_GUESS_CORRECT = (
    '    psS.solved=true;\n'
    '    el.classList.add(\'correct\');\n'
    '    const pts=Math.max(10, Math.floor(psS.timeLeft/psS.timeLimit*100)+psS.level*5);\n'
    '    psS.score+=pts;\n'
    '    SFX.correct();\n'
    '    psShowFeedback(\'✓ Correct! +\'+pts+\' pts\', true);\n'
    '    psShowVictory(pts);\n'
    '    psColorCycle();\n'
    '    psFireConfetti();\n'
    '    setTimeout(()=>SFX.victory(), 280);\n'
    '    setTimeout(()=>{\n'
    '      if(!psS.shh) psS.level++;\n'
    '      psNextRound();\n'
    '    }, 3200);'
)
assert OLD_GUESS_CORRECT in html, "psGuess correct branch not found"
html = html.replace(OLD_GUESS_CORRECT, NEW_GUESS_CORRECT)

# ─────────────────────────────────────────────────────────────────────────────
# 4. psGuess — wrong branch: wrong sound + lose-life sound
# ─────────────────────────────────────────────────────────────────────────────
OLD_GUESS_WRONG = (
    '    el.classList.add(\'wrong\');\n'
    '    setTimeout(()=>el.classList.remove(\'wrong\'),500);\n'
    '    corrEl&&corrEl.classList.add(\'correct\');\n'
    '    psS.lives--;\n'
    '    psUpdateLives();\n'
    '    psShowFeedback(\'✗ That was: \'+psS.corruption.stage, false);\n'
    '    if(psS.lives<=0){\n'
    '      setTimeout(psGameOver, 1200);\n'
    '    } else {\n'
    '      setTimeout(()=>{corrEl&&corrEl.classList.remove(\'correct\'); psNextRound();},1500);\n'
    '    }'
)
NEW_GUESS_WRONG = (
    '    el.classList.add(\'wrong\');\n'
    '    SFX.wrong();\n'
    '    setTimeout(()=>el.classList.remove(\'wrong\'),500);\n'
    '    corrEl&&corrEl.classList.add(\'correct\');\n'
    '    psS.lives--;\n'
    '    psUpdateLives();\n'
    '    setTimeout(()=>SFX.loseLife(), 180);\n'
    '    psShowFeedback(\'✗ That was: \'+psS.corruption.stage, false);\n'
    '    if(psS.lives<=0){\n'
      '      setTimeout(psGameOver, 1200);\n'
    '    } else {\n'
    '      setTimeout(()=>{corrEl&&corrEl.classList.remove(\'correct\'); psNextRound();},1500);\n'
    '    }'
)
assert OLD_GUESS_WRONG in html, "psGuess wrong branch not found"
html = html.replace(OLD_GUESS_WRONG, NEW_GUESS_WRONG)

# ─────────────────────────────────────────────────────────────────────────────
# 5. psTimeout — add timeout sound
# ─────────────────────────────────────────────────────────────────────────────
OLD_TIMEOUT = 'function psTimeout(){\n  if(psS.solved) return;'
NEW_TIMEOUT = 'function psTimeout(){\n  if(psS.solved) return;\n  SFX.timeout();'
assert OLD_TIMEOUT in html, "psTimeout not found"
html = html.replace(OLD_TIMEOUT, NEW_TIMEOUT)

# ─────────────────────────────────────────────────────────────────────────────
# 6. psGameOver — add game-over sound
# ─────────────────────────────────────────────────────────────────────────────
OLD_GAMEOVER = 'function psGameOver(){\n  clearInterval(psS.timer);'
NEW_GAMEOVER = 'function psGameOver(){\n  clearInterval(psS.timer);\n  SFX.gameOver();'
assert OLD_GAMEOVER in html, "psGameOver not found"
html = html.replace(OLD_GAMEOVER, NEW_GAMEOVER)

# ─────────────────────────────────────────────────────────────────────────────
# 7. psNextRound — unlock sound when new op banner shows
# ─────────────────────────────────────────────────────────────────────────────
OLD_BANNER = (
    "    const newOp=ops[ops.length-1];\n"
    "    document.getElementById('ps-new-op-desc').textContent='New: '+newOp.label+' — '+newOp.stage;\n"
    "    banner.classList.add('show');\n"
    "    setTimeout(()=>banner.classList.remove('show'),3000);"
)
NEW_BANNER = (
    "    const newOp=ops[ops.length-1];\n"
    "    document.getElementById('ps-new-op-desc').textContent='New: '+newOp.label+' — '+newOp.stage;\n"
    "    banner.classList.add('show');\n"
    "    SFX.unlock();\n"
    "    setTimeout(()=>banner.classList.remove('show'),3000);"
)
assert OLD_BANNER in html, "new-op banner block not found"
html = html.replace(OLD_BANNER, NEW_BANNER)

# ─────────────────────────────────────────────────────────────────────────────
# 8. gh-play-btn / gh-shh-btn clicks — add SFX.click() via onclick attr patch
#    Walkthrough wt-next/prev — add SFX.click() in WALKTHROUGH_JS already
#    injected; patch the onclick handlers
# ─────────────────────────────────────────────────────────────────────────────
html = html.replace(
    "onclick=\"ghStartGame('pixel-surgeon',false)\"",
    "onclick=\"SFX.click();ghStartGame('pixel-surgeon',false)\""
)
html = html.replace(
    "onclick=\"ghStartGame('pixel-surgeon',true)\"",
    "onclick=\"SFX.click();ghStartGame('pixel-surgeon',true)\""
)
# Walkthrough buttons (they're in JS, find and patch)
html = html.replace(
    "document.getElementById('wt-next').onclick=()=>show(cur+1);",
    "document.getElementById('wt-next').onclick=()=>{SFX.click();show(cur+1);};"
)
html = html.replace(
    "document.getElementById('wt-prev').onclick=()=>show(cur-1);",
    "document.getElementById('wt-prev').onclick=()=>{SFX.click();show(cur-1);};"
)
html = html.replace(
    "document.getElementById('wt-skip').onclick=close;",
    "document.getElementById('wt-skip').onclick=()=>{SFX.click();close();};"
)

# ─────────────────────────────────────────────────────────────────────────────
# 9. SFX engine — inject before fit(); draw();
# ─────────────────────────────────────────────────────────────────────────────
SFX_JS = r"""
/* ═══════════════════════════════════════════════════════════
   SFX — Commander Keen / arcade style sounds via Web Audio
   Pure synthesis: square waves, sweeps, white noise. No files.
   ═══════════════════════════════════════════════════════════ */
const SFX = (() => {
  let _ctx = null, _muted = false;
  const ac = () => {
    if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (_ctx.state === 'suspended') _ctx.resume();
    return _ctx;
  };

  /* Single oscillator tone with optional frequency glide */
  const tone = (freq, dur, type='square', vol=0.22, freqEnd=null, delay=0) => {
    if (_muted) return;
    try {
      const c = ac(), t0 = c.currentTime + delay;
      const o = c.createOscillator(), g = c.createGain();
      o.connect(g); g.connect(c.destination);
      o.type = type; o.frequency.value = freq;
      if (freqEnd != null) o.frequency.linearRampToValueAtTime(freqEnd, t0 + dur);
      g.gain.setValueAtTime(0.001, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.start(t0); o.stop(t0 + dur + 0.02);
    } catch(e) {}
  };

  /* White noise burst */
  const noise = (dur, vol=0.12, delay=0) => {
    if (_muted) return;
    try {
      const c = ac(), t0 = c.currentTime + delay;
      const buf = c.createBuffer(1, c.sampleRate * dur | 0, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const s = c.createBufferSource(), g = c.createGain();
      s.buffer = buf; s.connect(g); g.connect(c.destination);
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      s.start(t0); s.stop(t0 + dur + 0.02);
    } catch(e) {}
  };

  /* Sequence helper: [[freq, dur, vol?, freqEnd?], ...] */
  const seq = (notes, gap=0.004) => {
    let t = 0;
    notes.forEach(([f, d, v=0.2, f2=null]) => {
      tone(f, d, 'square', v, f2, t);
      t += d + gap;
    });
  };

  const sfx = {
    /* Short UI blip */
    click:    () => tone(440, 0.04, 'square', 0.12),

    /* Ascending C-E-G-C arpeggio — classic "correct" */
    correct:  () => seq([[262,.07,.18],[330,.07,.18],[392,.07,.18],[523,.14,.24]]),

    /* Victory fanfare — 6-note ascending burst */
    victory:  () => {
      seq([[262,.05,.18],[330,.05,.18],[392,.05,.18],[523,.05,.22],[659,.05,.25],[784,.2,.28]]);
      noise(0.08, 0.07, 0.28);
    },

    /* Descending buzz + noise hit — wrong answer */
    wrong:    () => { tone(280, 0.14, 'square', 0.28, 90); noise(0.12, 0.13); },

    /* Descending 3-note "oof" — lose a life */
    loseLife: () => seq([[320,.1,.22],[220,.1,.22],[140,.22,.2]]),

    /* Descending sweep — time's up */
    timeout:  () => { tone(520, 0.35, 'square', 0.2, 90); noise(0.12, 0.08, 0.1); },

    /* 4-note ascending chime — new op unlocked */
    unlock:   () => seq([[392,.06,.15],[523,.06,.15],[659,.06,.15],[784,.22,.22]]),

    /* Dramatic descend — game over */
    gameOver: () => seq([[280,.16,.22],[230,.16,.22],[185,.16,.22],[140,.32,.26]], 0.01),

    /* Short high blip — timer warning tick */
    tick:     () => tone(880, 0.03, 'square', 0.09),

    /* 5-note level-up jingle */
    levelUp:  () => seq([[392,.07,.18],[523,.07,.2],[659,.07,.22],[784,.07,.25],[1047,.22,.28]]),

    /* Toggle mute; returns new muted state */
    toggleMute() {
      _muted = !_muted;
      const btn = document.getElementById('gh-mute');
      if (btn) btn.textContent = _muted ? '\U0001f507' : '\U0001f50a';
      return _muted;
    },
  };

  /* Wire mute button */
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('gh-mute');
    if (btn) btn.onclick = () => sfx.toggleMute();
  });

  return sfx;
})();
"""

FINAL = '\nfit(); draw();'
assert FINAL in html, "fit(); draw(); not found"
html = html.replace(FINAL, SFX_JS + FINAL, 1)
print("SFX engine injected")

# ─────────────────────────────────────────────────────────────────────────────
# WRITE
# ─────────────────────────────────────────────────────────────────────────────
HTML.write_text(html, encoding="utf-8")
print(f"Done. File size: {len(html):,} chars")
