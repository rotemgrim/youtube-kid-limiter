// Background service worker: owns the watch/rest cycle, time-keeping and alarms.
// Usage time only counts while a video is actually playing. Rest counts on wall-clock.

const ALARMS = { DRAIN: 'drainDone', REST: 'restDone' };

const SETTING_DEFAULTS = { usageTime: 20, breakTime: 10, difficulty: 'medium', enabled: true };
const RUNTIME_DEFAULTS = { phase: 'idle', accumulatedUsed: 0, lastPlayStart: null, restStart: null, restTabId: null, warned: [] };

const minToMs = (m) => m * 60 * 1000;

chrome.runtime.onInstalled.addListener(async () => {
  const all = { ...SETTING_DEFAULTS, ...RUNTIME_DEFAULTS };
  const cur = await chrome.storage.local.get(Object.keys(all));
  const toSet = {};
  for (const [k, v] of Object.entries(all)) if (cur[k] === undefined) toSet[k] = v;
  if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
  await refreshBadge();
});

const getState = () => chrome.storage.local.get(null);

// ---- toolbar badge: shows OFF when disabled, REST during a break, blank while watching ----
async function refreshBadge() {
  const s = await getState();
  if (!s.enabled) {
    chrome.action.setBadgeBackgroundColor({ color: '#888888' });
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setTitle({ title: 'YouTube Kid Limiter — protection OFF' });
    return;
  }
  if (s.phase === 'resting') {
    chrome.action.setBadgeBackgroundColor({ color: '#46d160' });
    chrome.action.setBadgeText({ text: 'REST' });
    chrome.action.setTitle({ title: 'YouTube Kid Limiter — resting' });
    return;
  }
  chrome.action.setBadgeText({ text: '' });
  chrome.action.setTitle({ title: 'YouTube Kid Limiter — active' });
}

refreshBadge();

// ---- tab helpers ----
const youtubeTabs = () => chrome.tabs.query({ url: '*://*.youtube.com/*' });

function sendToTab(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

async function broadcast(msg) {
  const tabs = await youtubeTabs();
  for (const t of tabs) sendToTab(t.id, msg);
}

async function anyVideoPlaying() {
  const tabs = await youtubeTabs();
  for (const t of tabs) {
    try {
      const r = await chrome.tabs.sendMessage(t.id, { cmd: 'checkVideoStatus' });
      if (r && r.isPlaying) return true;
    } catch (_) {}
  }
  return false;
}

async function firstPlayingTab() {
  const tabs = await youtubeTabs();
  for (const t of tabs) {
    try {
      const r = await chrome.tabs.sendMessage(t.id, { cmd: 'checkVideoStatus' });
      if (r && r.isPlaying) return t.id;
    } catch (_) {}
  }
  return tabs[0]?.id ?? null;
}

// ---- phase transitions ----
async function startCounting(s, now) {
  await chrome.storage.local.set({ phase: 'watching', lastPlayStart: now });
  const remaining = minToMs(s.usageTime) - s.accumulatedUsed;
  await chrome.alarms.clear(ALARMS.DRAIN);
  await chrome.alarms.create(ALARMS.DRAIN, { delayInMinutes: Math.max(remaining, 1000) / 60000 });
  await broadcast({ cmd: 'showGauge', remainingMs: remaining, totalMs: minToMs(s.usageTime) });
  await refreshBadge();
}

async function onVideoPlaying(tabId) {
  const s = await getState();
  if (!s.enabled) { sendToTab(tabId, { cmd: 'clear' }); return; }
  const now = Date.now();

  if (s.phase === 'resting') {
    const remaining = minToMs(s.breakTime) - (now - s.restStart);
    if (remaining <= 0) { await enterWatch(now); return; }
    sendToTab(tabId, { cmd: 'showRest', remainingMs: remaining, totalMs: minToMs(s.breakTime) });
    return;
  }

  if (s.lastPlayStart) {
    // already counting (e.g. a second tab) — just make sure the gauge is shown
    const remaining = minToMs(s.usageTime) - (s.accumulatedUsed + (now - s.lastPlayStart));
    sendToTab(tabId, { cmd: 'showGauge', remainingMs: remaining, totalMs: minToMs(s.usageTime) });
    return;
  }

  await startCounting(s, now);
}

async function onAllPaused() {
  const s = await getState();
  if (!s.enabled) return;
  const now = Date.now();
  if (s.phase === 'watching' && s.lastPlayStart) {
    const used = s.accumulatedUsed + (now - s.lastPlayStart);
    await chrome.storage.local.set({ accumulatedUsed: used, lastPlayStart: null });
    await chrome.alarms.clear(ALARMS.DRAIN);
    // Keep the gauge on screen, frozen at the remaining level (no countdown/leak).
    const remaining = minToMs(s.usageTime) - used;
    await broadcast({ cmd: 'showGaugeFrozen', remainingMs: remaining, totalMs: minToMs(s.usageTime) });
  }
}

async function enterRest(now, tabId) {
  const s = await getState();
  if (s.phase === 'resting') return;
  await chrome.storage.local.set({
    phase: 'resting', restStart: now, accumulatedUsed: 0, lastPlayStart: null, restTabId: tabId ?? null,
  });
  await chrome.alarms.clear(ALARMS.DRAIN);
  await chrome.alarms.create(ALARMS.REST, { delayInMinutes: Math.max(minToMs(s.breakTime), 1000) / 60000 });
  await broadcast({ cmd: 'showRest', remainingMs: minToMs(s.breakTime), totalMs: minToMs(s.breakTime) });
  await refreshBadge();
}

async function enterWatch(now) {
  const s = await getState();
  if (s.phase !== 'resting') return;
  await chrome.storage.local.set({ phase: 'idle', restStart: null, accumulatedUsed: 0, lastPlayStart: null, restTabId: null, warned: [] });
  await chrome.alarms.clear(ALARMS.REST);
  // Mind recharged — show the "Start watching" screen but do NOT autoplay. The kid
  // must click Start, which resumes the video and begins a fresh counting cycle.
  await broadcast({ cmd: 'ready' });
  await refreshBadge();
}

async function onDrainComplete(tabId) {
  const s = await getState();
  if (s.phase !== 'watching') return;
  await enterRest(Date.now(), tabId ?? (await firstPlayingTab()));
}

// A gauge crossed a warning threshold. Fire the heads-up once per cycle.
async function onMaybeWarn(tabId, threshold) {
  const s = await getState();
  if (!s.enabled || s.phase !== 'watching') return;
  if (threshold >= minToMs(s.usageTime)) return; // threshold longer than the whole session
  const warned = s.warned || [];
  if (warned.includes(threshold)) return;
  await chrome.storage.local.set({ warned: [...warned, threshold] });
  sendToTab(tabId, { cmd: 'headsUp', minutesLeft: Math.round(threshold / 60000) });
}

// ---- popup actions (already verified by the math lock) ----
async function saveSettings({ usageTime, breakTime, difficulty }) {
  await chrome.storage.local.set({
    usageTime, breakTime, difficulty,
    enabled: true, phase: 'idle', accumulatedUsed: 0, lastPlayStart: null, restStart: null, restTabId: null, warned: [],
  });
  await chrome.alarms.clearAll();
  await broadcast({ cmd: 'clear' });
  await refreshBadge();
}

async function turnOff() {
  await chrome.storage.local.set({ enabled: false, phase: 'idle', accumulatedUsed: 0, lastPlayStart: null, restStart: null, restTabId: null, warned: [] });
  await chrome.alarms.clearAll();
  await broadcast({ cmd: 'clear' });
  await refreshBadge();
}

async function turnOn() {
  await chrome.storage.local.set({ enabled: true, phase: 'idle', accumulatedUsed: 0, lastPlayStart: null, restStart: null, restTabId: null, warned: [] });
  await chrome.alarms.clearAll();
  await broadcast({ cmd: 'clear' });
  await refreshBadge();
}

// ---- render / status snapshots ----
async function computeRender() {
  const s = await getState();
  if (!s.enabled) return { cmd: 'clear' };
  const now = Date.now();
  if (s.phase === 'resting') {
    const remaining = minToMs(s.breakTime) - (now - s.restStart);
    if (remaining <= 0) { await enterWatch(now); return { cmd: 'clear' }; }
    return { cmd: 'showRest', remainingMs: remaining, totalMs: minToMs(s.breakTime) };
  }
  if (s.phase === 'watching' && s.lastPlayStart) {
    const remaining = minToMs(s.usageTime) - (s.accumulatedUsed + (now - s.lastPlayStart));
    return { cmd: 'showGauge', remainingMs: remaining, totalMs: minToMs(s.usageTime) };
  }
  if (s.phase === 'watching') { // counting started but currently paused
    const remaining = minToMs(s.usageTime) - s.accumulatedUsed;
    return { cmd: 'showGaugeFrozen', remainingMs: remaining, totalMs: minToMs(s.usageTime) };
  }
  return { cmd: 'clear' };
}

async function computeStatus() {
  const s = await getState();
  const now = Date.now();
  let remainingMs = null;
  if (s.enabled && s.phase === 'resting') remainingMs = minToMs(s.breakTime) - (now - s.restStart);
  else if (s.enabled && s.phase === 'watching' && s.lastPlayStart) remainingMs = minToMs(s.usageTime) - (s.accumulatedUsed + (now - s.lastPlayStart));
  return { enabled: s.enabled, phase: s.phase, remainingMs, usageTime: s.usageTime, breakTime: s.breakTime, difficulty: s.difficulty };
}

// ---- alarms (backup transitions when no tab is driving the timer) ----
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARMS.DRAIN) await enterRest(Date.now(), await firstPlayingTab());
  else if (alarm.name === ALARMS.REST) await enterWatch(Date.now());
});

// ---- message router ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const tabId = sender.tab?.id;
    switch (msg.type) {
      case 'videoPlaying': await onVideoPlaying(tabId); break;
      case 'videoPaused': if (!(await anyVideoPlaying())) await onAllPaused(); break;
      case 'drainComplete': await onDrainComplete(tabId); break;
      case 'maybeWarn': await onMaybeWarn(tabId, msg.threshold); break;
      case 'restComplete': await enterWatch(Date.now()); break;
      case 'getState': sendResponse(await computeRender()); return;
      case 'getStatus': sendResponse(await computeStatus()); return;
      case 'saveSettings': await saveSettings(msg.settings); sendResponse({ ok: true }); return;
      case 'turnOff': await turnOff(); sendResponse({ ok: true }); return;
      case 'turnOn': await turnOn(); sendResponse({ ok: true }); return;
      case 'skipBreak': await enterWatch(Date.now()); sendResponse({ ok: true }); return;
    }
  })();
  return true; // keep the channel open for async sendResponse
});

// Re-evaluate when tabs close (a closed tab may have been the only one playing).
chrome.tabs.onRemoved.addListener(async () => {
  if (!(await anyVideoPlaying())) await onAllPaused();
});
