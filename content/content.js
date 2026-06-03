// Monitors YouTube video play/pause and renders whatever the background tells it to.

function notify(type) {
    chrome.runtime.sendMessage({type}).catch(() => {
    });
}

// The video the user is actually watching. Picking by CSS class is unreliable —
// Shorts preload several <video class="html5-main-video"> elements at once, so
// querySelector would return a paused, off-screen one and time would never count.
// Instead we score every video by (is-playing, is-on-screen, area) and take the best.
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

function mainPlaying() {
    const v = mainVideo();
    return !!(v && !v.paused && !v.ended);
}

// Report based on the MAIN player's state, regardless of which element fired the event.
function report() {
    notify(mainPlaying() ? 'videoPlaying' : 'videoPaused');
}

function bind(video) {
    if (video.__klBound) return;
    video.__klBound = true;
    video.addEventListener('play', report);
    video.addEventListener('pause', report);
    video.addEventListener('ended', report);
    // The video may already be playing (autoplay) before we attached the listener.
    if (mainPlaying()) notify('videoPlaying');
}

function scan() {
    document.querySelectorAll('video').forEach(bind);
}

scan();
// YouTube is a single-page app; videos are swapped in dynamically.
new MutationObserver(scan).observe(document.documentElement, {childList: true, subtree: true});

// Safety-net poll: if the extension loaded after autoplay (missing the 'play' event),
// or the gauge got removed, re-assert the playing state. Idempotent in the background.
setInterval(() => {
    scan();
    if (mainPlaying()) notify('videoPlaying');
}, 3000);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.cmd === 'checkVideoStatus') {
        sendResponse({isPlaying: mainPlaying()});
        return;
    }
    const K = window.__KidLimiter;
    if (!K) return;
    if (msg.cmd === 'showGauge') K.showGauge(msg.remainingMs, msg.totalMs);
    else if (msg.cmd === 'showGaugeFrozen') K.showGaugeFrozen(msg.remainingMs, msg.totalMs);
    else if (msg.cmd === 'showRest') K.showRest(msg.remainingMs, msg.totalMs, msg.treats || [], msg.earnedBonuses || {});
    else if (msg.cmd === 'ready') K.showReady();
    else if (msg.cmd === 'headsUp') K.showHeadsUp(msg.minutesLeft);
    else if (msg.cmd === 'hideGauge') K.clearAll();
    else if (msg.cmd === 'clear') K.clearAll();
    else if (msg.cmd === 'resume') K.resume();
});

// On (re)load, ask the background what should currently be on screen.
chrome.runtime.sendMessage({type: 'getState'}).then((r) => {
    const K = window.__KidLimiter;
    if (!r || !K) return;
    if (r.cmd === 'showGauge') K.showGauge(r.remainingMs, r.totalMs);
    else if (r.cmd === 'showGaugeFrozen') K.showGaugeFrozen(r.remainingMs, r.totalMs);
    else if (r.cmd === 'showRest') K.showRest(r.remainingMs, r.totalMs, r.treats || [], r.earnedBonuses || {});
    else K.clearAll();
}).catch(() => {
});
