// ─── Config ───────────────────────────────────────────────────────────────────
const APP_KEY      = '1ko2h058qpnvrn1';
const REDIRECT_URI = 'https://Stan125.github.io/SpinOff/auth.html';
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
      'Dropbox-API-Arg': JSON.stringify({ path: path })
    }
  });
  if (!res.ok) throw new Error('Download failed for ' + path);
  return res.text();
}

async function dbxDownloadBlob(path) {
  const res = await fetch(DBX_CONTENT + '/files/download', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + getToken(),
      'Dropbox-API-Arg': JSON.stringify({ path: path })
    }
  });
  if (!res.ok) throw new Error('Audio download failed for ' + path);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// ─── Screen routing ───────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(function(s) { s.classList.add('hidden'); });
  var el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

function goHome() {
  releaseWakeLock();
  if (audio) { audio.pause(); audio.src = ''; }
  blobUrls.forEach(function(u) { URL.revokeObjectURL(u); });
  window.location.href = 'index.html';
}

// ─── Class list ───────────────────────────────────────────────────────────────
async function loadClasses() {
  var list = document.getElementById('class-list');
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
      var card = document.createElement('div');
      card.className = 'class-card';
      card.innerHTML =
        '<div class="class-card-name">' + formatFolderName(folder.name) + '</div>' +
        '<div class="class-card-sub">' + folder.name + '</div>' +
        '<div class="class-card-arrow">›</div>';
      card.addEventListener('click', function() { openClass(folder.path_lower); });
      list.appendChild(card);
    });
  } catch (e) {
    list.innerHTML = '<div class="empty-state error">Could not load classes.<br>' + e.message + '</div>';
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
    var rpe        = (parts[4] || '').replace(/rpe\s*/i, '').trim();
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

    tracks.push({ song: song, artist: artist, type: type, bpm: bpm, rpe: rpe,
                  resistance: resistance, audioPath: audioPath, cues: cues, blobUrl: null });
  });
  return tracks;
}

// ─── Runner state ─────────────────────────────────────────────────────────────
var tracks          = [];
var currentTrackIdx = 0;
var currentCueIdx   = -1;
var audio           = null;
var isPlaying       = false;
var blobUrls        = [];
var wakeLock        = null;
var classElapsed    = 0;
var classTimerInterval = null;

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
  audio = document.getElementById('audio-player');
  var title = formatFolderName(folderPath.split('/').pop());
  document.getElementById('class-title').textContent = title;
  document.getElementById('prep-title').textContent  = title;

  showScreen('prep-screen');

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

  // Download audio files one by one, updating status as we go
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
    if (track.rpe) meta.push('RPE ' + track.rpe);
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

function startClass() {
  showScreen('runner-screen');

  audio.addEventListener('ended', function() {
    if (currentTrackIdx < tracks.length - 1) nextTrack();
    else endOfClass();
  });
  audio.addEventListener('timeupdate', function() {
    updateTrackProgress();
    checkCues();
    updateCueCountdown();
  });
  audio.addEventListener('loadedmetadata', updateTrackProgress);

  mountTrack(0);
  startPlayback();
}

// ─── Mount track ──────────────────────────────────────────────────────────────
function mountTrack(idx) {
  currentTrackIdx = idx;
  currentCueIdx   = -1;
  var track = tracks[idx];

  document.getElementById('track-label').textContent    = 'Track ' + (idx + 1) + ' / ' + tracks.length;
  document.getElementById('song-name').textContent      = track.song;
  document.getElementById('song-artist').textContent    = track.artist;
  document.getElementById('track-type-tag').textContent = track.type;
  document.getElementById('meta-bpm').textContent       = track.bpm ? '⚡ ' + track.bpm + ' BPM' : '—';
  document.getElementById('meta-rpe').textContent       = track.rpe ? 'RPE ' + track.rpe : '—';
  document.getElementById('meta-res').textContent       = track.resistance ? 'R' + track.resistance : '—';

  renderIntensityBars(track.resistance);
  renderCueDots(track.cues, -1);

  // Countdown to first cue
  if (track.cues.length) {
    document.getElementById('cue-label').textContent = 'Next cue in';
    document.getElementById('cue-text').textContent  = formatTime(track.cues[0].at);
  } else {
    document.getElementById('cue-label').textContent = 'Cue';
    document.getElementById('cue-text').textContent  = '—';
  }

  var next = tracks[idx + 1];
  document.getElementById('next-song').textContent = next ? next.song + ' — ' + next.artist : 'End of class';
  document.getElementById('next-type').textContent = next ? next.type + ' · RPE ' + next.rpe : '';

  if (track.blobUrl) { audio.src = track.blobUrl; }

  updateClassProgress();
}

// ─── Cue logic ────────────────────────────────────────────────────────────────
function checkCues() {
  var track = tracks[currentTrackIdx];
  if (!track || !track.cues.length) return;
  var t = audio.currentTime;

  var newIdx = -1;
  for (var i = 0; i < track.cues.length; i++) {
    if (t >= track.cues[i].at) newIdx = i;
  }

  if (newIdx !== currentCueIdx) {
    currentCueIdx = newIdx;
    if (newIdx >= 0) {
      document.getElementById('cue-text').innerHTML = renderMarkdown(track.cues[newIdx].text);
      var cueBox = document.getElementById('cue-box');
      cueBox.classList.add('cue-flash');
      setTimeout(function() { cueBox.classList.remove('cue-flash'); }, 600);
    }
    renderCueDots(track.cues, newIdx);
  }
}

function updateCueCountdown() {
  var track = tracks[currentTrackIdx];
  if (!track || !track.cues.length) return;
  var t = audio.currentTime;

  if (currentCueIdx === -1) {
    // Before first cue — count down to it
    var secsLeft = Math.max(0, track.cues[0].at - t);
    document.getElementById('cue-label').textContent = 'Next cue in ' + formatTime(secsLeft);
    return;
  }

  var nextIdx = currentCueIdx + 1;
  if (nextIdx < track.cues.length) {
    var secsLeft2 = Math.max(0, track.cues[nextIdx].at - t);
    document.getElementById('cue-label').textContent = 'Next cue in ' + formatTime(secsLeft2);
  } else {
    document.getElementById('cue-label').textContent = 'Last cue';
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

// ─── Track progress ───────────────────────────────────────────────────────────
function updateTrackProgress() {
  var cur = audio.currentTime || 0;
  var dur = audio.duration   || 0;
  document.getElementById('track-current').textContent  = formatTime(cur);
  document.getElementById('track-duration').textContent = formatTime(dur);
  document.getElementById('track-fill').style.width = (dur > 0 ? (cur / dur * 100) : 0) + '%';
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

function seekTrack(e) {
  if (!audio.duration) return;
  var bar  = document.getElementById('track-bar');
  var rect = bar.getBoundingClientRect();
  var pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audio.currentTime = pct * audio.duration;
}

// ─── Playback ─────────────────────────────────────────────────────────────────
function startPlayback() {
  audio.play().then(function() {
    isPlaying = true;
    document.getElementById('play-btn').textContent = '⏸';
    startClassTimer();
    requestWakeLock();
  }).catch(function(e) {
    // Autoplay blocked by browser — user taps play
    console.log('Autoplay blocked:', e.message);
  });
}

function togglePlay() {
  if (isPlaying) {
    audio.pause();
    document.getElementById('play-btn').textContent = '▶';
    isPlaying = false;
    stopClassTimer();
    releaseWakeLock();
  } else {
    audio.play().catch(function(e) { console.error(e); });
    document.getElementById('play-btn').textContent = '⏸';
    isPlaying = true;
    startClassTimer();
    requestWakeLock();
  }
}

function nextTrack() {
  if (currentTrackIdx < tracks.length - 1) {
    audio.pause();
    mountTrack(currentTrackIdx + 1);
    if (isPlaying) audio.play().catch(function(e) { console.error(e); });
  }
}

function prevTrack() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (currentTrackIdx > 0) {
    audio.pause();
    mountTrack(currentTrackIdx - 1);
    if (isPlaying) audio.play().catch(function(e) { console.error(e); });
  }
}

function endOfClass() {
  isPlaying = false;
  document.getElementById('play-btn').textContent = '▶';
  document.getElementById('cue-label').textContent = 'Done';
  document.getElementById('cue-text').textContent  = 'Great work! Class complete.';
  document.getElementById('class-progress').style.width = '100%';
  stopClassTimer();
  releaseWakeLock();
}

// ─── Class timer ──────────────────────────────────────────────────────────────
function startClassTimer() {
  if (classTimerInterval) return;
  classTimerInterval = setInterval(function() {
    if (!isPlaying) return;
    classElapsed++;
    document.getElementById('class-elapsed').textContent = formatTime(classElapsed);
  }, 1000);
}

function stopClassTimer() {
  clearInterval(classTimerInterval);
  classTimerInterval = null;
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function formatTime(secs) {
  var s = Math.floor(secs);
  var m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}
