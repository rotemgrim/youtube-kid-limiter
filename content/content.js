// Monitors YouTube video play/pause and renders whatever the background tells it to.

function notify(type) {
  chrome.runtime.sendMessage({ type }).catch(() => {});
}

function bind(video) {
  if (video.__klBound) return;
  video.__klBound = true;
  video.addEventListener('play', () => notify('videoPlaying'));
  video.addEventListener('pause', () => notify('videoPaused'));
  video.addEventListener('ended', () => notify('videoPaused'));
  // The video may already be playing (autoplay) before we attached the listener.
  if (!video.paused && !video.ended) notify('videoPlaying');
}

function scan() {
  document.querySelectorAll('video').forEach(bind);
}

scan();
// YouTube is a single-page app; videos are swapped in dynamically.
new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });

// Safety-net poll: if the extension loaded after autoplay (missing the 'play' event),
// or the gauge got removed, re-assert the playing state. Idempotent in the background.
setInterval(() => {
  scan();
  const playing = [...document.querySelectorAll('video')].some((v) => !v.paused && !v.ended && v.currentTime > 0);
  if (playing) notify('videoPlaying');
}, 3000);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd === 'checkVideoStatus') {
    const playing = [...document.querySelectorAll('video')].some((v) => !v.paused && !v.ended);
    sendResponse({ isPlaying: playing });
    return;
  }
  const K = window.__KidLimiter;
  if (!K) return;
  if (msg.cmd === 'showGauge') K.showGauge(msg.remainingMs, msg.totalMs);
  else if (msg.cmd === 'showGaugeFrozen') K.showGaugeFrozen(msg.remainingMs, msg.totalMs);
  else if (msg.cmd === 'showRest') K.showRest(msg.remainingMs, msg.totalMs);
  else if (msg.cmd === 'headsUp') K.showHeadsUp(msg.minutesLeft);
  else if (msg.cmd === 'hideGauge') K.clearAll();
  else if (msg.cmd === 'clear') K.clearAll();
  else if (msg.cmd === 'resume') K.resume();
});

// On (re)load, ask the background what should currently be on screen.
chrome.runtime.sendMessage({ type: 'getState' }).then((r) => {
  const K = window.__KidLimiter;
  if (!r || !K) return;
  if (r.cmd === 'showGauge') K.showGauge(r.remainingMs, r.totalMs);
  else if (r.cmd === 'showGaugeFrozen') K.showGaugeFrozen(r.remainingMs, r.totalMs);
  else if (r.cmd === 'showRest') K.showRest(r.remainingMs, r.totalMs);
  else K.clearAll();
}).catch(() => {});
