// Test harness for background.js.
//
// background.js is a classic MV3 service-worker script: it talks to global `chrome.*`
// APIs and registers listeners at load time. Rather than refactor it for testability,
// we load it into a `vm` sandbox with an in-memory mock `chrome` and a controllable
// clock, then drive its internal functions directly and assert on the resulting state,
// the messages it sends to tabs, and the alarms it schedules.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKGROUND_SRC = readFileSync(join(HERE, '..', 'background.js'), 'utf8');

// Re-export every function/const we want to reach from tests. Appended in the script's
// own lexical scope so it sees both `function` and `const` declarations regardless of
// how vm binds top-level declarations to the context global.
const EXPOSE = `
;globalThis.__bg = {
  onVideoPlaying, onAllPaused, onDrainComplete, enterRest, enterWatch, onMaybeWarn,
  claimTreat, useTreatOnRest, saveSettings, turnOff, turnOn, saveTreats,
  startCounting, computeRender, computeStatus, refreshBadge,
  getState, usageBudgetMs, minToMs,
};`;

export function createHarness({ now = 1_000_000, tabs = [{ id: 1 }], playing = [] } = {}) {
  const clock = { t: now };
  const FakeDate = { now: () => clock.t };

  let store = {};
  const playingTabs = new Set(playing); // tabIds that report isPlaying:true
  const listeners = {};
  const alarms = new Map(); // name -> options
  const alarmCalls = []; // ordered log of {op, name, opts}
  const sent = []; // ordered log of {tabId, msg} broadcast/sendToTab
  const badge = {};

  const chrome = {
    runtime: {
      onInstalled: { addListener: (fn) => { listeners.onInstalled = fn; } },
      onMessage: { addListener: (fn) => { listeners.onMessage = fn; } },
    },
    storage: {
      local: {
        get: async (keys) => {
          if (keys == null) return { ...store };
          if (typeof keys === 'string') return keys in store ? { [keys]: store[keys] } : {};
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) if (k in store) out[k] = store[k];
            return out;
          }
          const out = { ...keys }; // object-of-defaults form
          for (const k of Object.keys(keys)) if (k in store) out[k] = store[k];
          return out;
        },
        set: async (obj) => { Object.assign(store, obj); },
      },
    },
    action: {
      setBadgeBackgroundColor: ({ color }) => { badge.color = color; },
      setBadgeText: ({ text }) => { badge.text = text; },
      setTitle: ({ title }) => { badge.title = title; },
    },
    tabs: {
      query: async () => tabs.map((t) => ({ ...t })),
      sendMessage: async (tabId, msg) => {
        if (msg && msg.cmd === 'checkVideoStatus') return { isPlaying: playingTabs.has(tabId) };
        sent.push({ tabId, msg });
        return undefined;
      },
      onRemoved: { addListener: (fn) => { listeners.onRemoved = fn; } },
    },
    alarms: {
      create: async (name, opts) => { alarms.set(name, opts); alarmCalls.push({ op: 'create', name, opts }); },
      clear: async (name) => { alarms.delete(name); alarmCalls.push({ op: 'clear', name }); },
      clearAll: async () => { alarms.clear(); alarmCalls.push({ op: 'clearAll' }); },
      onAlarm: { addListener: (fn) => { listeners.onAlarm = fn; } },
    },
  };

  const context = vm.createContext({ chrome, Date: FakeDate, console });
  vm.runInContext(BACKGROUND_SRC + EXPOSE, context, { filename: 'background.js' });
  const bg = context.__bg;

  const api = {
    bg,
    chrome,
    clock,
    listeners,
    alarms,
    alarmCalls,
    sent,
    badge,
    playingTabs,

    // ---- state helpers ----
    get store() { return store; },
    setStore: (obj) => { Object.assign(store, obj); },
    resetStore: () => { store = {}; },
    state: () => ({ ...store }),

    // Seed real defaults by running the onInstalled handler against empty storage.
    async seedDefaults() {
      store = {};
      await listeners.onInstalled();
      return api;
    },

    // ---- time ----
    advance: (ms) => { clock.t += ms; return api; },
    now: () => clock.t,

    // ---- message-router driver (only for messages that call sendResponse) ----
    dispatch: (msg, sender = { tab: { id: 1 } }) =>
      new Promise((resolve) => { listeners.onMessage(msg, sender, resolve); }),

    // ---- assertions on sent messages ----
    lastSent: (cmd) => {
      for (let i = sent.length - 1; i >= 0; i--) if (sent[i].msg?.cmd === cmd) return sent[i];
      return undefined;
    },
    sentWith: (cmd) => sent.filter((s) => s.msg?.cmd === cmd),
    clearSent: () => { sent.length = 0; },

    setPlaying: (...ids) => { playingTabs.clear(); for (const id of ids) playingTabs.add(id); return api; },
  };
  return api;
}

// minutes -> ms, mirrors background's minToMs, for readable expectations.
export const MIN = (m) => m * 60 * 1000;
