// Background service worker: owns the watch/rest cycle, time-keeping and alarms.
// Usage time only counts while a video is actually playing. Rest counts on wall-clock.

const ALARMS = { DRAIN: 'drainDone', REST: 'restDone' };

// Treats: kid-facing rewards. Tapping one (after a parent math check) banks extra
// watch minutes. Fully editable from the popup's treat editor; these are seed defaults.
const DEFAULT_TREATS = [
  { id: 't1', label: 'Homework — 1 page', minutes: 5, emoji: '📚' },
  { id: 't2', label: 'Homework — 2 pages', minutes: 10, emoji: '✏️' },
  { id: 't3', label: 'Homework — 3 pages', minutes: 15, emoji: '🎓' },
  { id: 't4', label: 'Great behavior', minutes: 15, emoji: '⭐' },
  { id: 't5', label: 'Helped at home', minutes: 10, emoji: '🏠' },
  { id: 't6', label: 'Bonus treat', minutes: 5, emoji: '🎁' },
];

// mathConfig: parent-tweakable math-lock rules. operations is any of add|sub|mul, and each
// op carries its own answer range (cfg.ranges[op] = {min,max}). Stored opaquely here; the
// flat default below is normalized into the per-op shape by lib/math-lock.js.
const DEFAULT_MATH_CONFIG = { operations: ['add'], minAnswer: 8, maxAnswer: 14 };

// Default global daily cap on how many treats the kid can RECEIVE (claim/bank) in one
// calendar day. Once reached, claiming locks until the next day. This is independent of
// which treat is tapped — it counts total claims across all treats. Parent-editable from
// the treat editor and persisted as the `giftLimit` setting.
const DAILY_GIFT_LIMIT = 3;

const SETTING_DEFAULTS = { usageTime: 45, breakTime: 480, mathConfig: DEFAULT_MATH_CONFIG, enabled: true, treats: DEFAULT_TREATS, giftLimit: DAILY_GIFT_LIMIT };
// earnedBonuses: { [treatId]: count } — banked treat earnings. Persists across rest/watch
//   cycles so the kid can spend them on the rest screen. Cleared only on a hard reset
//   (turn off/on, save settings).
// sessionBudgetMs: when non-null, overrides the base watch budget for the next session
//   (used when a bonus is spent on the rest screen — that session lasts only the treat's
//   minutes). Cleared when a rest begins.
// giftDate: local calendar day (YYYY-M-D) the giftsToday counter applies to. When the
//   current day differs, the counter is treated as 0 (fresh day) before any claim.
// giftsToday: number of treats claimed so far on giftDate. Capped at DAILY_GIFT_LIMIT.
//   Deliberately NOT cleared on save/turn-off/turn-on so the daily cap can't be reset by
//   toggling protection — it only rolls over when the calendar day changes.
const RUNTIME_DEFAULTS = { phase: 'idle', accumulatedUsed: 0, lastPlayStart: null, restStart: null, restTabId: null, warned: [], bonusMs: 0, earnedBonuses: {}, sessionBudgetMs: null, giftDate: null, giftsToday: 0 };

const minToMs = (m) => m * 60 * 1000;

// Local calendar-day key used to scope the daily gift counter.
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

// How many gifts have been claimed today, accounting for a possible day rollover.
const giftsClaimedToday = (s) => (s.giftDate === todayKey() ? (s.giftsToday || 0) : 0);

// Total watch budget for a session = base (usageTime, or a one-shot session override)
// plus any live bonus minutes added during this session. bonusMs is wiped at rest start;
// earnedBonuses (per-treat counts) persist separately and are spent on the rest screen.
const baseBudgetMs = (s) => (s.sessionBudgetMs != null ? s.sessionBudgetMs : minToMs(s.usageTime));
const usageBudgetMs = (s) => baseBudgetMs(s) + (s.bonusMs || 0);

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
  const total = usageBudgetMs(s);
  const remaining = total - s.accumulatedUsed;
  await chrome.alarms.clear(ALARMS.DRAIN);
  await chrome.alarms.create(ALARMS.DRAIN, { delayInMinutes: Math.max(remaining, 1000) / 60000 });
  await broadcast({ cmd: 'showGauge', remainingMs: remaining, totalMs: total });
  await refreshBadge();
}

async function onVideoPlaying(tabId) {
  const s = await getState();
  if (!s.enabled) { sendToTab(tabId, { cmd: 'clear' }); return; }
  const now = Date.now();

  if (s.phase === 'resting') {
    const remaining = minToMs(s.breakTime) - (now - s.restStart);
    if (remaining <= 0) { await enterWatch(now); return; }
    sendToTab(tabId, {
      cmd: 'showRest', remainingMs: remaining, totalMs: minToMs(s.breakTime),
      treats: s.treats || [], earnedBonuses: s.earnedBonuses || {},
    });
    return;
  }

  if (s.lastPlayStart) {
    // already counting (e.g. a second tab) — just make sure the gauge is shown
    const remaining = usageBudgetMs(s) - (s.accumulatedUsed + (now - s.lastPlayStart));
    sendToTab(tabId, { cmd: 'showGauge', remainingMs: remaining, totalMs: usageBudgetMs(s) });
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
    const remaining = usageBudgetMs(s) - used;
    await broadcast({ cmd: 'showGaugeFrozen', remainingMs: remaining, totalMs: usageBudgetMs(s) });
  }
}

async function enterRest(now, tabId) {
  const s = await getState();
  if (s.phase === 'resting') return;
  await chrome.storage.local.set({
    phase: 'resting', restStart: now, accumulatedUsed: 0, lastPlayStart: null, restTabId: tabId ?? null, bonusMs: 0, sessionBudgetMs: null,
  });
  await chrome.alarms.clear(ALARMS.DRAIN);
  await chrome.alarms.create(ALARMS.REST, { delayInMinutes: Math.max(minToMs(s.breakTime), 1000) / 60000 });
  await broadcast({
    cmd: 'showRest', remainingMs: minToMs(s.breakTime), totalMs: minToMs(s.breakTime),
    treats: s.treats || [], earnedBonuses: s.earnedBonuses || {},
  });
  await refreshBadge();
}

async function enterWatch(now) {
  const s = await getState();
  if (s.phase !== 'resting') return;
  await chrome.storage.local.set({ phase: 'idle', restStart: null, accumulatedUsed: 0, lastPlayStart: null, restTabId: null, warned: [], bonusMs: 0 });
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
async function saveSettings({ usageTime, breakTime, mathConfig }) {
  await chrome.storage.local.set({
    usageTime, breakTime, mathConfig: mathConfig || DEFAULT_MATH_CONFIG,
    enabled: true, phase: 'idle', accumulatedUsed: 0, lastPlayStart: null, restStart: null, restTabId: null, warned: [], bonusMs: 0, earnedBonuses: {}, sessionBudgetMs: null,
  });
  await chrome.alarms.clearAll();
  await broadcast({ cmd: 'clear' });
  await refreshBadge();
}

async function turnOff() {
  await chrome.storage.local.set({ enabled: false, phase: 'idle', accumulatedUsed: 0, lastPlayStart: null, restStart: null, restTabId: null, warned: [], bonusMs: 0, earnedBonuses: {}, sessionBudgetMs: null });
  await chrome.alarms.clearAll();
  await broadcast({ cmd: 'clear' });
  await refreshBadge();
}

async function turnOn() {
  await chrome.storage.local.set({ enabled: true, phase: 'idle', accumulatedUsed: 0, lastPlayStart: null, restStart: null, restTabId: null, warned: [], bonusMs: 0, earnedBonuses: {}, sessionBudgetMs: null });
  await chrome.alarms.clearAll();
  await broadcast({ cmd: 'clear' });
  await refreshBadge();
}

// Persist the (parent-edited) treat definitions and, optionally, the daily gift cap.
// giftLimit is clamped to a sane minimum of 1 so the kid can always earn at least one.
async function saveTreats(treats, giftLimit) {
  const next = { treats };
  if (giftLimit !== undefined) next.giftLimit = Math.max(1, Number(giftLimit) || DAILY_GIFT_LIMIT);
  await chrome.storage.local.set(next);
}

// Bank a treat that the kid earned (parent already passed the math lock in the popup).
// Earnings always bank — never live-extend the current watch — so each treat is worth
// exactly one bonus session, spent later by tapping the tile on the rest screen.
// Returns { ok, locked, claimedToday, limit } so the popup can confirm or report the cap.
async function claimTreat(treatId) {
  const s = await getState();
  const limit = Number(s.giftLimit) || DAILY_GIFT_LIMIT;
  const claimedToday = giftsClaimedToday(s);
  if (!s.enabled) return { ok: false, locked: false, claimedToday, limit };
  const treat = (s.treats || []).find((t) => t.id === treatId);
  if (!treat) return { ok: false, locked: false, claimedToday, limit };

  // Enforce the global daily gift cap before banking anything.
  if (claimedToday >= limit) return { ok: false, locked: true, claimedToday, limit };

  const earnedBonuses = { ...(s.earnedBonuses || {}) };
  earnedBonuses[treatId] = (earnedBonuses[treatId] || 0) + 1;
  const giftsToday = claimedToday + 1;
  await chrome.storage.local.set({ earnedBonuses, giftDate: todayKey(), giftsToday });

  // Refresh the rest screen so the new earning shows up in the tile row right away.
  if (s.phase === 'resting' && s.restStart) {
    const remaining = minToMs(s.breakTime) - (Date.now() - s.restStart);
    await broadcast({
      cmd: 'showRest', remainingMs: Math.max(0, remaining), totalMs: minToMs(s.breakTime),
      treats: s.treats || [], earnedBonuses,
    });
  }
  return { ok: true, locked: giftsToday >= limit, claimedToday: giftsToday, limit };
}

// Spend one earned bonus from the rest screen: end the break immediately and start a
// new watch session whose budget is JUST that treat's minutes (per the chosen
// "skip rest, watch with bonus" semantics).
async function useTreatOnRest(treatId) {
  const s = await getState();
  if (!s.enabled || s.phase !== 'resting') return;
  const treat = (s.treats || []).find((t) => t.id === treatId);
  if (!treat) return;
  const earnedBonuses = { ...(s.earnedBonuses || {}) };
  const count = earnedBonuses[treatId] || 0;
  if (count <= 0) return;
  earnedBonuses[treatId] = count - 1;
  if (earnedBonuses[treatId] === 0) delete earnedBonuses[treatId];

  await chrome.alarms.clear(ALARMS.REST);
  await chrome.storage.local.set({
    phase: 'idle', restStart: null, restTabId: null, accumulatedUsed: 0, lastPlayStart: null,
    warned: [], bonusMs: 0, earnedBonuses,
    sessionBudgetMs: Math.max(1, Number(treat.minutes) || 1) * 60000,
  });
  await refreshBadge();
  // Clear the rest overlay and resume the paused video on the watching tab(s);
  // onVideoPlaying will then start counting against the one-shot bonus budget.
  await broadcast({ cmd: 'resume' });
}

// ---- render / status snapshots ----
async function computeRender() {
  const s = await getState();
  if (!s.enabled) return { cmd: 'clear' };
  const now = Date.now();
  if (s.phase === 'resting') {
    const remaining = minToMs(s.breakTime) - (now - s.restStart);
    if (remaining <= 0) { await enterWatch(now); return { cmd: 'clear' }; }
    return {
      cmd: 'showRest', remainingMs: remaining, totalMs: minToMs(s.breakTime),
      treats: s.treats || [], earnedBonuses: s.earnedBonuses || {},
    };
  }
  if (s.phase === 'watching' && s.lastPlayStart) {
    const remaining = usageBudgetMs(s) - (s.accumulatedUsed + (now - s.lastPlayStart));
    return { cmd: 'showGauge', remainingMs: remaining, totalMs: usageBudgetMs(s) };
  }
  if (s.phase === 'watching') { // counting started but currently paused
    const remaining = usageBudgetMs(s) - s.accumulatedUsed;
    return { cmd: 'showGaugeFrozen', remainingMs: remaining, totalMs: usageBudgetMs(s) };
  }
  return { cmd: 'clear' };
}

async function computeStatus() {
  const s = await getState();
  const now = Date.now();
  let remainingMs = null;
  if (s.enabled && s.phase === 'resting') remainingMs = minToMs(s.breakTime) - (now - s.restStart);
  else if (s.enabled && s.phase === 'watching' && s.lastPlayStart) remainingMs = usageBudgetMs(s) - (s.accumulatedUsed + (now - s.lastPlayStart));
  return {
    enabled: s.enabled, phase: s.phase, remainingMs,
    usageTime: s.usageTime, breakTime: s.breakTime, mathConfig: s.mathConfig || DEFAULT_MATH_CONFIG,
    treats: s.treats || DEFAULT_TREATS, bonusMs: s.bonusMs || 0,
    earnedBonuses: s.earnedBonuses || {},
    giftsToday: giftsClaimedToday(s), giftLimit: Number(s.giftLimit) || DAILY_GIFT_LIMIT,
  };
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
      case 'claimTreat': sendResponse(await claimTreat(msg.treatId)); return;
      case 'useTreatOnRest': await useTreatOnRest(msg.treatId); sendResponse({ ok: true }); return;
      case 'saveTreats': await saveTreats(msg.treats, msg.giftLimit); sendResponse({ ok: true }); return;
    }
  })();
  return true; // keep the channel open for async sendResponse
});

// Re-evaluate when tabs close (a closed tab may have been the only one playing).
chrome.tabs.onRemoved.addListener(async () => {
  if (!(await anyVideoPlaying())) await onAllPaused();
});
