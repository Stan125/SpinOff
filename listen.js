// ─── Listen mode ──────────────────────────────────────────────────────────────
// Plays every song from every class back to back, without the class runner.
// Uses a single persistent <audio> element (not Web Audio) so playback keeps
// going with the phone locked, and wires up the Media Session API for
// lock-screen / Control Center controls.
//
// Audio source per song, in priority order:
//   1. IndexedDB 'audio' store — the same offline copies the class runner
//      saves, so a song downloaded for a class is never downloaded again
//   2. Dropbox temporary link — streamed, not stored
//
// Depends on helpers from app.js (dbxPost, idbGet, idbGetAllKeys, idbOpen,
// formatTime, formatFolderName, mimeFromPath).

var AUDIO_EXT_RE  = /\.(m4a|mp3|aac|wav|flac|ogg|opus|webm)$/i;
var TEMP_LINK_TTL = 3.5 * 60 * 60 * 1000;   // Dropbox links live 4 h
var LS_SHUFFLE    = 'spinoff_listen_shuffle';
var LS_LAST       = 'spinoff_listen_last';

var lib        = [];     // [{ path, idbKey, song, artist, className }]
var order      = [];     // lib indices in play order
var pos        = -1;     // position in `order`
var shuffleOn  = false;
var player     = null;
var current    = null;   // { i, url, blob }
var prefetched = null;   // { i, url, blob }
var tempLinks  = {};     // path -> { url, at }
var loadToken  = 0;
var errorRun   = 0;      // consecutive failed tracks — stops runaway skipping

// ─── Library ──────────────────────────────────────────────────────────────────
function parseSongFilename(filename) {
  var base = filename
    .replace(AUDIO_EXT_RE, '')
    .replace(/^\d+\.\s*/, '')
    .replace(/\s*\[\d+(\.\d+)?\s*BPM\]\s*$/i, '')
    .trim();
  var k = base.indexOf(' - ');
  return {
    key:    base.toLowerCase(),
    artist: k > 0 ? base.slice(0, k) : '',
    song:   k > 0 ? base.slice(k + 3) : base
  };
}

function idbGetAll(store) {
  return idbOpen().then(function(db) {
    return new Promise(function(resolve, reject) {
      var req = db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = function() { resolve(req.result); };
      req.onerror   = function() { reject(req.error); };
    });
  });
}

// All audio files sitting directly inside a class folder (skips e.g. raw/).
async function listDropboxAudio() {
  var data = await dbxPost('/files/list_folder', {
    path: DBX_ROOT, recursive: true, include_deleted: false,
    include_mounted_folders: true
  });
  var entries = data.entries;
  while (data.has_more) {
    data = await dbxPost('/files/list_folder/continue', { cursor: data.cursor });
    entries = entries.concat(data.entries);
  }
  return entries
    .filter(function(e) {
      return e['.tag'] === 'file' && AUDIO_EXT_RE.test(e.name) &&
             e.path_lower.split('/').length === 3;
    })
    .map(function(e) {
      return { path: e.path_lower, name: e.name, folder: e.path_display.split('/')[1] };
    });
}

// Offline fallback: songs from classes saved in IndexedDB.
async function listCachedAudio() {
  var classes = await idbGetAll('classes').catch(function() { return []; });
  var out = [];
  classes.forEach(function(c) {
    (c.tracks || []).forEach(function(t) {
      if (!t.audioPath) return;
      out.push({ path: t.audioPath, name: t.audioPath.split('/').pop(),
                 folder: c.folderPath.split('/').pop() });
    });
  });
  return out;
}

async function buildLibrary() {
  var audioKeys = await idbGetAllKeys('audio').catch(function() { return []; });
  var cachedByLower = {};
  audioKeys.forEach(function(k) { cachedByLower[k.toLowerCase()] = k; });

  var files, offline = false;
  try {
    files = await listDropboxAudio();
  } catch (e) {
    console.log('Listen: Dropbox unavailable, using offline songs:', e.message);
    files = await listCachedAudio();
    offline = true;
  }
  files.sort(function(a, b) {
    return a.path.toLowerCase() < b.path.toLowerCase() ? -1 : 1;
  });

  // The same song often appears in several classes — list it once, and
  // prefer a copy that's already stored offline.
  var byKey = {};
  var items = [];
  files.forEach(function(f) {
    var meta   = parseSongFilename(f.name);
    var idbKey = cachedByLower[f.path.toLowerCase()] || null;
    if (offline && !idbKey) return;
    var item = { path: f.path, idbKey: idbKey, song: meta.song, artist: meta.artist,
                 className: formatFolderName(f.folder) };
    var existing = byKey[meta.key];
    if (existing === undefined) {
      byKey[meta.key] = items.length;
      items.push(item);
    } else if (idbKey && !items[existing].idbKey) {
      items[existing] = item;
    }
  });
  return { items: items, offline: offline };
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function initListen() {
  player = document.getElementById('player');
  try { shuffleOn = localStorage.getItem(LS_SHUFFLE) === '1'; } catch (e) {}
  renderShuffle();
  bindPlayerEvents();
  bindMediaSession();

  var res;
  try {
    res = await buildLibrary();
  } catch (e) {
    showListMessage('Could not load songs: ' + e.message, true);
    return;
  }
  lib = res.items;
  if (lib.length === 0) {
    showListMessage(res.offline ? 'Offline, and no songs are stored on this device.'
                                : 'No songs found.', true);
    return;
  }

  var stored = lib.filter(function(t) { return t.idbKey; }).length;
  document.getElementById('listen-summary').textContent =
    lib.length + ' songs · ' + stored + ' on device' + (res.offline ? ' · offline' : '');

  // Start where the last session left off (paused — no autoplay)
  var lastPath = null;
  try { lastPath = localStorage.getItem(LS_LAST); } catch (e) {}
  var startIdx = 0;
  for (var i = 0; i < lib.length; i++) if (lib[i].path === lastPath) { startIdx = i; break; }

  buildOrder(startIdx);
  renderList();
  pos = order.indexOf(startIdx);
  renderNow(startIdx);
  setControlsEnabled(true);
}

function buildOrder(firstIdx) {
  order = lib.map(function(_, i) { return i; });
  if (!shuffleOn) return;
  for (var i = order.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
  }
  if (firstIdx != null) {
    order.splice(order.indexOf(firstIdx), 1);
    order.unshift(firstIdx);
  }
}

// ─── Sources ──────────────────────────────────────────────────────────────────
async function sourceFor(i) {
  var item = lib[i];
  if (item.idbKey) {
    var rec = await idbGet('audio', item.idbKey).catch(function() { return null; });
    if (rec && rec.buffer) {
      var blob = new Blob([rec.buffer], { type: rec.mime || mimeFromPath(item.path) });
      return { i: i, url: URL.createObjectURL(blob), blob: true };
    }
  }
  var cachedLink = tempLinks[item.path];
  if (!cachedLink || Date.now() - cachedLink.at > TEMP_LINK_TTL) {
    var data = await dbxPost('/files/get_temporary_link', { path: item.path });
    cachedLink = tempLinks[item.path] = { url: data.link, at: Date.now() };
  }
  return { i: i, url: cachedLink.url, blob: false };
}

function releaseSource(src) {
  if (src && src.blob) URL.revokeObjectURL(src.url);
}

// Resolve the next song's source ahead of time so that the switch at the end
// of a track is instant — matters when the phone is locked.
function prefetchNext() {
  if (order.length < 2) return;
  var nextI = order[(pos + 1) % order.length];
  if (prefetched && prefetched.i === nextI) return;
  releaseSource(prefetched);
  prefetched = null;
  var token = loadToken;
  sourceFor(nextI).then(function(src) {
    if (token !== loadToken || (prefetched && prefetched.i === nextI)) { releaseSource(src); return; }
    prefetched = src;
  }).catch(function() {});
}

// ─── Playback ─────────────────────────────────────────────────────────────────
async function playAt(p, autoplay) {
  if (!order.length) return;
  var token = ++loadToken;
  pos = ((p % order.length) + order.length) % order.length;
  var i = order[pos];
  renderNow(i);
  try { localStorage.setItem(LS_LAST, lib[i].path); } catch (e) {}

  var src;
  if (prefetched && prefetched.i === i) {
    src = prefetched; prefetched = null;
  } else {
    try {
      src = await sourceFor(i);
    } catch (e) {
      if (token !== loadToken) return;
      console.warn('Listen: could not load', lib[i].path, e);
      onTrackFailed(autoplay);
      return;
    }
  }
  if (token !== loadToken) { releaseSource(src); return; }

  // Switch the element to the new source before revoking the old blob URL,
  // so the old one can't raise an error event that gets blamed on this track.
  var old = current;
  current = src;
  player.src = src.url;
  releaseSource(old);
  if (autoplay) {
    player.play().catch(function(e) { console.warn('Listen: play() rejected:', e); renderPlayState(); });
  }
  prefetchNext();
}

function onTrackFailed(autoplay) {
  markRow(order[pos], 'error');
  errorRun++;
  if (autoplay && errorRun < Math.min(order.length, 5)) {
    playAt(pos + 1, true);
  } else {
    errorRun = 0;
    renderPlayState();
  }
}

function togglePlayListen() {
  if (!order.length) return;
  if (!current) { playAt(pos < 0 ? 0 : pos, true); return; }
  if (player.paused) player.play().catch(function() {});
  else player.pause();
}

function nextListen() {
  if (!order.length) return;
  if (pos + 1 >= order.length && shuffleOn) {
    // Wrapped around — fresh shuffle for the next pass
    releaseSource(prefetched); prefetched = null;
    buildOrder(null);
    playAt(0, true);
    return;
  }
  playAt(pos + 1, true);
}

function prevListen() {
  if (!order.length) return;
  if (current && player.currentTime > 3) { player.currentTime = 0; return; }
  playAt(pos - 1, true);
}

function seekListen(e) {
  if (!current || !isFinite(player.duration)) return;
  var rect = document.getElementById('listen-bar').getBoundingClientRect();
  var pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  player.currentTime = pct * player.duration;
}

function toggleShuffle() {
  shuffleOn = !shuffleOn;
  try { localStorage.setItem(LS_SHUFFLE, shuffleOn ? '1' : '0'); } catch (e) {}
  var curI = order.length ? order[pos] : null;
  buildOrder(curI);
  pos = curI == null ? -1 : order.indexOf(curI);
  releaseSource(prefetched); prefetched = null;
  if (current) prefetchNext();
  renderShuffle();
}

function playLibIdx(i) {
  errorRun = 0;
  playAt(order.indexOf(i), true);
}

function bindPlayerEvents() {
  player.addEventListener('ended', function() { errorRun = 0; nextListen(); });
  player.addEventListener('playing', function() { errorRun = 0; markRow(order[pos], null); });
  player.addEventListener('play', renderPlayState);
  player.addEventListener('pause', renderPlayState);
  player.addEventListener('timeupdate', renderProgress);
  player.addEventListener('loadedmetadata', renderProgress);
  player.addEventListener('error', function() {
    if (!current || player.src !== current.url) return;
    // A streamed link may have expired — drop it so a retry fetches a fresh one
    if (!current.blob) delete tempLinks[lib[current.i].path];
    console.warn('Listen: media error on', lib[current.i].path, player.error);
    onTrackFailed(true);
  });
}

// ─── Media Session (lock screen controls) ────────────────────────────────────
function bindMediaSession() {
  if (!('mediaSession' in navigator)) return;
  var ms = navigator.mediaSession;
  function on(action, fn) { try { ms.setActionHandler(action, fn); } catch (e) {} }
  on('play',          function() { togglePlayListen(); });
  on('pause',         function() { player.pause(); });
  on('previoustrack', prevListen);
  on('nexttrack',     nextListen);
  on('seekto', function(d) {
    if (d.seekTime != null && isFinite(player.duration)) player.currentTime = d.seekTime;
  });
  // Deliberately no seekbackward/seekforward handlers: iOS would show ±10 s
  // buttons on the lock screen instead of previous/next track.
}

function updateMediaMetadata(i) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  var t = lib[i];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.song, artist: t.artist, album: t.className,
    artwork: [{ src: new URL('icon.png', location.href).href, sizes: '192x192', type: 'image/png' }]
  });
}

var lastPositionUpdate = 0;
function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!isFinite(player.duration) || player.duration <= 0) return;
  var now = Date.now();
  if (now - lastPositionUpdate < 1000) return;
  lastPositionUpdate = now;
  try {
    navigator.mediaSession.setPositionState({
      duration: player.duration,
      playbackRate: player.playbackRate || 1,
      position: Math.min(player.currentTime, player.duration)
    });
  } catch (e) {}
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/[&<>"]/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function showListMessage(msg, isError) {
  document.getElementById('listen-list').innerHTML =
    '<div class="empty-state' + (isError ? ' error' : '') + '">' + escHtml(msg) + '</div>';
}

function setControlsEnabled(on) {
  document.querySelectorAll('.listen-ctrl').forEach(function(b) { b.disabled = !on; });
}

function renderList() {
  var list = document.getElementById('listen-list');
  list.innerHTML = '';
  lib.forEach(function(t, i) {
    var row = document.createElement('div');
    row.className = 'prep-track listen-row';
    row.id = 'listen-row-' + i;
    row.innerHTML =
      '<div class="prep-status listen-status ' + (t.idbKey ? 'prep-status-ok' : '') + '"' +
        ' title="' + (t.idbKey ? 'Stored on device' : 'Streams from Dropbox') + '">' +
        (t.idbKey ? '✓' : '☁') + '</div>' +
      '<div class="prep-info">' +
        '<div class="prep-name">' + escHtml(t.song) +
          (t.artist ? '<span class="prep-artist"> — ' + escHtml(t.artist) + '</span>' : '') + '</div>' +
        '<div class="prep-meta">' + escHtml(t.className) + '</div>' +
      '</div>';
    row.addEventListener('click', function() { playLibIdx(i); });
    list.appendChild(row);
  });
}

function markRow(i, state) {
  var row = document.getElementById('listen-row-' + i);
  if (row) row.classList.toggle('listen-row-error', state === 'error');
}

function renderNow(i) {
  var t = lib[i];
  if (!t) return;
  document.getElementById('listen-song').textContent   = t.song;
  document.getElementById('listen-artist').textContent = t.artist || '—';
  document.getElementById('listen-class').textContent  =
    t.className + (t.idbKey ? '' : ' · streaming');
  document.getElementById('listen-pos').textContent    = (pos + 1) + ' / ' + order.length;
  document.querySelectorAll('.listen-row-active').forEach(function(r) { r.classList.remove('listen-row-active'); });
  var row = document.getElementById('listen-row-' + i);
  if (row) {
    row.classList.add('listen-row-active');
    if (document.visibilityState === 'visible') row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  document.getElementById('listen-current').textContent   = '0:00';
  document.getElementById('listen-remaining').textContent = '-0:00';
  document.getElementById('listen-fill').style.width      = '0%';
  updateMediaMetadata(i);
}

function renderProgress() {
  var dur = isFinite(player.duration) ? player.duration : 0;
  var cur = Math.min(player.currentTime || 0, dur);
  document.getElementById('listen-current').textContent   = formatTime(cur);
  document.getElementById('listen-remaining').textContent = '-' + formatTime(dur - cur);
  document.getElementById('listen-fill').style.width      = (dur > 0 ? cur / dur * 100 : 0) + '%';
  updatePositionState();
}

function renderPlayState() {
  var playing = current && !player.paused;
  document.getElementById('listen-play-btn').textContent = playing ? 'PAUSE' : 'PLAY';
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

function renderShuffle() {
  var btn = document.getElementById('listen-shuffle-btn');
  if (btn) {
    btn.classList.toggle('active', shuffleOn);
    btn.setAttribute('aria-pressed', shuffleOn ? 'true' : 'false');
  }
}

function leaveListen() {
  if (player) player.pause();
  releaseSource(current);
  releaseSource(prefetched);
  window.location.href = 'index.html';
}
