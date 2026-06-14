const $ = (id) => document.getElementById(id);

function fmt(ms) {
  if (ms == null) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// A relevant emoji for a treat. Stored treats may carry an `emoji`; fall back to a gift.
function treatEmoji(t) {
  return t.emoji || '🎁';
}

// ---- view switching ----
const VIEWS = ['view-treats', 'view-settings', 'view-editor'];
function show(id) {
  for (const v of VIEWS) $(v).hidden = (v !== id);
}

// ---- shared state pulled from the background ----
let treats = [];
// The math-lock config used to GUARD actions (claim treat, save settings, turn off…).
// Pulled from the saved settings so unsaved edits in the form can't weaken the lock.
let mathConfig = window.MathLock.DEFAULT_CONFIG;

async function refreshStatus() {
  const st = await chrome.runtime.sendMessage({ type: 'getStatus' });
  if (!st) return;
  treats = st.treats || [];

  $('usageTime').value = st.usageTime;
  $('breakTime').value = st.breakTime;
  mathConfig = window.MathLock.normalizeConfig(st.mathConfig);
  writeMathForm(mathConfig);

  const offBtn = $('off');
  if (!st.enabled) {
    offBtn.textContent = 'Turn on protection';
    offBtn.dataset.mode = 'on';
    offBtn.classList.add('primary');
    offBtn.classList.remove('ghost');
  } else {
    offBtn.textContent = 'Turn off protection';
    offBtn.dataset.mode = 'off';
    offBtn.classList.add('ghost');
    offBtn.classList.remove('primary');
  }

  const status = $('status');
  status.className = 'status';
  if (!st.enabled) {
    status.classList.add('off');
    status.textContent = 'Protection is OFF.';
  } else if (st.phase === 'resting') {
    status.classList.add('resting');
    status.textContent = `Resting — ${fmt(st.remainingMs)} until ready.`;
  } else if (st.phase === 'watching' && st.remainingMs != null) {
    status.textContent = `Watching — ${fmt(st.remainingMs)} of mind energy left.`;
  } else {
    status.textContent = 'Active. Waiting for a video to play.';
  }

  $('skip').hidden = !(st.enabled && st.phase === 'resting');

  // Treats screen: banked-bonus banner + the grid of tiles. The banner sums the minutes
  // represented by all earned (but not yet spent) treats — these persist across rest
  // cycles and can be spent on the rest screen.
  const bank = $('bank');
  const earned = st.earnedBonuses || {};
  const treatById = Object.fromEntries((st.treats || []).map((t) => [t.id, t]));
  let bonusMin = 0;
  for (const [id, count] of Object.entries(earned)) {
    const t = treatById[id];
    if (t) bonusMin += (Number(t.minutes) || 0) * (Number(count) || 0);
  }
  if (bonusMin > 0) { bank.hidden = false; bank.textContent = `🔋 ${bonusMin} bonus min banked`; }
  else { bank.hidden = true; }

  renderTreats();
}

// ---- treats grid (kid-facing) ----
function renderTreats() {
  const grid = $('treatGrid');
  grid.replaceChildren();
  for (const t of treats) {
    const tile = document.createElement('button');
    tile.className = 'treat';
    tile.innerHTML =
      `<span class="treat-emoji">${treatEmoji(t)}</span>` +
      `<span class="treat-label"></span>` +
      `<span class="treat-min">+${t.minutes} min</span>`;
    tile.querySelector('.treat-label').textContent = t.label;
    tile.addEventListener('click', () => requireMath(async () => {
      await chrome.runtime.sendMessage({ type: 'claimTreat', treatId: t.id });
      flash(`Earned +${t.minutes} min! 🎉`);
    }));
    grid.appendChild(tile);
  }
}

// Brief confirmation toast on the treats screen.
let flashTimer = null;
function flash(text) {
  const bank = $('bank');
  bank.hidden = false;
  bank.textContent = text;
  bank.classList.add('flash');
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { bank.classList.remove('flash'); refreshStatus(); }, 1500);
}

// ---- treat editor (parent-facing) ----
function renderEditor() {
  const wrap = $('editorRows');
  wrap.replaceChildren();
  treats.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'editor-row';
    row.innerHTML =
      `<span class="treat-emoji sm">${treatEmoji(t)}</span>` +
      `<input class="er-label" type="text" maxlength="40">` +
      `<input class="er-min" type="number" min="1" max="600">`;
    row.querySelector('.er-label').value = t.label;
    row.querySelector('.er-min').value = t.minutes;
    row.dataset.idx = i;
    wrap.appendChild(row);
  });
}

function collectEditor() {
  return [...$('editorRows').children].map((row) => {
    const i = Number(row.dataset.idx);
    return {
      ...treats[i],
      label: row.querySelector('.er-label').value.trim() || treats[i].label,
      minutes: Math.max(1, parseInt(row.querySelector('.er-min').value, 10) || 1),
    };
  });
}

// ---- math config form (parent-facing) ----
// Only the range rows for selected operations stay visible/active.
function syncRangeVisibility() {
  const on = new Set([...$('mathOps').querySelectorAll('.chip.on')].map((c) => c.dataset.op));
  for (const row of $('mathRanges').querySelectorAll('.range-row')) {
    row.hidden = !on.has(row.dataset.op);
  }
}

// Reflect a config object onto the chips + per-op range inputs.
function writeMathForm(cfg) {
  for (const chip of $('mathOps').querySelectorAll('.chip')) {
    chip.classList.toggle('on', cfg.operations.includes(chip.dataset.op));
  }
  for (const row of $('mathRanges').querySelectorAll('.range-row')) {
    const r = cfg.ranges[row.dataset.op];
    row.querySelector('.range-min').value = r.min;
    row.querySelector('.range-max').value = r.max;
  }
  syncRangeVisibility();
  refreshExample();
}

// Read the current form into a normalized config.
function readMathForm() {
  const operations = [...$('mathOps').querySelectorAll('.chip.on')].map((c) => c.dataset.op);
  const ranges = {};
  for (const row of $('mathRanges').querySelectorAll('.range-row')) {
    ranges[row.dataset.op] = {
      min: parseInt(row.querySelector('.range-min').value, 10),
      max: parseInt(row.querySelector('.range-max').value, 10),
    };
  }
  return window.MathLock.normalizeConfig({ operations, ranges });
}

// Show a sample problem for the config currently in the form.
function refreshExample() {
  const p = window.MathLock.generateProblem(readMathForm());
  $('mathExample').textContent = `Example: ${p.text} = ?`;
}

$('mathOps').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  // Keep at least one operation selected.
  const on = $('mathOps').querySelectorAll('.chip.on');
  if (chip.classList.contains('on') && on.length === 1) return;
  chip.classList.toggle('on');
  syncRangeVisibility();
  refreshExample();
});
$('mathRanges').addEventListener('input', refreshExample);
$('mathReroll').addEventListener('click', refreshExample);

// ---- math lock ----
const WRONG_WAIT_SECONDS = 15; // forced cool-off after every wrong answer
let pendingAction = null;
let currentAnswer = null;
let lockUntil = 0; // timestamp; while in the future, submissions are blocked

// chrome.storage key holding the current unsolved problem. Persisting it means the
// SAME problem survives cancelling, reopening, and even closing the popup — so a child
// can't cancel-and-retap their way to an easier exercise. Cleared only once solved.
const PENDING_KEY = 'pendingMathProblem';

// Show the unsolved problem: reuse the persisted one if present, otherwise generate a
// fresh problem and persist it. A new problem is therefore minted ONLY when there is no
// outstanding one (i.e. the previous one was solved), never on cancel or wrong answer.
async function loadOrCreateProblem() {
  let prob = null;
  try { prob = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY]; } catch (_) {}
  if (!prob || typeof prob.answer !== 'number' || typeof prob.text !== 'string') {
    const p = window.MathLock.generateProblem(mathConfig);
    prob = { text: p.text, answer: p.answer };
    try { await chrome.storage.local.set({ [PENDING_KEY]: prob }); } catch (_) {}
  }
  currentAnswer = prob.answer;
  $('problem').textContent = prob.text + ' = ?';
  $('answer').value = '';
  $('mathError').hidden = true;
}

// Discard the persisted problem so the NEXT lock mints a fresh one. Called only after a
// correct answer.
async function clearPendingProblem() {
  try { await chrome.storage.local.remove(PENDING_KEY); } catch (_) {}
}

async function requireMath(action) {
  pendingAction = action;
  lockUntil = 0;
  const btn = $('mathOk');
  btn.disabled = false;
  btn.textContent = 'Confirm';
  await loadOrCreateProblem();
  $('mathModal').hidden = false;
  $('answer').focus();
}

$('mathOk').addEventListener('click', async () => {
  // Inside the forced cool-off: ignore submissions entirely.
  if (Date.now() < lockUntil) return;

  // Ignore empty input: it's neither right nor a real attempt, so don't penalize it.
  if ($('answer').value.trim() === '') return;

  if (Number($('answer').value) === currentAnswer) {
    $('mathModal').hidden = true;
    await clearPendingProblem(); // solved — the next lock mints a fresh problem
    const action = pendingAction;
    pendingAction = null;
    if (action) await action();
    await refreshStatus();
    return;
  }

  // Wrong: keep the SAME problem and force a 30s wait before the next attempt.
  $('answer').value = '';
  $('mathError').hidden = false;
  lockUntil = Date.now() + WRONG_WAIT_SECONDS * 1000;
  const btn = $('mathOk');
  btn.disabled = true;
  const tick = () => {
    const left = Math.ceil((lockUntil - Date.now()) / 1000);
    if (left > 0) {
      btn.textContent = `Wait ${left}s`;
      setTimeout(tick, 250);
    } else {
      btn.disabled = false;
      btn.textContent = 'Confirm';
      $('answer').focus();
    }
  };
  tick();
});
$('answer').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('mathOk').click(); });
$('mathCancel').addEventListener('click', () => { $('mathModal').hidden = true; pendingAction = null; });

// ---- navigation ----
$('toSettings').addEventListener('click', () => show('view-settings'));
$('settingsBack').addEventListener('click', () => show('view-treats'));
$('toEditor').addEventListener('click', () => { renderEditor(); show('view-editor'); });
$('editorBack').addEventListener('click', () => show('view-settings'));

// ---- settings actions ----
$('save').addEventListener('click', () => requireMath(async () => {
  await chrome.runtime.sendMessage({
    type: 'saveSettings',
    settings: {
      usageTime: Math.max(1, parseFloat($('usageTime').value) || 1),
      breakTime: Math.max(1, parseFloat($('breakTime').value) || 1),
      mathConfig: readMathForm(),
    },
  });
}));

$('off').addEventListener('click', async () => {
  if ($('off').dataset.mode === 'on') {
    // Turning protection ON is harmless — no math required.
    await chrome.runtime.sendMessage({ type: 'turnOn' });
    await refreshStatus();
  } else {
    requireMath(async () => { await chrome.runtime.sendMessage({ type: 'turnOff' }); });
  }
});

$('skip').addEventListener('click', () => requireMath(async () => {
  await chrome.runtime.sendMessage({ type: 'skipBreak' });
}));

// ---- editor save (math-locked) ----
$('saveTreats').addEventListener('click', () => requireMath(async () => {
  const next = collectEditor();
  await chrome.runtime.sendMessage({ type: 'saveTreats', treats: next });
  treats = next;
  renderTreats();
  show('view-treats');
}));

refreshStatus();
