# 🧠 YouTube Kid Limiter

**Healthy YouTube habits for kids — without the daily battle.**

YouTube Kid Limiter is a Chrome extension that turns "screen time" from a fight into a game. Instead of yanking the
tablet away mid-video, it gives your child a friendly **brain-energy meter** that slowly drains as they watch, and
gentle, restful breaks when the energy runs out. When the break is over, their mind is "recharged" and they choose to
start again.

No accounts. No subscriptions. No data leaves the browser. Install it, set two numbers, and you're done.

---

## Why parents love it

- **It feels fair to the kid.** A glowing brain in the corner shows energy draining in real time, with a heads-up before
  time's up — so the break is never a surprise or a punishment.
- **It only counts what they actually watch.** Pause the video, walk away, or close the tab and the timer freezes. Kids
  never lose minutes to a video left running in the background.
- **Breaks are calm, not jarring.** When energy runs out, a full-screen rest scene appears — a daytime activity in the
  afternoon, a sleeping-kid scene in the evening — instead of an abrupt block.
- **Kids can't just turn it off.** Changing the limits, skipping a break, or disabling protection all require solving a
  **math problem** — an age-appropriate "parent lock" that doubles as a few seconds of brain exercise.
- **One setting does daily caps too.** Want "2 hours a day, then done"? Set a long rest. After the watch time is spent,
  YouTube stays blocked for the rest of the day.
- **Private by design.** Everything runs locally in the browser. No sign-in, no tracking, no servers.

---

## How it works

The extension runs a simple two-phase cycle:

```
[ Watch time ]  ──energy runs out──▶  [ Rest break ]  ──recharged──▶  [ Watch time ] ...
```

1. **Watch time** — A brain-energy gauge sits in the corner and drains *only while a video is playing*. As it gets low,
   it pulses and gives a friendly heads-up.
2. **Rest break** — When energy hits zero, a calming full-screen rest scene takes over with a countdown.
3. **Recharge** — When the break ends, the child sees *"Your mind is recharged! Ready to watch again?"* and clicks to
   start a fresh cycle. Nothing auto-plays — restarting is their choice.

You control three things from the toolbar popup:

| Setting                  | What it does                                                | Default |
|--------------------------|-------------------------------------------------------------|---------|
| **Watch time**           | Minutes of actual viewing before a break                    | 20 min  |
| **Rest time**            | Length of the break (set long for a daily cap)              | 10 min  |
| **Math lock difficulty** | How hard the parent-check problem is (easy / medium / hard) | Medium  |

The toolbar icon shows the current state at a glance: **REST** during a break, **OFF** when protection is disabled, and
blank while watching.

---

## Install

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select this folder.
5. Pin the 🧠 icon to your toolbar, click it, set your limits, and save.

> Works on any Chromium-based browser (Chrome, Edge, Brave) using Manifest V3.

---

## Share it with other parents (one-click installer)

"Load unpacked" is fine for your own machine, but you can't hand it to another parent — and Chrome **cannot**
silently force-install a self-hosted/off-store extension on a normal (unmanaged) PC. Since Chrome 75 that only works
on managed/enterprise devices, which is why a local-file installer just "does nothing."

The reliable path is to publish to the **Chrome Web Store** (an *Unlisted* listing stays private — only people with the
link can find it), then ship a tiny installer that force-installs it from the store and **locks it on** so a kid can't
remove it.

1. **Build the upload bundle:**
   ```powershell
   npm run build:store
   ```
   This produces `dist/youtube-kid-limiter-v<version>.zip`.
2. **Upload it** at <https://chrome.google.com/webstore/devconsole> (a one-time $5 developer registration applies).
   Choose **Unlisted** visibility to keep it private. After it's published, copy the assigned **32-character
   extension ID**.
3. **Build the Windows installer**, passing that store ID:
   ```powershell
   $env:KIDLIMITER_WEBSTORE_ID="<32-char-id>"; npm run build:installer
   ```
   This produces `dist/KidLimiter-Setup.exe`.
4. **Hand the `.exe` to a parent.** They double-click it, reopen Chrome, and the limiter installs from the Web Store
   and stays locked on (the 🧠 icon appears within a minute).

> Until the extension is actually published to the store, the installer will force-install an ID that doesn't exist
> yet — so Chrome silently does nothing. Publish first, then build the installer with the real ID.

---

## Good to know

This is a **gentle guardrail, not a hardened parental-control product.** It's designed to encourage healthy habits for
cooperative kids, and a determined, tech-savvy child could work around it (e.g. via browser DevTools or by disabling the
extension). For full parental control, pair it with your OS or router's built-in tools.

---

*Made to help kids enjoy YouTube — and walk away from it — happily.*
