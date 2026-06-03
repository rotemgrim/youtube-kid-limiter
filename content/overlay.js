// Renders the brain-energy gauge (watching) and the full-screen rest scene (break).
// Exposes window.__KidLimiter for content.js. Runs in the content-script isolated world.
(function () {
  const GAUGE_ID = 'kidlimiter-gauge';
  const REST_ID = 'kidlimiter-rest';
  const HEADSUP_ID = 'kidlimiter-headsup';
  const WARN_THRESHOLDS = [5 * 60 * 1000, 2 * 60 * 1000]; // 5 min, then 2 min remaining
  const PULSE_BELOW = 2 * 60 * 1000; // pulse the gauge in the final 2 minutes
  let gaugeTimer = null;
  let restTimer = null;
  let headsupGuard = null;
  let readyGuard = null;
  // Where the watched video was paused when the break began. YouTube unloads the
  // player buffer during a long pause (and the SPA may swap the <video>), resetting
  // currentTime to 0 — so we remember the spot and seek back to it on resume.
  let savedPlayback = null;

  // A blobby "mind" shape used for the refilling brain.
  const BRAIN_PATH =
    'M50 12 C30 12 18 24 18 40 C8 44 8 60 20 64 C18 78 34 88 50 84 ' +
    'C66 88 82 78 80 64 C92 60 92 44 82 40 C82 24 70 12 50 12 Z';

  const BRAIN_SVG = `
    <svg class="kl-brain" viewBox="0 0 100 100" width="150" height="150" aria-hidden="true">
      <defs><clipPath id="kl-brain-clip"><path d="${BRAIN_PATH}"/></clipPath></defs>
      <path d="${BRAIN_PATH}" fill="#262b45" stroke="#7c83ff" stroke-width="2.5"/>
      <g clip-path="url(#kl-brain-clip)">
        <rect id="kl-brain-fill" x="0" y="90" width="100" height="0" fill="#46d160"/>
      </g>
      <path d="${BRAIN_PATH}" fill="none" stroke="#9aa0ff" stroke-width="2.5"/>
    </svg>`;

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function fmt(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  function root() {
    return document.body || document.documentElement;
  }

  // ---- background scenes (upscaled Ghibli art in assets/<category>/) ----
  // Counts must match the files shipped in assets/. One is picked at random.
  const SCENE_COUNTS = { night: 10, day: 8, reminder: 6 };

  function sceneUrl(category) {
    const n = SCENE_COUNTS[category];
    if (!n) return null;
    const idx = 1 + Math.floor(Math.random() * n);
    const name = `${category}-${String(idx).padStart(2, '0')}.jpg`;
    try { return chrome.runtime.getURL(`assets/${category}/${name}`); }
    catch (_) { return null; }
  }

  // 6 PM and later -> a sleeping-kid "night" scene; earlier -> a daytime activity.
  function restCategory() {
    return new Date().getHours() >= 18 ? 'night' : 'day';
  }

  // Paint a random scene as a full-bleed background, with a dark scrim on top so
  // the white text and brain stay readable over any image.
  function applyScene(node, category) {
    const url = sceneUrl(category);
    if (!url) return;
    // The base CSS sets `background: <gradient> !important` on these screens, so we
    // must override with !important too (inline !important beats author !important).
    node.style.setProperty('background-image',
      `linear-gradient(rgba(11,10,28,0.55), rgba(11,10,28,0.78)), url("${url}")`,
      'important');
    node.style.setProperty('background-size', 'cover', 'important');
    node.style.setProperty('background-position', 'center', 'important');
    node.style.setProperty('background-repeat', 'no-repeat', 'important');
  }

  // The gauge already renders over fullscreen video; in fullscreen we just move it
  // to the top-right so it doesn't cover YouTube's playback controls.
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function syncFullscreen() {
    const gauge = document.getElementById(GAUGE_ID);
    if (gauge) gauge.classList.toggle('kl-fs', isFullscreen());
  }
  document.addEventListener('fullscreenchange', syncFullscreen);
  document.addEventListener('webkitfullscreenchange', syncFullscreen);

  function pauseAllVideos() {
    document.querySelectorAll('video').forEach((v) => { if (!v.paused) v.pause(); });
  }

  // Remember the current spot of the watched video so we can return to it after the
  // break. Guarded by currentTime > 1 so a video that YouTube already reset to 0
  // (e.g. after a page reload mid-break) never overwrites a good saved position.
  function capturePlayback() {
    const v = mainVideo();
    if (v && v.currentTime > 1) {
      savedPlayback = { src: v.currentSrc || v.src, time: v.currentTime };
    }
  }

  // Resume the watched video, seeking back to the saved spot if YouTube rewound it.
  function resumePlayback() {
    const v = mainVideo();
    if (!v) return;
    if (savedPlayback && (v.currentSrc || v.src) === savedPlayback.src
        && Math.abs(v.currentTime - savedPlayback.time) > 2) {
      try { v.currentTime = savedPlayback.time; } catch (_) {}
    }
    savedPlayback = null;
    v.play().catch(() => {});
  }

  // The video the user is actually watching. Picking by CSS class is unreliable —
  // Shorts preload several <video class="html5-main-video"> elements at once, so
  // querySelector would return a paused, off-screen one. Instead we score every
  // video by (is-playing, is-on-screen, area) and take the best. Works for the watch
  // page, Shorts, and the miniplayer while ignoring tiny/hidden preview elements.
  function mainVideo() {
    const vids = [...document.querySelectorAll('video')];
    if (!vids.length) return null;
    const big = vids.filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width >= 200 && r.height >= 150;
    });
    const cands = big.length ? big : vids;
    const score = (v) => {
      const r = v.getBoundingClientRect();
      const playing = (!v.paused && !v.ended) ? 1 : 0;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const onScreen = (cx >= 0 && cx <= innerWidth && cy >= 0 && cy <= innerHeight) ? 1 : 0;
      return playing * 1e12 + onScreen * 1e9 + r.width * r.height;
    };
    return cands.reduce((best, v) => (score(v) > score(best) ? v : best), cands[0]);
  }

  // True only when the video the user is watching is actually playing. Avoids
  // counting time because a stray/hidden video element reports itself as not-paused.
  function videoIsPlaying() {
    const v = mainVideo();
    return !!(v && !v.paused && !v.ended);
  }

  // Gentle two-note chime synthesized in-page (no bundled audio file needed).
  function playChime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const start = ctx.currentTime + 0.02;
      [880, 660].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t = start + i * 0.18;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(0.15, t + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(t); osc.stop(t + 0.5);
      });
      setTimeout(() => ctx.close().catch(() => {}), 1300);
    } catch (_) {}
  }

  // ---- gauge (watching) ----
  function buildGauge() {
    return el(`
      <div id="${GAUGE_ID}" class="kl-gauge">
        <div class="kl-gauge-brainwrap">
          <svg class="kl-gauge-brain" viewBox="0 0 100 100" width="38" height="38" aria-hidden="true">
            <defs><clipPath id="kl-gauge-clip"><path d="${BRAIN_PATH}"/></clipPath></defs>
            <path d="${BRAIN_PATH}" fill="#262b45" stroke="#7c83ff" stroke-width="2.5"/>
            <g clip-path="url(#kl-gauge-clip)">
              <rect id="kl-gauge-fill" x="0" y="10" width="100" height="80" fill="#46d160"/>
            </g>
            <path d="${BRAIN_PATH}" fill="none" stroke="#9aa0ff" stroke-width="2.5"/>
          </svg>
          <div class="kl-particles"></div>
        </div>
        <div class="kl-gauge-body">
          <div class="kl-gauge-label">Mind energy</div>
          <div class="kl-gauge-time"></div>
        </div>
      </div>`);
  }

  function paintGauge(node, level, leftMs) {
    const rect = node.querySelector('#kl-gauge-fill');
    if (rect) {
      const top = 10, h = 80, fh = level * h;
      rect.setAttribute('y', (top + h - fh).toFixed(1)); // drains from the top down
      rect.setAttribute('height', fh.toFixed(1));
      rect.setAttribute('fill', `hsl(${Math.round(level * 120)}, 80%, 45%)`);
    }
    node.querySelector('.kl-gauge-time').textContent = fmt(leftMs) + ' left';
    node.classList.toggle('kl-warn', leftMs <= PULSE_BELOW);
  }

  // Emit "mind energy" particles leaking out the bottom of the brain.
  function spawnParticles(node, level) {
    const layer = node.querySelector('.kl-particles');
    if (!layer) return;
    const hue = Math.round(level * 120); // matches the fill colour (green -> red)
    const count = level <= 0 ? 0 : (level < 0.3 ? 2 : 1); // leak a bit harder near empty
    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.className = 'kl-particle';
      const size = 2 + Math.random() * 2.5;
      p.style.left = (38 + Math.random() * 24) + '%';
      p.style.width = p.style.height = size.toFixed(1) + 'px';
      p.style.background = `hsl(${hue}, 80%, 50%)`;
      p.style.setProperty('--dx', (Math.random() * 10 - 5).toFixed(0) + 'px');
      layer.appendChild(p);
      setTimeout(() => p.remove(), 950);
    }
  }

  function showGauge(remainingMs, totalMs) {
    removeRest();
    let node = document.getElementById(GAUGE_ID);
    if (!node) { node = buildGauge(); root().appendChild(node); }
    node.classList.toggle('kl-fs', isFullscreen());
    node.querySelector('.kl-gauge-label').textContent = 'Mind energy';
    const endTime = Date.now() + remainingMs;
    if (gaugeTimer) clearInterval(gaugeTimer);
    let prevLeft = null;
    const update = () => {
      // The gauge is authoritative on real playback: usage time must only drain
      // while a video is actually playing. If nothing is playing (e.g. the video
      // stayed paused after a rest ended, or a pause event never reached the
      // background), freeze here and tell the background to stop the clock.
      if (!videoIsPlaying()) {
        chrome.runtime.sendMessage({ type: 'videoPaused' }).catch(() => {});
        showGaugeFrozen(Math.max(0, endTime - Date.now()), totalMs);
        return;
      }
      const left = endTime - Date.now();
      const level = Math.max(0, Math.min(1, left / totalMs));
      paintGauge(node, level, left);
      spawnParticles(node, level);
      // Fire a warning once, on the downward crossing of each threshold.
      if (prevLeft != null) {
        for (const T of WARN_THRESHOLDS) {
          if (T < totalMs && prevLeft > T && left <= T) {
            chrome.runtime.sendMessage({ type: 'maybeWarn', threshold: T }).catch(() => {});
          }
        }
      }
      prevLeft = left;
      if (left <= 0) {
        clearInterval(gaugeTimer); gaugeTimer = null;
        chrome.runtime.sendMessage({ type: 'drainComplete' }).catch(() => {});
      }
    };
    update();
    gaugeTimer = setInterval(update, 250);
  }

  // Paused: keep the gauge on screen but frozen — no countdown, no leaking particles.
  function showGaugeFrozen(remainingMs, totalMs) {
    removeRest();
    let node = document.getElementById(GAUGE_ID);
    if (!node) { node = buildGauge(); root().appendChild(node); }
    node.classList.toggle('kl-fs', isFullscreen());
    if (gaugeTimer) { clearInterval(gaugeTimer); gaugeTimer = null; }
    const level = Math.max(0, Math.min(1, remainingMs / totalMs));
    paintGauge(node, level, remainingMs);
    node.classList.remove('kl-warn'); // no red pulse while paused
    node.querySelector('.kl-gauge-label').textContent = 'Paused';
  }

  function removeGauge() {
    if (gaugeTimer) { clearInterval(gaugeTimer); gaugeTimer = null; }
    document.getElementById(GAUGE_ID)?.remove();
  }

  // ---- rest scene (break) ----
  function buildRest() {
    return el(`
      <div id="${REST_ID}" class="kl-rest">
        <div class="kl-rest-card">
          <div class="kl-brainwrap">${BRAIN_SVG}<div class="kl-brain-pct">0%</div></div>
          <h1 class="kl-title">Time to rest your mind</h1>
          <p class="kl-sub">Good dreams are recharging your brain…</p>
          <div class="kl-count"></div>
          <div class="kl-bonus-tray" hidden>
            <div class="kl-bonus-title">Use an earned bonus to skip the rest</div>
            <div class="kl-bonus-grid"></div>
          </div>
        </div>
      </div>`);
  }

  // Render the row of treat tiles on the rest screen. Earned treats (count > 0) are
  // colored and tappable; unearned treats are grayed out. Tapping spends one earning
  // and ends the rest (background starts a new watch session for that treat's minutes).
  function paintBonusTray(node, treats, earnedBonuses) {
    const tray = node.querySelector('.kl-bonus-tray');
    const grid = node.querySelector('.kl-bonus-grid');
    if (!tray || !grid) return;
    const list = Array.isArray(treats) ? treats : [];
    if (!list.length) { tray.hidden = true; return; }
    tray.hidden = false;
    grid.replaceChildren();
    for (const t of list) {
      const count = (earnedBonuses && earnedBonuses[t.id]) || 0;
      const tile = document.createElement('button');
      tile.className = 'kl-bonus-tile' + (count > 0 ? '' : ' kl-bonus-locked');
      tile.disabled = count <= 0;
      tile.innerHTML =
        `<span class="kl-bonus-emoji">${t.emoji || '🎁'}</span>` +
        `<span class="kl-bonus-label"></span>` +
        `<span class="kl-bonus-min">+${t.minutes} min</span>` +
        (count > 1 ? `<span class="kl-bonus-x">x${count}</span>` : '');
      tile.querySelector('.kl-bonus-label').textContent = t.label;
      if (count > 0) {
        tile.addEventListener('click', () => {
          tile.disabled = true; // prevent double-tap during the transition
          chrome.runtime.sendMessage({ type: 'useTreatOnRest', treatId: t.id }).catch(() => {});
        });
      }
      grid.appendChild(tile);
    }
  }

  function paintRest(node, level, leftMs) {
    const rect = node.querySelector('#kl-brain-fill');
    if (rect) {
      const top = 10, h = 80, fh = level * h;
      rect.setAttribute('y', (top + h - fh).toFixed(1));
      rect.setAttribute('height', fh.toFixed(1));
    }
    node.querySelector('.kl-brain-pct').textContent = Math.round(level * 100) + '%';
    node.querySelector('.kl-count').textContent = fmt(leftMs) + ' until your mind is ready';
  }

  function showRest(remainingMs, totalMs, treats, earnedBonuses) {
    removeGauge();
    capturePlayback(); // remember the spot before we pause it for the break
    pauseAllVideos();
    let node = document.getElementById(REST_ID);
    if (!node) { node = buildRest(); applyScene(node, restCategory()); root().appendChild(node); }
    paintBonusTray(node, treats || [], earnedBonuses || {});
    const endTime = Date.now() + remainingMs;
    if (restTimer) clearInterval(restTimer);
    const update = () => {
      const left = endTime - Date.now();
      // Re-attach if YouTube's SPA (or a tampering kid) removed it, and keep video paused.
      if (!document.getElementById(REST_ID)) root().appendChild(node);
      pauseAllVideos();
      if (left <= 0) {
        clearInterval(restTimer); restTimer = null;
        chrome.runtime.sendMessage({ type: 'restComplete' }).catch(() => {});
        showReady(); // brain full — wait for the kid to click before resuming
        return;
      }
      paintRest(node, Math.max(0, Math.min(1, 1 - left / totalMs)), left);
    };
    update();
    restTimer = setInterval(update, 250);
  }

  function removeRest() {
    if (restTimer) { clearInterval(restTimer); restTimer = null; }
    if (readyGuard) { clearInterval(readyGuard); readyGuard = null; }
    document.getElementById(REST_ID)?.remove();
  }

  // Break is over and the mind is recharged. Show a full brain and a Start button,
  // but DON'T autoplay — keep the video paused until the kid clicks Start.
  function showReady() {
    removeGauge();
    removeHeadsUp();
    if (restTimer) { clearInterval(restTimer); restTimer = null; }
    let node = document.getElementById(REST_ID);
    if (!node) { node = buildRest(); applyScene(node, restCategory()); root().appendChild(node); }

    const rect = node.querySelector('#kl-brain-fill');
    if (rect) { rect.setAttribute('y', '10'); rect.setAttribute('height', '80'); }
    const pct = node.querySelector('.kl-brain-pct');
    if (pct) pct.textContent = '100%';
    node.querySelector('.kl-title').textContent = 'Your mind is recharged!';
    node.querySelector('.kl-sub').textContent = 'Ready to watch again?';

    if (!node.querySelector('#kl-ready-start')) {
      node.querySelector('.kl-count')?.remove();
      const btn = el('<button id="kl-ready-start" class="kl-btn">Start watching</button>');
      node.querySelector('.kl-rest-card').appendChild(btn);
      btn.addEventListener('click', () => {
        if (readyGuard) { clearInterval(readyGuard); readyGuard = null; }
        removeRest();
        resumePlayback(); // seek back to where the break interrupted us
      });
    }

    // Hold the video paused until the user explicitly clicks Start.
    pauseAllVideos();
    if (readyGuard) clearInterval(readyGuard);
    readyGuard = setInterval(() => {
      if (!document.getElementById(REST_ID)) { clearInterval(readyGuard); readyGuard = null; return; }
      pauseAllVideos();
    }, 500);
  }

  // ---- heads-up warning (sleepy brain, pauses the video) ----
  function buildHeadsUp(minutesLeft) {
    const word = minutesLeft === 1 ? 'minute' : 'minutes';
    const node = el(`
      <div id="${HEADSUP_ID}" class="kl-headsup">
        <div class="kl-headsup-card">
          <div class="kl-scene">
            <svg class="kl-brain" viewBox="0 0 100 100" width="150" height="150" aria-hidden="true">
              <defs><clipPath id="kl-hu-clip"><path d="${BRAIN_PATH}"/></clipPath></defs>
              <path d="${BRAIN_PATH}" fill="#262b45" stroke="#7c83ff" stroke-width="2.5"/>
              <g clip-path="url(#kl-hu-clip)">
                <rect x="0" y="58" width="100" height="32" fill="#f0a050"/>
              </g>
              <path d="${BRAIN_PATH}" fill="none" stroke="#9aa0ff" stroke-width="2.5"/>
            </svg>
            <span class="kl-emoji">😴</span>
            <span class="kl-z z1">z</span><span class="kl-z z2">z</span><span class="kl-z z3">z</span>
          </div>
          <h1 class="kl-title">${minutesLeft} ${word} left</h1>
          <p class="kl-sub">Your mind is getting sleepy. Find a good place to stop soon!</p>
          <button id="kl-hu-continue" class="kl-btn">Continue watching</button>
        </div>
      </div>`);
    return node;
  }

  function showHeadsUp(minutesLeft) {
    removeGauge();
    pauseAllVideos();
    removeHeadsUp();
    const node = buildHeadsUp(minutesLeft);
    applyScene(node, 'reminder');
    root().appendChild(node);
    node.querySelector('#kl-hu-continue').addEventListener('click', () => {
      removeHeadsUp();
      const v = mainVideo();
      if (v) v.play().catch(() => {});
    });
    // Keep the video paused (and the screen present) until the kid clicks Continue.
    if (headsupGuard) clearInterval(headsupGuard);
    headsupGuard = setInterval(() => {
      if (!document.getElementById(HEADSUP_ID)) { clearInterval(headsupGuard); headsupGuard = null; return; }
      pauseAllVideos();
    }, 500);
    playChime();
    // Final (2-minute) warning: chime twice, one after the other, for extra nudge.
    if (minutesLeft <= 2) setTimeout(playChime, 700);
  }

  function removeHeadsUp() {
    if (headsupGuard) { clearInterval(headsupGuard); headsupGuard = null; }
    document.getElementById(HEADSUP_ID)?.remove();
  }

  function clearAll() { removeGauge(); removeRest(); removeHeadsUp(); }

  function resume() {
    clearAll();
    resumePlayback(); // seek back to where the break interrupted us
  }

  window.__KidLimiter = { showGauge, showGaugeFrozen, showRest, showReady, showHeadsUp, clearAll, resume };
})();
