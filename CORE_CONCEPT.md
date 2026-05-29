# Core Concept: Monitoring, Time-Keeping & Waiting Screen

This document describes the core mechanism for limiting YouTube watching time:
how watching is **monitored**, how usage time is **counted**, and how the
**waiting (block) screen** is enforced during breaks.

---

## 1. The two-phase cycle

The system alternates between two phases, both configurable (in minutes):

| Phase          | Setting     | Default | Meaning                                  |
|----------------|-------------|---------|------------------------------------------|
| **Usage Time** | `usageTime` | 5 min   | Child is allowed to watch.               |
| **Break Time** | `breakTime` | 2 min   | YouTube is blocked by a waiting screen.  |

```
[ Usage Time ] --- limit reached ---> [ Break Time (waiting screen) ] --- break over ---> [ Usage Time ] ...
```

The key rule: **usage time is only spent while a video is actually playing.**
Pausing or closing the video freezes the countdown; resuming continues it.

---

## 2. Monitoring: detecting play / pause

A content script injected into YouTube video pages watches the `<video>` element.

- Attach `onplay` and `onpause` listeners to the video element.
- Because YouTube swaps videos in dynamically (SPA navigation), use a
  `MutationObserver` to re-attach listeners to any newly added `<video>` node.
- On **play** → notify the background ("playing").
- On **pause** → notify the background ("paused").
- Also expose a "is a video currently playing?" query so the background can
  poll the true state across all open tabs (e.g. when an alarm fires).

Scope of monitoring: only real video pages (`watch?v=` and `/shorts/`),
not the homepage, search, or channel pages.

---

## 3. Time-keeping: counting only active watch time

State is persisted (so it survives the background worker sleeping):

| Key                | Meaning                                              |
|--------------------|------------------------------------------------------|
| `startUseTime`     | Timestamp when the current watching period began.    |
| `startOverlayTime` | Timestamp when the current break/waiting screen began.|
| `pauseTime`        | Timestamp when all videos were paused/closed.        |

Timers are driven by two named alarms:

- **`overlayAlarm`** — fires when usage time runs out → start break, show waiting screen.
- **`removeOverlayAlarm`** — fires when break time runs out → remove waiting screen, start new usage period.

### Play / pause accounting

- **Play (fresh start):** set `startUseTime = now`, create `overlayAlarm` for `usageTime`.
- **Pause / close (no other tab playing):** record `pauseTime`. The countdown
  effectively freezes.
- **Resume:** the pause did not consume budget. Compute remaining time and
  shift the start forward by the pause duration:

  ```
  remainingTime   = usageMillis - (pauseTime - startUseTime)
  newStartUseTime = startUseTime + (now - pauseTime)
  ```

  Then recreate the alarm for `remainingTime` only.

- **Break-overrun reset:** if the child stays away (paused) longer than a full
  break period, the usage counter resets to a fresh full period — they "earned"
  a reset by taking a long enough break.

This "freeze on pause, resume on play" logic is what makes the limit track
*actual viewing*, not wall-clock time.

---

## 4. The waiting (block) screen

When usage time is exhausted (`overlayAlarm` fires):

1. Set `startOverlayTime = now`; clear `startUseTime`.
2. Inject a full-screen overlay over the page:
   - `position: fixed`, covers 100% width/height.
   - Near-opaque dark background (`rgba(0,0,0,0.98)`).
   - Very high `z-index` so it sits above YouTube's UI.
   - Centered countdown text, e.g.
     *"You have used YouTube for X minutes. You are now in a Y-minute break! Time left: N seconds."*
   - A `setInterval` updates the remaining seconds every second.
3. Create `removeOverlayAlarm` for `breakTime`.

When the break ends (`removeOverlayAlarm` fires):

1. Remove the overlay element(s).
2. Set `startUseTime = now`; clear `startOverlayTime`.
3. Create a new `overlayAlarm` for a fresh `usageTime` period.

There is also a lightweight **in-corner timer overlay** shown during the usage
phase ("Time Left: N seconds") so the child can see their remaining budget —
distinct from the full-screen blocking overlay.

### Daily-limit trick

Set a long break to enforce a daily cap. Example: `usageTime = 120`,
`breakTime = 600` → after 2 hours of watching, YouTube is blocked for the next
10 hours.

---

## 5. Known weaknesses (to improve on)

- **DOM-only overlay** — deletable via DevTools; doesn't pause the video, so
  audio keeps playing behind it.
- **Resettable state** — `storage.local` can be cleared; disabling the
  extension removes all enforcement.
- **Narrow URL scope** — only `watch?v=` and `/shorts/`; homepage, search,
  channel pages, and embeds elsewhere are not covered.
- **No cross-device / cross-browser sync** — limits are per-browser-profile.

A more robust design would pause the actual video element, harden against DOM
tampering, persist/lock state outside easy reach, and cover all YouTube
surfaces.
