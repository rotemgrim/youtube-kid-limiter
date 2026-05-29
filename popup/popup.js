const $ = (id) => document.getElementById(id);

function fmt(ms) {
  if (ms == null) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function refreshStatus() {
  const st = await chrome.runtime.sendMessage({ type: 'getStatus' });
  if (!st) return;
  $('usageTime').value = st.usageTime;
  $('breakTime').value = st.breakTime;
  $('difficulty').value = st.difficulty;

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
}

// ---- math lock ----
let pendingAction = null;
let currentAnswer = null;

function newProblem() {
  const p = window.MathLock.generateProblem($('difficulty').value);
  currentAnswer = p.answer;
  $('problem').textContent = p.text + ' = ?';
  $('answer').value = '';
  $('mathError').hidden = true;
}

function requireMath(action) {
  pendingAction = action;
  newProblem();
  $('mathModal').hidden = false;
  $('answer').focus();
}

$('mathOk').addEventListener('click', async () => {
  if (Number($('answer').value) === currentAnswer) {
    $('mathModal').hidden = true;
    const action = pendingAction;
    pendingAction = null;
    if (action) await action();
    await refreshStatus();
  } else {
    $('mathError').hidden = false;
    newProblem();
  }
});
$('answer').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('mathOk').click(); });
$('mathCancel').addEventListener('click', () => { $('mathModal').hidden = true; pendingAction = null; });

// ---- actions ----
$('save').addEventListener('click', () => requireMath(async () => {
  await chrome.runtime.sendMessage({
    type: 'saveSettings',
    settings: {
      usageTime: Math.max(1, parseFloat($('usageTime').value) || 1),
      breakTime: Math.max(1, parseFloat($('breakTime').value) || 1),
      difficulty: $('difficulty').value,
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

refreshStatus();
