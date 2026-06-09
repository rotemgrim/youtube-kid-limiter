// Flow tests for the background service worker (the watch/rest state machine).
// Run with:  npm test   (node --test ./tests/)

import { test, describe } from 'node:test';
// Non-strict assert on purpose: background.js runs in a vm sandbox, so objects it
// returns carry that realm's Object.prototype. Strict deepEqual rejects them on the
// prototype check alone; the legacy (non-strict) variant compares structurally, which
// is exactly what we want across the sandbox boundary.
import assert from 'node:assert';
import { createHarness, MIN } from './harness.mjs';

// Default settings (mirror background.js SETTING_DEFAULTS for readable expectations).
const USAGE = MIN(20);
const BREAK = MIN(10);

// Build a harness already seeded with defaults and (optionally) extra state.
async function fresh(overrides) {
  const h = createHarness();
  await h.seedDefaults();
  if (overrides) h.setStore(overrides);
  return h;
}

describe('install / defaults', () => {
  test('seeds full default state', async () => {
    const h = await fresh();
    const s = h.state();
    assert.equal(s.enabled, true);
    assert.equal(s.phase, 'idle');
    assert.equal(s.usageTime, 20);
    assert.equal(s.breakTime, 10);
    assert.deepEqual(s.mathConfig, { operations: ['add'], minAnswer: 8, maxAnswer: 14 });
    assert.equal(s.bonusMs, 0);
    assert.equal(s.sessionBudgetMs, null);
    assert.deepEqual(s.warned, []);
    assert.deepEqual(s.earnedBonuses, {});
    assert.equal(s.treats.length, 6);
  });

  test('does not overwrite values that already exist', async () => {
    const h = createHarness();
    h.resetStore();
    h.setStore({ usageTime: 5, enabled: false });
    await h.listeners.onInstalled();
    const s = h.state();
    assert.equal(s.usageTime, 5); // kept
    assert.equal(s.enabled, false); // kept
    assert.equal(s.breakTime, 10); // filled from defaults
  });
});

describe('watch counting', () => {
  test('first play starts a counting session and shows the gauge', async () => {
    const h = await fresh();
    await h.bg.onVideoPlaying(1);
    const s = h.state();
    assert.equal(s.phase, 'watching');
    assert.equal(s.lastPlayStart, h.now());
    assert.equal(h.alarms.get('drainDone').delayInMinutes, USAGE / 60000);
    const g = h.lastSent('showGauge');
    assert.equal(g.msg.totalMs, USAGE);
    assert.equal(g.msg.remainingMs, USAGE);
  });

  test('a second playing tab re-shows the gauge without resetting the clock', async () => {
    const h = await fresh();
    await h.bg.onVideoPlaying(1);
    const startedAt = h.state().lastPlayStart;
    h.advance(MIN(5));
    h.clearSent();
    await h.bg.onVideoPlaying(2); // another tab reports playing
    assert.equal(h.state().lastPlayStart, startedAt); // unchanged
    const g = h.lastSent('showGauge');
    assert.equal(g.tabId, 2);
    assert.equal(g.msg.remainingMs, USAGE - MIN(5));
  });

  test('disabled extension just clears any overlay', async () => {
    const h = await fresh({ enabled: false });
    await h.bg.onVideoPlaying(1);
    assert.equal(h.state().phase, 'idle');
    assert.equal(h.lastSent('clear').tabId, 1);
  });
});

describe('pause freezes the gauge', () => {
  test('accumulates used time, drops the clock, and freezes', async () => {
    const h = await fresh();
    await h.bg.onVideoPlaying(1);
    h.advance(MIN(7));
    h.clearSent();
    await h.bg.onAllPaused();
    const s = h.state();
    assert.equal(s.accumulatedUsed, MIN(7));
    assert.equal(s.lastPlayStart, null);
    assert.equal(h.alarms.has('drainDone'), false); // drain alarm cleared
    const f = h.lastSent('showGaugeFrozen');
    assert.equal(f.msg.remainingMs, USAGE - MIN(7));
    assert.equal(f.msg.totalMs, USAGE);
  });

  test('resuming after a pause continues from the accumulated total', async () => {
    const h = await fresh();
    await h.bg.onVideoPlaying(1);
    h.advance(MIN(7));
    await h.bg.onAllPaused();
    h.advance(MIN(3)); // paused time must NOT count
    h.clearSent();
    await h.bg.onVideoPlaying(1);
    const g = h.lastSent('showGauge');
    assert.equal(g.msg.remainingMs, USAGE - MIN(7)); // still 13 min left, pause ignored
  });
});

describe('drain -> rest', () => {
  test('draining enters the rest phase and shows the rest screen', async () => {
    const h = await fresh();
    await h.bg.onVideoPlaying(1);
    h.clearSent();
    await h.bg.onDrainComplete(1);
    const s = h.state();
    assert.equal(s.phase, 'resting');
    assert.equal(s.restStart, h.now());
    assert.equal(s.accumulatedUsed, 0);
    assert.equal(s.lastPlayStart, null);
    assert.equal(s.bonusMs, 0);
    assert.equal(s.sessionBudgetMs, null);
    assert.equal(h.alarms.has('drainDone'), false);
    assert.equal(h.alarms.get('restDone').delayInMinutes, BREAK / 60000);
    const r = h.lastSent('showRest');
    assert.equal(r.msg.totalMs, BREAK);
    assert.equal(r.msg.treats.length, 6);
    assert.deepEqual(r.msg.earnedBonuses, {});
  });

  test('drainComplete is ignored when not watching', async () => {
    const h = await fresh({ phase: 'resting' });
    h.setStore({ restStart: h.now() });
    await h.bg.onDrainComplete(1);
    assert.equal(h.state().phase, 'resting'); // unchanged
  });

  test('enterRest is idempotent while already resting', async () => {
    const h = await fresh({ phase: 'resting', restStart: 42 });
    await h.bg.enterRest(h.now(), 1);
    assert.equal(h.state().restStart, 42); // not overwritten
  });
});

describe('rest -> ready (enterWatch)', () => {
  test('finishing a rest goes idle, clears warnings, and prompts ready', async () => {
    const h = await fresh({ phase: 'resting' });
    h.setStore({ restStart: h.now(), warned: [MIN(5)] });
    h.clearSent();
    await h.bg.enterWatch(h.now());
    const s = h.state();
    assert.equal(s.phase, 'idle');
    assert.equal(s.restStart, null);
    assert.deepEqual(s.warned, []);
    assert.equal(h.alarms.has('restDone'), false);
    assert.equal(h.lastSent('ready').tabId, 1);
  });

  test('enterWatch only runs from the resting phase', async () => {
    const h = await fresh({ phase: 'idle' });
    await h.bg.enterWatch(h.now());
    assert.equal(h.lastSent('ready'), undefined);
  });

  test('playing during a not-yet-expired rest re-shows the rest screen', async () => {
    const h = await fresh({ phase: 'resting' });
    h.setStore({ restStart: h.now() });
    h.advance(MIN(3));
    h.clearSent();
    await h.bg.onVideoPlaying(1);
    const r = h.lastSent('showRest');
    assert.equal(r.msg.remainingMs, BREAK - MIN(3));
  });

  test('playing after the rest has elapsed transitions to ready', async () => {
    const h = await fresh({ phase: 'resting' });
    h.setStore({ restStart: h.now() });
    h.advance(BREAK + MIN(1));
    h.clearSent();
    await h.bg.onVideoPlaying(1);
    assert.equal(h.state().phase, 'idle');
    assert.equal(h.lastSent('ready').tabId, 1);
  });
});

describe('warnings (5 / 2 minute heads-up)', () => {
  // The base watching state used by these tests.
  async function watching(extra) {
    return fresh({ phase: 'watching', lastPlayStart: 1, accumulatedUsed: 0, ...extra });
  }

  test('fires the 5-minute heads-up once and records it', async () => {
    const h = await watching();
    await h.bg.onMaybeWarn(1, MIN(5));
    assert.deepEqual(h.state().warned, [MIN(5)]);
    const hu = h.lastSent('headsUp');
    assert.equal(hu.msg.minutesLeft, 5);
  });

  test('fires the 2-minute heads-up', async () => {
    const h = await watching();
    await h.bg.onMaybeWarn(1, MIN(2));
    assert.equal(h.lastSent('headsUp').msg.minutesLeft, 2);
  });

  test('does not fire the same threshold twice', async () => {
    const h = await watching({ warned: [MIN(5)] });
    await h.bg.onMaybeWarn(1, MIN(5));
    assert.equal(h.lastSent('headsUp'), undefined);
    assert.deepEqual(h.state().warned, [MIN(5)]);
  });

  test('suppresses a threshold that is >= the whole session budget', async () => {
    // 5-min session: the 5-min warning equals the budget and must not fire.
    const h = await watching({ usageTime: 5 });
    await h.bg.onMaybeWarn(1, MIN(5));
    assert.equal(h.lastSent('headsUp'), undefined);
  });

  test('never warns outside the watching phase', async () => {
    const h = await fresh({ phase: 'resting', restStart: 1 });
    await h.bg.onMaybeWarn(1, MIN(5));
    assert.equal(h.lastSent('headsUp'), undefined);
  });

  test('warnings reset each cycle so they fire again next session', async () => {
    const h = await watching();
    await h.bg.onMaybeWarn(1, MIN(5));
    await h.bg.onDrainComplete(1); // -> resting
    await h.bg.enterWatch(h.now()); // -> idle, warned cleared
    assert.deepEqual(h.state().warned, []);
    h.setStore({ phase: 'watching', lastPlayStart: h.now() });
    h.clearSent();
    await h.bg.onMaybeWarn(1, MIN(5));
    assert.equal(h.lastSent('headsUp').msg.minutesLeft, 5); // fires again
  });
});

describe('treats — claiming (banking) earnings', () => {
  test('claiming a treat increments its banked count', async () => {
    const h = await fresh();
    await h.bg.claimTreat('t1');
    assert.deepEqual(h.state().earnedBonuses, { t1: 1 });
    await h.bg.claimTreat('t1');
    assert.deepEqual(h.state().earnedBonuses, { t1: 2 });
  });

  test('claiming during a rest refreshes the rest screen with the new earning', async () => {
    const h = await fresh({ phase: 'resting' });
    h.setStore({ restStart: h.now() });
    h.clearSent();
    await h.bg.claimTreat('t2');
    const r = h.lastSent('showRest');
    assert.deepEqual(r.msg.earnedBonuses, { t2: 1 });
  });

  test('unknown treat id is a no-op', async () => {
    const h = await fresh();
    await h.bg.claimTreat('nope');
    assert.deepEqual(h.state().earnedBonuses, {});
  });

  test('claiming while disabled is a no-op', async () => {
    const h = await fresh({ enabled: false });
    await h.bg.claimTreat('t1');
    assert.deepEqual(h.state().earnedBonuses, {});
  });
});

describe('treats — spending on the rest screen', () => {
  test('spending ends the break and starts a bonus-budget session', async () => {
    const h = await fresh({ phase: 'resting', restStart: 1, earnedBonuses: { t1: 2 } });
    h.clearSent();
    await h.bg.useTreatOnRest('t1'); // t1 = 5 minutes
    const s = h.state();
    assert.deepEqual(s.earnedBonuses, { t1: 1 }); // decremented
    assert.equal(s.phase, 'idle');
    assert.equal(s.sessionBudgetMs, MIN(5));
    assert.deepEqual(s.warned, []);
    assert.equal(h.alarms.has('restDone'), false);
    assert.equal(h.lastSent('resume').tabId, 1);
  });

  test('spending the last earning removes the key', async () => {
    const h = await fresh({ phase: 'resting', restStart: 1, earnedBonuses: { t1: 1 } });
    await h.bg.useTreatOnRest('t1');
    assert.deepEqual(h.state().earnedBonuses, {});
  });

  test('spending with zero earned is a no-op', async () => {
    const h = await fresh({ phase: 'resting', restStart: 1, earnedBonuses: {} });
    await h.bg.useTreatOnRest('t1');
    assert.equal(h.state().phase, 'resting'); // unchanged
  });

  test('spending outside a rest is a no-op', async () => {
    const h = await fresh({ phase: 'watching', lastPlayStart: 1, earnedBonuses: { t1: 1 } });
    await h.bg.useTreatOnRest('t1');
    assert.equal(h.state().phase, 'watching');
    assert.deepEqual(h.state().earnedBonuses, { t1: 1 });
  });
});

describe('one-shot bonus budget (sessionBudgetMs)', () => {
  test('the next session lasts exactly the spent treat minutes', async () => {
    const h = await fresh({ phase: 'resting', restStart: 1, earnedBonuses: { t1: 1 } });
    await h.bg.useTreatOnRest('t1'); // sessionBudgetMs = 5 min
    h.clearSent();
    await h.bg.onVideoPlaying(1);
    const g = h.lastSent('showGauge');
    assert.equal(g.msg.totalMs, MIN(5));
    assert.equal(h.alarms.get('drainDone').delayInMinutes, 5);
  });

  test('starting a rest clears the one-shot budget', async () => {
    const h = await fresh({ phase: 'watching', lastPlayStart: 1, sessionBudgetMs: MIN(5) });
    await h.bg.onDrainComplete(1);
    assert.equal(h.state().sessionBudgetMs, null);
  });
});

describe('bonus minutes add to the budget', () => {
  test('bonusMs enlarges the gauge total', async () => {
    const h = await fresh({ phase: 'watching', bonusMs: MIN(2) });
    h.setStore({ lastPlayStart: h.now() });
    const r = await h.bg.computeRender();
    assert.equal(r.cmd, 'showGauge');
    assert.equal(r.totalMs, USAGE + MIN(2));
  });
});

describe('parent actions', () => {
  test('saveSettings updates config and resets the cycle', async () => {
    const h = await fresh({ phase: 'watching', warned: [MIN(5)], earnedBonuses: { t1: 3 } });
    h.clearSent();
    await h.bg.saveSettings({ usageTime: 30, breakTime: 15, mathConfig: { operations: ['mul'], minAnswer: 20, maxAnswer: 80 } });
    const s = h.state();
    assert.equal(s.usageTime, 30);
    assert.equal(s.breakTime, 15);
    assert.deepEqual(s.mathConfig, { operations: ['mul'], minAnswer: 20, maxAnswer: 80 });
    assert.equal(s.enabled, true);
    assert.equal(s.phase, 'idle');
    assert.deepEqual(s.warned, []);
    assert.deepEqual(s.earnedBonuses, {});
    assert.equal(s.sessionBudgetMs, null);
    assert.equal(s.treats.length, 6); // treats preserved
    assert.ok(h.alarmCalls.some((c) => c.op === 'clearAll'));
    assert.equal(h.lastSent('clear').tabId, 1);
  });

  test('turnOff disables and clears everything', async () => {
    const h = await fresh({ phase: 'watching', lastPlayStart: 1 });
    h.clearSent();
    await h.bg.turnOff();
    assert.equal(h.state().enabled, false);
    assert.equal(h.state().phase, 'idle');
    assert.ok(h.alarmCalls.some((c) => c.op === 'clearAll'));
    assert.equal(h.lastSent('clear').tabId, 1);
  });

  test('turnOn re-enables in the idle phase', async () => {
    const h = await fresh({ enabled: false });
    await h.bg.turnOn();
    assert.equal(h.state().enabled, true);
    assert.equal(h.state().phase, 'idle');
  });

  test('saveTreats persists the edited treat list', async () => {
    const h = await fresh();
    const treats = [{ id: 'x', label: 'Read', minutes: 8, emoji: '📖' }];
    await h.bg.saveTreats(treats);
    assert.deepEqual(h.state().treats, treats);
  });
});

describe('message router', () => {
  test('getStatus returns the popup snapshot', async () => {
    const h = await fresh({ phase: 'watching' });
    h.setStore({ lastPlayStart: h.now() });
    const status = await h.dispatch({ type: 'getStatus' });
    assert.equal(status.enabled, true);
    assert.equal(status.phase, 'watching');
    assert.equal(status.usageTime, 20);
    assert.equal(status.remainingMs, USAGE);
    assert.equal(status.treats.length, 6);
    assert.deepEqual(status.earnedBonuses, {});
  });

  test('getState returns the render command for content scripts', async () => {
    const h = await fresh();
    const idle = await h.dispatch({ type: 'getState' });
    assert.equal(idle.cmd, 'clear');
    h.setStore({ phase: 'watching', lastPlayStart: h.now() });
    const watching = await h.dispatch({ type: 'getState' });
    assert.equal(watching.cmd, 'showGauge');
  });

  test('claimTreat routes through and acknowledges', async () => {
    const h = await fresh();
    const res = await h.dispatch({ type: 'claimTreat', treatId: 't3' });
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(h.state().earnedBonuses, { t3: 1 });
  });

  test('skipBreak ends a rest immediately', async () => {
    const h = await fresh({ phase: 'resting' });
    h.setStore({ restStart: h.now() });
    const res = await h.dispatch({ type: 'skipBreak' });
    assert.deepEqual(res, { ok: true });
    assert.equal(h.state().phase, 'idle');
  });
});
