// ─── Service Worker ───────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(function(e) { console.log('SW:', e); });
}

// ─── Config ───────────────────────────────────────────────────────────────────
const APP_KEY      = '1ko2h058qpnvrn1';
const REDIRECT_URI = new URL('auth.html', window.location.href).href;
const DBX_ROOT     = '';
const DBX_API      = 'https://api.dropboxapi.com/2';
const DBX_CONTENT  = 'https://content.dropboxapi.com/2';

// ─── Auth ─────────────────────────────────────────────────────────────────────
function startDropboxAuth() {
  const url = 'https://www.dropbox.com/oauth2/authorize'
    + '?client_id=' + APP_KEY
    + '&response_type=token'
    + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI);
  window.location.href = url;
}

function logout() {
  localStorage.removeItem('dbx_token');
  window.location.href = 'index.html';
}

function getToken() {
  return localStorage.getItem('dbx_token');
}

// ─── Dropbox API helpers ───────────────────────────────────────────────────────
// HTTP headers must be ASCII — escape any non-ASCII chars in path JSON
function dropboxArg(obj) {
  return JSON.stringify(obj).replace(/[^\x00-\x7F]/g, function(c) {
    return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

async function dbxPost(endpoint, body) {
  const res = await fetch(DBX_API + endpoint, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + getToken(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Dropbox API error ' + res.status + ': ' + err);
  }
  return res.json();
}

async function dbxDownloadText(path) {
  const res = await fetch(DBX_CONTENT + '/files/download', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + getToken(),
      'Dropbox-API-Arg': dropboxArg({ path: path })
    }
  });
  if (!res.ok) throw new Error('Download failed for ' + path);
  return res.text();
}

var MIME_MAP = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
                 wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
                 opus: 'audio/ogg; codecs=opus', webm: 'audio/webm' };

function mimeFromPath(path) {
  return MIME_MAP[path.split('.').pop().toLowerCase()] || 'audio/mpeg';
}

// Download audio from Dropbox, persist to IndexedDB, return { arrayBuffer, mime }
async function dbxDownloadBlob(path) {
  const res = await fetch(DBX_CONTENT + '/files/download', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + getToken(),
      'Dropbox-API-Arg': dropboxArg({ path: path })
    }
  });
  if (!res.ok) throw new Error('Audio download failed for ' + path);
  var arrayBuf = await res.arrayBuffer();
  var mime = mimeFromPath(path);
  // Persist to IndexedDB so this class works offline next time
  idbPut('audio', { path: path, buffer: arrayBuf, mime: mime })
    .catch(function(e) { console.warn('IDB audio save failed:', e); });
  return { arrayBuffer: arrayBuf, mime: mime };
}

// ─── IndexedDB helpers ────────────────────────────────────────────────────────
var IDB_NAME    = 'spinoff-db';
var IDB_VERSION = 1;

function idbOpen() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains('classes'))
        db.createObjectStore('classes', { keyPath: 'folderPath' });
      if (!db.objectStoreNames.contains('audio'))
        db.createObjectStore('audio', { keyPath: 'path' });
    };
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror   = function(e) { reject(e.target.error); };
  });
}

function idbGet(store, key) {
  return idbOpen().then(function(db) {
    return new Promise(function(resolve, reject) {
      var req = db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = function() { resolve(req.result); };
      req.onerror   = function() { reject(req.error); };
    });
  });
}

function idbPut(store, value) {
  return idbOpen().then(function(db) {
    return new Promise(function(resolve, reject) {
      var req = db.transaction(store, 'readwrite').objectStore(store).put(value);
      req.onsuccess = function() { resolve(); };
      req.onerror   = function() { reject(req.error); };
    });
  });
}

function idbDelete(store, key) {
  return idbOpen().then(function(db) {
    return new Promise(function(resolve, reject) {
      var req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
      req.onsuccess = function() { resolve(); };
      req.onerror   = function() { reject(req.error); };
    });
  });
}

function idbGetAllKeys(store) {
  return idbOpen().then(function(db) {
    return new Promise(function(resolve, reject) {
      var req = db.transaction(store, 'readonly').objectStore(store).getAllKeys();
      req.onsuccess = function() { resolve(req.result); };
      req.onerror   = function() { reject(req.error); };
    });
  });
}

// ─── Screen routing ───────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(function(s) { s.classList.add('hidden'); });
  var el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

async function clearClassCache() {
  var folderPath = sessionStorage.getItem('current_class');
  if (!folderPath) return;
  var btn = document.getElementById('clear-cache-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Clearing…'; }
  await Promise.all(tracks.map(function(t) {
    if (!t.audioPath) return Promise.resolve();
    return idbDelete('audio', t.audioPath).catch(function() {});
  }));
  await idbDelete('classes', folderPath).catch(function() {});
  window.location.reload();
}

async function deleteClassCache(folderPath, cardEl) {
  var cached = await idbGet('classes', folderPath).catch(function() { return null; });
  if (cached && cached.tracks) {
    await Promise.all(cached.tracks.map(function(t) {
      if (!t.audioPath) return Promise.resolve();
      return idbDelete('audio', t.audioPath).catch(function() {});
    }));
  }
  await idbDelete('classes', folderPath).catch(function() {});
  if (cardEl) {
    var badge = cardEl.querySelector('.offline-badge');
    if (badge) badge.remove();
    var delBtn = cardEl.querySelector('.class-delete-btn');
    if (delBtn) delBtn.remove();
  }
}

function goHome() {
  releaseWakeLock();
  stopSources();
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  blobUrls.forEach(function(u) { URL.revokeObjectURL(u); });
  window.location.href = 'index.html';
}

// ─── Class list ───────────────────────────────────────────────────────────────
async function loadClasses() {
  var list = document.getElementById('class-list');
  var cachedKeys = await idbGetAllKeys('classes').catch(function() { return []; });

  try {
    var data = await dbxPost('/files/list_folder', {
      path: DBX_ROOT,
      recursive: false,
      include_media_info: false,
      include_deleted: false,
      include_has_explicit_shared_members: false,
      include_mounted_folders: true
    });
    var folders = data.entries.filter(function(e) { return e['.tag'] === 'folder'; });
    if (folders.length === 0) {
      list.innerHTML = '<div class="empty-state">No classes found in Dropbox/Apps/SpinOffApp</div>';
      return;
    }
    list.innerHTML = '';
    folders.forEach(function(folder) {
      var isOffline = cachedKeys.indexOf(folder.path_lower) !== -1;
      var card = document.createElement('div');
      card.className = 'class-card';
      card.innerHTML =
        '<div class="class-card-info" style="flex:1;min-width:0">' +
          '<div class="class-card-name">' + formatFolderName(folder.name) +
            (isOffline ? '<span class="offline-badge">✓ offline</span>' : '') + '</div>' +
          '<div class="class-card-sub">' + folder.name + '</div>' +
        '</div>' +
        '<div class="class-card-arrow">›</div>';
      card.style.display = 'flex';
      card.style.alignItems = 'center';
      card.addEventListener('click', function() { openClass(folder.path_lower); });
      if (isOffline) {
        var delBtn = document.createElement('button');
        delBtn.className = 'class-delete-btn';
        delBtn.textContent = '✕';
        delBtn.title = 'Delete local cache';
        delBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          deleteClassCache(folder.path_lower, card);
        });
        card.insertBefore(delBtn, card.querySelector('.class-card-arrow'));
      }
      list.appendChild(card);
    });
  } catch (e) {
    // Offline fallback — show whatever is cached in IDB
    if (cachedKeys.length === 0) {
      list.innerHTML = '<div class="empty-state error">No connection and no cached classes.</div>';
      return;
    }
    list.innerHTML = '';
    cachedKeys.forEach(function(folderPath) {
      var name = folderPath.split('/').pop();
      var card = document.createElement('div');
      card.className = 'class-card';
      card.style.display = 'flex';
      card.style.alignItems = 'center';
      card.innerHTML =
        '<div class="class-card-info" style="flex:1;min-width:0">' +
          '<div class="class-card-name">' + formatFolderName(name) +
            '<span class="offline-badge">✓ offline</span></div>' +
          '<div class="class-card-sub">' + name + '</div>' +
        '</div>' +
        '<div class="class-card-arrow">›</div>';
      card.addEventListener('click', function() { openClass(folderPath); });
      var delBtn = document.createElement('button');
      delBtn.className = 'class-delete-btn';
      delBtn.textContent = '✕';
      delBtn.title = 'Delete local cache';
      delBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        deleteClassCache(folderPath, card);
      });
      card.insertBefore(delBtn, card.querySelector('.class-card-arrow'));
      list.appendChild(card);
    });
  }
}

function formatFolderName(name) {
  return name.replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
}

function openClass(folderPath) {
  sessionStorage.setItem('current_class', folderPath);
  window.location.href = 'class.html';
}

// ─── Class txt parser ─────────────────────────────────────────────────────────
function parseTxt(txt, folderPath) {
  var tracks = [];
  var sections = txt.split(/^##\s+/m).filter(function(s) { return s.trim(); });

  sections.forEach(function(section) {
    var lines = section.split('\n')
      .map(function(l) { return l.trim(); })
      .filter(function(l) { return l && !l.startsWith('#'); });
    if (lines.length === 0) return;

    var parts = lines[0].split('|').map(function(p) { return p.trim(); });
    var song       = parts[0] || '?';
    var artist     = parts[1] || '';
    var type       = parts[2] || '';
    var bpm        = (parts[3] || '').replace(/bpm\s*/i, '').trim();
    var ftpStr     = (parts[4] || '').replace(/ftp\s*/i, '').trim();
    var ftps       = ftpStr ? ftpStr.split(/[\/,]/).map(function(s) { return parseInt(s.trim()) || 0; }).filter(Boolean) : [];
    var ftp        = ftps.length > 0 ? String(ftps[0]) : '';
    var resistance = parseInt((parts[5] || '0').replace(/r/i, '')) || 0;
    var filename   = parts[6] || '';
    var audioPath  = filename ? folderPath + '/' + filename : null;

    var cues = [];
    for (var i = 1; i < lines.length; i++) {
      var match = lines[i].match(/^(\d+):(\d{2})\s+(.+)$/);
      if (match) {
        var secs = parseInt(match[1]) * 60 + parseInt(match[2]);
        cues.push({ at: secs, text: match[3] });
      }
    }

    tracks.push({ song: song, artist: artist, type: type, bpm: bpm, ftp: ftp, ftps: ftps,
                  resistance: resistance, audioPath: audioPath, cues: cues, blobUrl: null });
  });
  return tracks;
}

// ─── Runner state ─────────────────────────────────────────────────────────────
var tracks          = [];
var currentTrackIdx = 0;
var currentCueIdx   = -1;
var isPlaying       = false;
var blobUrls        = [];
var wakeLock        = null;
var trackOffsets    = [0];   // cumulative class seconds at the start of each track

// ─── Web Audio engine globals ─────────────────────────────────────────────────
var audioCtx            = null;
var audioBuffers        = [];    // decoded AudioBuffer per track index
var currentSource       = null;  // currently playing AudioBufferSourceNode
var nextSource          = null;  // pre-scheduled next AudioBufferSourceNode
var trackStartCtxTime   = 0;     // audioCtx.currentTime when track position 0 would be
var pausedTrackOffset   = 0;     // track position (seconds) when paused
var rafId               = null;
var nextTransitionTimer = null;

// ─── Wake lock ────────────────────────────────────────────────────────────────
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); }
    catch (e) { console.log('Wake lock:', e.message); }
  }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && isPlaying) requestWakeLock();
});

// ─── Init runner ──────────────────────────────────────────────────────────────
async function initRunner(folderPath) {
  var title = formatFolderName(folderPath.split('/').pop());
  document.getElementById('class-title').textContent = title;
  document.getElementById('prep-title').textContent  = title;
  showScreen('prep-screen');

  // ── Try loading from IndexedDB cache first ──────────────────────────────────
  var cached = await idbGet('classes', folderPath).catch(function() { return null; });
  if (cached) {
    tracks = cached.tracks;
    renderPrepList();
    for (var ci = 0; ci < tracks.length; ci++) {
      if (tracks[ci].audioPath) {
        setPrepStatus(ci, 'loading');
        var audioRec = await idbGet('audio', tracks[ci].audioPath).catch(function() { return null; });
        if (audioRec) {
          // Keep the raw ArrayBuffer so startClass() can decode it directly on
          // the unlocked AudioContext — avoids the blob-URL fetch round-trip
          // that is unreliable on iOS Safari.
          tracks[ci].rawArrayBuffer = audioRec.buffer;
          tracks[ci].mime = audioRec.mime;
          setPrepStatus(ci, 'ok');
        } else {
          setPrepStatus(ci, 'error');
        }
      } else {
        setPrepStatus(ci, 'none');
      }
    }
  } else {
    // ── Download from Dropbox ─────────────────────────────────────────────────
    var txt;
    try {
      txt = await dbxDownloadText(folderPath + '/class.txt');
    } catch (e) {
      document.getElementById('prep-track-list').innerHTML =
        '<div class="empty-state error">Could not load class.txt<br>' + e.message + '</div>';
      return;
    }

    tracks = parseTxt(txt, folderPath);
    if (tracks.length === 0) {
      document.getElementById('prep-track-list').innerHTML =
        '<div class="empty-state error">No tracks found in class.txt</div>';
      return;
    }

    renderPrepList();

    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].audioPath) {
        setPrepStatus(i, 'loading');
        try {
          var dl = await dbxDownloadBlob(tracks[i].audioPath);
          tracks[i].rawArrayBuffer = dl.arrayBuffer;
          tracks[i].mime = dl.mime;
          setPrepStatus(i, 'ok');
        } catch (e) {
          setPrepStatus(i, 'error');
          console.error('Preload failed:', tracks[i].song, e);
        }
      } else {
        setPrepStatus(i, 'none');
      }
    }

    // Save class metadata to IDB (audio was already saved inside dbxDownloadBlob)
    var trackMeta = tracks.map(function(t) {
      return { song: t.song, artist: t.artist, type: t.type, bpm: t.bpm, ftp: t.ftp, ftps: t.ftps || [],
               resistance: t.resistance, audioPath: t.audioPath, cues: t.cues, blobUrl: null };
    });
    idbPut('classes', { folderPath: folderPath, tracks: trackMeta })
      .catch(function(e) { console.warn('IDB class save failed:', e); });
  }

  // Audio is decoded in startClass() after the AudioContext is unlocked by a
  // user gesture. Decoding here (on a suspended context) is unreliable on iOS.
  audioBuffers = new Array(tracks.length).fill(null);

  renderClassOverview();

  var startBtn = document.getElementById('start-btn');
  startBtn.disabled = false;
  startBtn.textContent = 'Start Class ▶';
}

// ─── Prep screen helpers ──────────────────────────────────────────────────────
function renderPrepList() {
  var list = document.getElementById('prep-track-list');
  list.innerHTML = '';
  tracks.forEach(function(track, i) {
    var meta = [];
    if (track.bpm) meta.push(track.bpm + ' BPM');
    if (track.ftp) meta.push(track.ftp + '% FTP');
    if (track.resistance) meta.push('R' + track.resistance);
    meta.push(track.cues.length + ' cue' + (track.cues.length !== 1 ? 's' : ''));

    var row = document.createElement('div');
    row.className = 'prep-track';
    row.innerHTML =
      '<div class="prep-status" id="prep-status-' + i + '">—</div>' +
      '<div class="prep-info">' +
        '<div class="prep-name">' + track.song +
          (track.artist ? '<span class="prep-artist"> — ' + track.artist + '</span>' : '') + '</div>' +
        '<div class="prep-meta">' + meta.join(' · ') + '</div>' +
      '</div>' +
      '<span class="type-tag">' + (track.type || '—') + '</span>';
    list.appendChild(row);
  });
}

function setPrepStatus(i, status) {
  var el = document.getElementById('prep-status-' + i);
  if (!el) return;
  var labels = { loading: '⏳', ok: '✓', error: '✗', none: '—' };
  el.textContent = labels[status] || '?';
  el.className = 'prep-status prep-status-' + status;
}

// ─── iOS silent-switch bypass ──────────────────────────────────────────────────
// Playing through an <audio> element promotes the iOS audio session from the
// default "ambient" category (muted by the ringer/silent switch) to "playback"
// (ignores the switch), so Web Audio output is also unaffected.
function createSilentWavBlob(sampleRate) {
  var numSamples = sampleRate; // 1 second
  var dataSize   = numSamples * 2;
  var buf  = new ArrayBuffer(44 + dataSize);
  var view = new DataView(buf);
  function str(off, s) { for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
  str(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, dataSize, true);
  // samples remain 0 (silence)
  return new Blob([buf], { type: 'audio/wav' });
}

// decodeAudioData wrapper using callbacks — works on all iOS Safari versions.
// The Promise-returning form of decodeAudioData is only guaranteed from iOS 14.1+;
// on older versions it returns undefined, so awaiting it gives undefined (not a buffer).
function decodeAudio(ctx, arrayBuffer) {
  return new Promise(function(resolve, reject) {
    ctx.decodeAudioData(arrayBuffer, resolve, function(e) {
      reject(e || new Error('decodeAudioData failed'));
    });
  });
}

// ─── Start class (must be called from a user gesture) ─────────────────────────
async function startClass() {
  showScreen('runner-screen');

  // Create AudioContext inside the user gesture so iOS starts it in a resumable
  // state. Never reuse a context from initRunner — on iOS Safari, AudioBuffers
  // decoded on a suspended context are unreliable when played back.
  if (audioCtx) { try { audioCtx.close(); } catch (e) {} }
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // iOS unlock: silent 1-sample buffer + explicit resume within the gesture.
  var unlock = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
  var unlockSrc = audioCtx.createBufferSource();
  unlockSrc.buffer = unlock;
  unlockSrc.connect(audioCtx.destination);
  unlockSrc.start(0);
  await audioCtx.resume();

  // iOS silent-switch bypass: play silent WAV through an <audio> element within
  // the same user gesture to promote the session to "playback" category so that
  // Web Audio is not muted by the physical ringer/silent switch.
  try {
    var silentBlob = createSilentWavBlob(audioCtx.sampleRate);
    var silentUrl  = URL.createObjectURL(silentBlob);
    var silentEl   = document.createElement('audio');
    silentEl.src   = silentUrl;
    silentEl.play().catch(function() {});
    setTimeout(function() { URL.revokeObjectURL(silentUrl); }, 6000);
  } catch (e) { console.warn('Silent audio bypass failed:', e); }

  // Decode track 0 first so playback starts with minimal delay, then decode
  // the remaining tracks in the background while the class is running.
  audioBuffers = new Array(tracks.length).fill(null);
  document.getElementById('cue-text').textContent  = 'Preparing audio…';
  document.getElementById('cue-label').textContent = '';
  document.getElementById('cue-next-text').textContent = '';

  // Helper: get an ArrayBuffer for a track — prefers rawArrayBuffer (IDB cache
  // path) to avoid the blob-URL fetch round-trip that fails silently on iOS.
  function trackArrayBuffer(track) {
    if (track.rawArrayBuffer) {
      var ab = track.rawArrayBuffer;
      track.rawArrayBuffer = null;   // detached after decodeAudioData; clear ref
      return Promise.resolve(ab);
    }
    if (track.blobUrl) {
      return fetch(track.blobUrl).then(function(r) { return r.arrayBuffer(); });
    }
    return Promise.resolve(null);
  }

  // Decode the first track that actually has audio so playback can start
  // immediately, then decode the rest in the background.
  var firstAudioIdx = -1;
  for (var fi = 0; fi < tracks.length; fi++) {
    if (tracks[fi].rawArrayBuffer || tracks[fi].blobUrl) { firstAudioIdx = fi; break; }
  }
  if (firstAudioIdx >= 0) {
    try {
      var ab0 = await trackArrayBuffer(tracks[firstAudioIdx]);
      if (ab0) audioBuffers[firstAudioIdx] = await decodeAudio(audioCtx, ab0);
    } catch (e) {
      console.error('Decode error track ' + firstAudioIdx + ':', e);
      document.getElementById('cue-text').textContent  = 'Audio error: ' + (e && e.message ? e.message : String(e));
      document.getElementById('cue-label').textContent = 'Format may be unsupported on this device';
      return;
    }
  } else {
    document.getElementById('cue-text').textContent  = 'No audio found';
    document.getElementById('cue-label').textContent = 'Check that tracks have audio files';
    return;
  }

  trackOffsets = [0];
  playFromOffset(0, 0);

  // Decode remaining tracks in the background (they'll be ready before needed).
  for (var i = 0; i < tracks.length; i++) {
    if (i === firstAudioIdx) continue;   // already decoded above
    (function(idx) {
      trackArrayBuffer(tracks[idx])
        .then(function(ab) { return ab ? decodeAudio(audioCtx, ab) : null; })
        .then(function(buf) { if (buf) audioBuffers[idx] = buf; })
        .catch(function(e) { console.warn('Decode error track ' + idx + ':', e); });
    })(i);
  }
}

// ─── Web Audio engine ─────────────────────────────────────────────────────────
function stopSources() {
  if (nextTransitionTimer) { clearTimeout(nextTransitionTimer); nextTransitionTimer = null; }
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (currentSource) { try { currentSource.stop(); } catch (e) {} currentSource = null; }
  if (nextSource)    { try { nextSource.stop();    } catch (e) {} nextSource = null; }
}

// Start playing from track `idx` at position `offset` seconds.
// Schedules the following track at an exact sample boundary for gapless playback.
async function playFromOffset(idx, offset) {
  stopSources();
  // Ensure context is running (iOS may suspend it again after a pause)
  if (audioCtx.state !== 'running') await audioCtx.resume();

  // Skip tracks without a decoded buffer
  while (idx < tracks.length && !audioBuffers[idx]) {
    trackOffsets[idx + 1] = trackOffsets[idx] || 0;
    idx++;
  }
  if (idx >= tracks.length) { endOfClass(); return; }

  // Update track state and UI before scheduling audio so the song card always
  // reflects the track that is actually playing (fixes Next button display bug).
  currentTrackIdx = idx;
  currentCueIdx   = -1;
  mountTrack(idx);

  var buffer = audioBuffers[idx];
  var now    = audioCtx.currentTime;
  trackStartCtxTime = now - offset;

  currentSource = audioCtx.createBufferSource();
  currentSource.buffer = buffer;
  currentSource.connect(audioCtx.destination);
  currentSource.start(now, offset);

  isPlaying = true;
  pausedTrackOffset = 0;
  document.getElementById('play-btn').textContent = 'PAUSE';
  requestWakeLock();
  startRaf();
  scheduleNextSource(idx);
}

// Pre-schedule the next track and set a timer to update the UI at the transition point.
function scheduleNextSource(idx) {
  var buffer = audioBuffers[idx];
  if (!buffer) return;

  // Find the next track that has audio
  var nextIdx = idx + 1;
  var audioNextIdx = nextIdx;
  while (audioNextIdx < tracks.length && !audioBuffers[audioNextIdx]) audioNextIdx++;

  // When (in audioCtx time) track idx ends
  var nextStartCtxTime = trackStartCtxTime + buffer.duration;
  var msUntilNext = (nextStartCtxTime - audioCtx.currentTime) * 1000;

  // Sample-accurate: start next audio node exactly when current one ends
  if (audioNextIdx < tracks.length) {
    nextSource = audioCtx.createBufferSource();
    nextSource.buffer = audioBuffers[audioNextIdx];
    nextSource.connect(audioCtx.destination);
    nextSource.start(nextStartCtxTime, 0);
  }

  // UI update fires at the same moment (wall-clock approximation — audio is already locked in)
  nextTransitionTimer = setTimeout(function() {
    nextTransitionTimer = null;
    if (nextIdx >= tracks.length) { endOfClass(); return; }

    // Fill in offsets for any skipped (no-audio) tracks
    for (var i = idx; i < audioNextIdx; i++) {
      trackOffsets[i + 1] = (trackOffsets[i] || 0) + (audioBuffers[i] ? audioBuffers[i].duration : 0);
    }

    // The pre-scheduled nextSource is now the active source
    currentSource = nextSource;
    nextSource = null;
    trackStartCtxTime = nextStartCtxTime;
    currentTrackIdx = audioNextIdx < tracks.length ? audioNextIdx : nextIdx;
    currentCueIdx = -1;
    mountTrack(currentTrackIdx);

    if (audioNextIdx < tracks.length) {
      scheduleNextSource(currentTrackIdx);
    } else {
      // Last track's audio just started (no further tracks) — wait for it to finish
      endOfClass();
    }
  }, Math.max(0, msUntilNext));
}

function startRaf() {
  if (rafId) cancelAnimationFrame(rafId);
  function loop() {
    if (!isPlaying || !audioCtx) return;
    var t = audioCtx.currentTime - trackStartCtxTime;
    updateTrackProgress(t);
    checkCues(t);
    updateCueCountdown(t);
    fillNextDuration();
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);
}

// Keep next-duration and song-countdown in sync every frame.
// mountTrack() may run before background decode finishes, leaving these empty;
// the RAF loop fills them in as soon as each buffer is available.
function fillNextDuration() {
  var el = document.getElementById('next-duration');
  if (el) {
    var buf = audioBuffers[currentTrackIdx + 1];
    var val = buf ? formatTime(buf.duration) : '';
    if (el.textContent !== val) el.textContent = val;
  }
}

// ─── Zone colors ──────────────────────────────────────────────────────────────
var ZONE_HEX = ['', '#c8c8c8', '#888892', '#1a5cc2', '#1e7d3a', '#c89600', '#b81a1a'];

// Semi-transparent backgrounds/borders for card coloring
var ZONE_CARD_BG = [
  '',
  'rgba(180,180,180,0.22)',
  'rgba(100,100,110,0.18)',
  'rgba(26,92,194,0.13)',
  'rgba(30,125,58,0.13)',
  'rgba(200,134,10,0.16)',
  'rgba(184,26,26,0.13)'
];
var ZONE_CARD_BORDER = [
  '',
  'rgba(180,180,180,0.45)',
  'rgba(100,100,110,0.38)',
  'rgba(26,92,194,0.38)',
  'rgba(30,125,58,0.38)',
  'rgba(200,134,10,0.42)',
  'rgba(184,26,26,0.38)'
];

function zoneColorHex(ftpPct) {
  return ZONE_HEX[ftpZone(ftpPct)] || '#c8c8c8';
}

// Returns { bg, border } for a next-card given an array of FTP values
function nextCardStyle(ftps) {
  if (!ftps || ftps.length === 0) return { bg: '', border: '' };
  if (ftps.length === 1) {
    var z = ftpZone(ftps[0]);
    return { bg: ZONE_CARD_BG[z], border: ZONE_CARD_BORDER[z] };
  }
  // Horizontal stripes, one per zone
  var stops = ftps.map(function(f, i) {
    var bg = ZONE_CARD_BG[ftpZone(f)];
    var p0 = (i / ftps.length * 100).toFixed(1) + '%';
    var p1 = ((i + 1) / ftps.length * 100).toFixed(1) + '%';
    return bg + ' ' + p0 + ' ' + p1;
  }).join(', ');
  return {
    bg: 'linear-gradient(to right, ' + stops + ')',
    border: ZONE_CARD_BORDER[ftpZone(ftps[0])]
  };
}

// ─── Mount track (UI only) ────────────────────────────────────────────────────
function mountTrack(idx) {
  currentTrackIdx = idx;
  currentCueIdx   = -1;
  var track = tracks[idx];

  document.getElementById('track-label').textContent    = 'Track ' + (idx + 1) + ' / ' + tracks.length;
  document.getElementById('song-name').textContent      = track.song;
  document.getElementById('song-artist').textContent    = track.artist;
  document.getElementById('track-type-tag').textContent = track.type;
  document.getElementById('meta-bpm').textContent       = track.bpm ? track.bpm + ' BPM' : '—';

  // Multi-zone FTP pill
  var ftps = track.ftps && track.ftps.length ? track.ftps : (track.ftp ? [parseInt(track.ftp)] : []);
  var ftpEl = document.getElementById('meta-rpe');
  if (ftps.length === 0) {
    ftpEl.textContent = '—';
    ftpEl.className = 'meta-pill';
  } else {
    ftpEl.textContent = ftps.map(function(f) { return f + '%'; }).join('/') + ' FTP';
    ftpEl.className = 'meta-pill zone-' + ftpZone(ftps[0]);
  }

  // Zone strip — solid or gradient for multi-zone
  var strip = document.getElementById('song-zone-strip');
  if (strip) {
    if (ftps.length === 0) {
      strip.style.background = 'var(--accent)';
    } else if (ftps.length === 1) {
      strip.style.background = zoneColorHex(ftps[0]);
    } else {
      var stops = ftps.map(function(f, i) {
        var pct0 = (i / ftps.length * 100).toFixed(1) + '%';
        var pct1 = ((i + 1) / ftps.length * 100).toFixed(1) + '%';
        return zoneColorHex(f) + ' ' + pct0 + ' ' + pct1;
      }).join(', ');
      strip.style.background = 'linear-gradient(to bottom, ' + stops + ')';
    }
  }

  document.getElementById('song-countdown').textContent = '—';
  renderCueDots(track.cues, -1);

  document.getElementById('cue-text').textContent = 'Get ready…';
  if (track.cues.length) {
    document.getElementById('cue-label').textContent   = 'Next cue in ' + formatTime(track.cues[0].at);
    document.getElementById('cue-next-text').innerHTML = renderMarkdown(track.cues[0].text);
  } else {
    document.getElementById('cue-label').textContent    = '—';
    document.getElementById('cue-next-text').textContent = '—';
  }

  var next = tracks[idx + 1];
  var nextCardEl = document.getElementById('next-card');
  document.getElementById('next-song').textContent = next ? next.song + ' — ' + next.artist : 'End of class';

  if (next) {
    var nextFtps = next.ftps && next.ftps.length ? next.ftps : (next.ftp ? [parseInt(next.ftp)] : []);
    var nextMeta = [];
    if (next.type) nextMeta.push(next.type);
    if (nextFtps.length) nextMeta.push(nextFtps.map(function(f) { return f + '%'; }).join('/') + ' FTP');
    document.getElementById('next-type').textContent = nextMeta.join(' · ');
    document.getElementById('next-duration').textContent =
      audioBuffers[idx + 1] ? formatTime(audioBuffers[idx + 1].duration) : '';
    if (nextCardEl) {
      var ns = nextCardStyle(nextFtps);
      nextCardEl.style.background  = ns.bg;
      nextCardEl.style.borderColor = ns.border;
    }
  } else {
    document.getElementById('next-type').textContent    = '';
    document.getElementById('next-duration').textContent = '';
    if (nextCardEl) { nextCardEl.style.background = ''; nextCardEl.style.borderColor = ''; }
  }

  updateClassProgress();
  updateClassOverview(idx);
}

// ─── Cue logic ────────────────────────────────────────────────────────────────
function checkCues(t) {
  var track = tracks[currentTrackIdx];
  if (!track || !track.cues.length) return;

  var newIdx = -1;
  for (var i = 0; i < track.cues.length; i++) {
    if (t >= track.cues[i].at) newIdx = i;
  }

  if (newIdx !== currentCueIdx) {
    currentCueIdx = newIdx;
    if (newIdx >= 0) {
      document.getElementById('cue-text').innerHTML = renderMarkdown(track.cues[newIdx].text);
      var upcoming = track.cues[newIdx + 1];
      if (upcoming) {
        document.getElementById('cue-next-text').innerHTML = renderMarkdown(upcoming.text);
      } else {
        var nextTrk = tracks[currentTrackIdx + 1];
        document.getElementById('cue-next-text').innerHTML =
          nextTrk && nextTrk.cues.length ? renderMarkdown(nextTrk.cues[0].text) : '—';
      }
      var cueBox = document.getElementById('cue-box');
      cueBox.classList.add('cue-flash');
      setTimeout(function() { cueBox.classList.remove('cue-flash'); }, 600);
    }
    renderCueDots(track.cues, newIdx);
  }
}

function updateCueCountdown(t) {
  var track = tracks[currentTrackIdx];
  if (!track || !track.cues.length) return;

  if (currentCueIdx === -1) {
    document.getElementById('cue-label').textContent =
      'Next cue in ' + formatTime(Math.max(0, track.cues[0].at - t));
    return;
  }
  var nextIdx = currentCueIdx + 1;
  if (nextIdx < track.cues.length) {
    document.getElementById('cue-label').textContent =
      'Next cue in ' + formatTime(Math.max(0, track.cues[nextIdx].at - t));
  } else {
    var nextTrk = tracks[currentTrackIdx + 1];
    document.getElementById('cue-label').textContent =
      nextTrk ? 'Up next: ' + nextTrk.song : 'Last cue';
  }
}

function renderMarkdown(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function renderCueDots(cues, activeIdx) {
  var container = document.getElementById('cue-dots');
  container.innerHTML = '';
  cues.forEach(function(_, i) {
    var dot = document.createElement('div');
    dot.className = 'cue-dot' + (i === activeIdx ? ' active' : i < activeIdx ? ' done' : '');
    container.appendChild(dot);
  });
}

// ─── Remaining-cues modal ────────────────────────────────────────────────────
function showCueList() {
  var body = document.getElementById('cue-list-body');
  body.innerHTML = '';

  for (var i = currentTrackIdx; i < tracks.length; i++) {
    var track = tracks[i];
    var firstCue = (i === currentTrackIdx) ? currentCueIdx + 1 : 0;

    var header = document.createElement('div');
    header.className = 'cue-list-track-header' + (i === currentTrackIdx ? ' current' : '');
    header.textContent = 'Track ' + (i + 1) + ' — ' + track.song;
    body.appendChild(header);

    var remaining = track.cues.slice(firstCue);
    if (remaining.length === 0) {
      var none = document.createElement('div');
      none.className = 'cue-list-none';
      none.textContent = i === currentTrackIdx ? 'No more cues this track' : 'No cues';
      body.appendChild(none);
    } else {
      remaining.forEach(function(cue) {
        var row = document.createElement('div');
        row.className = 'cue-list-row';
        row.innerHTML =
          '<span class="cue-list-time">' + formatTime(cue.at) + '</span>' +
          '<span class="cue-list-text">' + renderMarkdown(cue.text) + '</span>';
        body.appendChild(row);
      });
    }
  }

  document.getElementById('cue-list-modal').classList.remove('hidden');
}

function hideCueList() {
  document.getElementById('cue-list-modal').classList.add('hidden');
}

// ─── Progress display ─────────────────────────────────────────────────────────
function updateTrackProgress(t) {
  var buffer = audioBuffers[currentTrackIdx];
  var dur = buffer ? buffer.duration : 0;
  var cur = Math.max(0, Math.min(t, dur));
  var remaining = Math.max(0, dur - cur);
  document.getElementById('track-current').textContent   = formatTime(cur);
  document.getElementById('track-remaining').textContent = '-' + formatTime(remaining);
  document.getElementById('song-countdown').textContent  = '-' + formatTime(remaining);
  document.getElementById('track-fill').style.width = (dur > 0 ? (cur / dur * 100) : 0) + '%';
  document.getElementById('class-elapsed').textContent =
    formatTime((trackOffsets[currentTrackIdx] || 0) + cur);
}

function updateClassProgress() {
  document.getElementById('class-progress').style.width = (currentTrackIdx / tracks.length * 100) + '%';
}

// ─── Class intensity overview ─────────────────────────────────────────────────
function renderClassOverview() {
  var container = document.getElementById('class-overview');
  if (!container) return;
  container.innerHTML = '';
  tracks.forEach(function(track, i) {
    var col = document.createElement('div');
    col.className = 'overview-col';
    col.id = 'overview-col-' + i;

    var ftps = track.ftps && track.ftps.length ? track.ftps : (track.ftp ? [parseInt(track.ftp)] : []);
    var maxFtp = ftps.length > 0 ? Math.max.apply(null, ftps) : 0;

    // Height: proportional to max FTP%, mapped from 0-150 → 16-56px
    var h = maxFtp > 0 ? Math.max(16, Math.min(56, maxFtp / 150 * 56)) : 16;
    col.style.height = h + 'px';

    if (ftps.length === 0) {
      col.style.background = 'rgba(0,0,0,0.08)';
    } else if (ftps.length === 1) {
      col.style.background = zoneColorHex(ftps[0]);
    } else {
      // Horizontal stripes (vertical split) for multi-zone
      var stops = ftps.map(function(f, idx) {
        var p0 = (idx / ftps.length * 100).toFixed(1) + '%';
        var p1 = ((idx + 1) / ftps.length * 100).toFixed(1) + '%';
        return zoneColorHex(f) + ' ' + p0 + ' ' + p1;
      }).join(', ');
      col.style.background = 'linear-gradient(to right, ' + stops + ')';
    }

    container.appendChild(col);
  });
}

function updateClassOverview(activeIdx) {
  var cols = document.querySelectorAll('.overview-col');
  cols.forEach(function(col, i) {
    col.classList.toggle('overview-active', i === activeIdx);
  });
}

// ─── Playback controls ────────────────────────────────────────────────────────
function togglePlay() {
  if (!audioCtx) return;
  if (isPlaying) {
    // Record current position before stopping
    pausedTrackOffset = audioCtx.currentTime - trackStartCtxTime;
    stopSources();
    isPlaying = false;
    document.getElementById('play-btn').textContent = 'PLAY';
    releaseWakeLock();
  } else {
    playFromOffset(currentTrackIdx, pausedTrackOffset);
  }
}

function nextTrack() {
  if (!audioCtx) return;
  var nextIdx = currentTrackIdx + 1;
  if (nextIdx >= tracks.length) return;
  // Ensure offset is recorded
  if (!trackOffsets[nextIdx]) {
    trackOffsets[nextIdx] = (trackOffsets[currentTrackIdx] || 0) +
      (audioBuffers[currentTrackIdx] ? audioBuffers[currentTrackIdx].duration : 0);
  }
  if (isPlaying) {
    playFromOffset(nextIdx, 0);
  } else {
    currentTrackIdx = nextIdx;
    currentCueIdx = -1;
    pausedTrackOffset = 0;
    mountTrack(nextIdx);
  }
}

function prevTrack() {
  if (!audioCtx) return;
  var t = isPlaying ? (audioCtx.currentTime - trackStartCtxTime) : pausedTrackOffset;
  var targetIdx = (t > 3 || currentTrackIdx === 0) ? currentTrackIdx : currentTrackIdx - 1;
  if (isPlaying) {
    playFromOffset(targetIdx, 0);
  } else {
    currentTrackIdx = targetIdx;
    currentCueIdx = -1;
    pausedTrackOffset = 0;
    mountTrack(targetIdx);
  }
}

function seekTrack(e) {
  if (!audioCtx || !audioBuffers[currentTrackIdx]) return;
  var bar  = document.getElementById('track-bar');
  var rect = bar.getBoundingClientRect();
  var pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  var newOffset = pct * audioBuffers[currentTrackIdx].duration;
  if (isPlaying) {
    playFromOffset(currentTrackIdx, newOffset);
  } else {
    pausedTrackOffset = newOffset;
    updateTrackProgress(newOffset);
  }
}

function endOfClass() {
  isPlaying = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  document.getElementById('play-btn').textContent = 'PLAY';
  document.getElementById('cue-label').textContent = 'Done';
  document.getElementById('cue-text').textContent  = 'Great work! Class complete.';
  document.getElementById('class-progress').style.width = '100%';
  releaseWakeLock();
}

// ─── FTP zone ─────────────────────────────────────────────────────────────────
function ftpZone(ftpPct) {
  var p = parseInt(ftpPct) || 0;
  if (p < 55)  return 1;  // white   — recovery
  if (p < 75)  return 2;  // grey    — endurance
  if (p < 90)  return 3;  // blue    — tempo
  if (p < 105) return 4;  // green   — threshold
  if (p < 120) return 5;  // yellow  — VO2 max
  return 6;               // red     — anaerobic
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function formatTime(secs) {
  var s = Math.floor(Math.max(0, secs));
  var m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}
