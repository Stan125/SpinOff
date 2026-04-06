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

// Download audio from Dropbox, persist to IndexedDB, return a blob URL
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
  return URL.createObjectURL(new Blob([arrayBuf], { type: mime }));
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
        '<div class="class-card-name">' + formatFolderName(folder.name) +
          (isOffline ? '<span class="offline-badge">✓ offline</span>' : '') + '</div>' +
        '<div class="class-card-sub">' + folder.name + '</div>' +
        '<div class="class-card-arrow">›</div>';
      card.addEventListener('click', function() { openClass(folder.path_lower); });
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
      card.innerHTML =
        '<div class="class-card-name">' + formatFolderName(name) +
          '<span class="offline-badge">✓ offline</span></div>' +
        '<div class="class-card-sub">' + name + '</div>' +
        '<div class="class-card-arrow">›</div>';
      card.addEventListener('click', function() { openClass(folderPath); });
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
    var ftp        = ((parts[4] || '').match(/\d+/) || [''])[0];
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

    tracks.push({ song: song, artist: artist, type: type, bpm: bpm, ftp: ftp,
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
          tracks[ci].blobUrl = URL.createObjectURL(new Blob([audioRec.buffer], { type: audioRec.mime }));
          blobUrls.push(tracks[ci].blobUrl);
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
          tracks[i].blobUrl = await dbxDownloadBlob(tracks[i].audioPath);
          blobUrls.push(tracks[i].blobUrl);
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
      return { song: t.song, artist: t.artist, type: t.type, bpm: t.bpm, ftp: t.ftp,
               resistance: t.resistance, audioPath: t.audioPath, cues: t.cues, blobUrl: null };
    });
    idbPut('classes', { folderPath: folderPath, tracks: trackMeta })
      .catch(function(e) { console.warn('IDB class save failed:', e); });
  }

  // ── Pre-decode audio into AudioBuffers while user reads the track list ──────
  // AudioContext created here (may be suspended on iOS — that's fine for decoding).
  // startClass() will unlock and resume it within the user gesture.
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioBuffers = new Array(tracks.length).fill(null);
  await Promise.all(tracks.map(function(track, idx) {
    if (!track.blobUrl) return Promise.resolve();
    return fetch(track.blobUrl)
      .then(function(r) { return r.arrayBuffer(); })
      .then(function(ab) { return audioCtx.decodeAudioData(ab); })
      .then(function(buf) { audioBuffers[idx] = buf; })
      .catch(function(e) { console.warn('Pre-decode failed:', track.song, e); });
  }));

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

// ─── Start class (must be called from a user gesture) ─────────────────────────
function startClass() {
  showScreen('runner-screen');

  // iOS Safari: play a silent buffer synchronously within the user gesture to
  // unlock the AudioContext. Also works if context was created earlier (initRunner).
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  var unlock = audioCtx.createBuffer(1, 1, 22050);
  var unlockSrc = audioCtx.createBufferSource();
  unlockSrc.buffer = unlock;
  unlockSrc.connect(audioCtx.destination);
  unlockSrc.start(0);
  audioCtx.resume();

  if (audioBuffers && audioBuffers.some(function(b) { return b !== null; })) {
    // Already decoded by initRunner — start immediately, no delay
    trackOffsets = [0];
    mountTrack(0);
    playFromOffset(0, 0);
    return;
  }

  // Demo path: decode now (tones are tiny, takes <100 ms)
  audioBuffers = new Array(tracks.length).fill(null);
  document.getElementById('cue-text').textContent  = 'Preparing audio…';
  document.getElementById('cue-label').textContent = '';
  document.getElementById('cue-next-text').textContent = '';

  Promise.all(tracks.map(function(track, i) {
    if (!track.blobUrl) return Promise.resolve();
    return fetch(track.blobUrl)
      .then(function(r) { return r.arrayBuffer(); })
      .then(function(ab) { return audioCtx.decodeAudioData(ab); })
      .then(function(buf) { audioBuffers[i] = buf; })
      .catch(function(e) { console.warn('Decode error', track.song, e); });
  })).then(function() {
    trackOffsets = [0];
    mountTrack(0);
    playFromOffset(0, 0);
  });
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
function playFromOffset(idx, offset) {
  stopSources();
  // Ensure context is running (iOS may suspend it again after a pause)
  if (audioCtx.state !== 'running') audioCtx.resume();

  // Skip tracks without a decoded buffer
  while (idx < tracks.length && !audioBuffers[idx]) {
    trackOffsets[idx + 1] = trackOffsets[idx] || 0;
    idx++;
  }
  if (idx >= tracks.length) { endOfClass(); return; }

  var buffer = audioBuffers[idx];
  var now    = audioCtx.currentTime;
  trackStartCtxTime = now - offset;

  currentSource = audioCtx.createBufferSource();
  currentSource.buffer = buffer;
  currentSource.connect(audioCtx.destination);
  currentSource.start(now, offset);

  isPlaying = true;
  currentTrackIdx = idx;
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
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);
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
  document.getElementById('meta-bpm').textContent       = track.bpm ? '⚡ ' + track.bpm + ' BPM' : '—';
  document.getElementById('meta-res').textContent       = track.resistance ? 'R' + track.resistance : '—';

  var ftpEl = document.getElementById('meta-rpe');
  ftpEl.textContent = track.ftp ? track.ftp + '% FTP' : '—';
  var zone = track.ftp ? ftpZone(track.ftp) : 0;
  ftpEl.className = 'meta-pill' + (zone ? ' zone-' + zone : '');

  var cardEl = document.getElementById('song-card');
  for (var z = 1; z <= 6; z++) cardEl.classList.remove('zone-' + z);
  if (zone) cardEl.classList.add('zone-' + zone);

  renderIntensityBars(track.resistance);
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
  document.getElementById('next-song').textContent = next ? next.song + ' — ' + next.artist : 'End of class';
  document.getElementById('next-type').textContent = next ? next.type + (next.ftp ? ' · ' + next.ftp + '% FTP' : '') : '';

  updateClassProgress();
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

// ─── Progress display ─────────────────────────────────────────────────────────
function updateTrackProgress(t) {
  var buffer = audioBuffers[currentTrackIdx];
  var dur = buffer ? buffer.duration : 0;
  var cur = Math.max(0, Math.min(t, dur));
  document.getElementById('track-current').textContent  = formatTime(cur);
  document.getElementById('track-duration').textContent = formatTime(dur);
  document.getElementById('track-fill').style.width = (dur > 0 ? (cur / dur * 100) : 0) + '%';
  document.getElementById('class-elapsed').textContent =
    formatTime((trackOffsets[currentTrackIdx] || 0) + cur);
}

function updateClassProgress() {
  document.getElementById('class-progress').style.width = (currentTrackIdx / tracks.length * 100) + '%';
}

function renderIntensityBars(resistance) {
  var container = document.getElementById('intensity-bars');
  container.innerHTML = '';
  for (var i = 1; i <= 10; i++) {
    var bar = document.createElement('div');
    bar.className = 'intensity-bar' + (i <= resistance ? ' on' : '');
    bar.style.height = (6 + i * 2.2) + 'px';
    container.appendChild(bar);
  }
  document.getElementById('intensity-val').textContent = resistance ? resistance + ' / 10' : '—';
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
