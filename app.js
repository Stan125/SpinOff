// ─── Config ───────────────────────────────────────────────────────────────────
const APP_KEY      = '1ko2h058qpnvrn1';
const REDIRECT_URI = 'https://Stan125.github.io/SpinOff/auth.html';
const DBX_ROOT     = '/Apps/SpinOffApp (1)';
const DBX_API      = 'https://api.dropboxapi.com/2';
const DBX_CONTENT  = 'https://content.dropboxapi.com/2';

// ─── Auth ─────────────────────────────────────────────────────────────────────
function startDropboxAuth() {
  const url = `https://www.dropbox.com/oauth2/authorize`
    + `?client_id=${APP_KEY}`
    + `&response_type=token`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
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
    throw new Error(`Dropbox API error ${res.status}: ${err}`);
  }
  return res.json();
}

async function dbxDownloadText(path) {
  const res = await fetch(DBX_CONTENT + '/files/download', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + getToken(),
      'Dropbox-API-Arg': JSON.stringify({ path })
    }
  });
  if (!res.ok) throw new Error('Download failed for ' + path);
  return res.text();
}

// Download audio file as a blob URL for offline/gapless playback
async function dbxDownloadBlob(path) {
  const res = await fetch(DBX_CONTENT + '/files/download', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + getToken(),
      'Dropbox-API-Arg': JSON.stringify({ path })
    }
  });
  if (!res.ok) throw new Error('Audio download failed for ' + path);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// ─── Screen routing ───────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

function goHome() {
  releaseWakeLock();
  if (audio) { audio.pause(); audio.src = ''; }
  blobUrls.forEach(url => URL.revokeObjectURL(url));
  window.location.href = 'index.html';
}

// ─── Class list ───────────────────────────────────────────────────────────────
async function loadClasses() {
  const list = document.getElementById('class-list');
  try {
    const data = await dbxPost('/files/list_folder', {
      path: DBX_ROOT,
      recursive: false,
      include_media_info: false,
      include_deleted: false
    });
    const folders = data.entries.filter(e => e['.tag'] === 'folder');
    if (folders.length === 0) {
      list.innerHTML = '<div class="empty-state">No classes found.<br>Add a folder to Dropbox/Apps/SpinOffApp</div>';
      return;
    }
    list.innerHTML = '';
    for (const folder of folders) {
      const card = document.createElement('div');
      card.className = 'class-card';
      card.innerHTML = `
        <div class="class-card-name">${formatFolderName(folder.name)}</div>
        <div class="class-card-sub">${folder.name}</div>
        <div class="class-card-arrow">›</div>
      `;
      card.addEventListener('click', () => openClass(folder.path_lower));
      list.appendChild(card);
    }
  } catch (e) {
    list.innerHTML = `<div class="empty-state error">Could not load classes.<br>${e.message}</div>`;
  }
}

function formatFolderName(name) {
  return name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function openClass(folderPath) {
  sessionStorage.setItem('current_class', folderPath);
  window.location.href = 'class.html';
}

// ─── Class txt parser ─────────────────────────────────────────────────────────
function parseTxt(txt, folderPath) {
  const tracks = [];
  const sections = txt.split(/^##\s+/m).filter(s => s.trim());

  for (const section of sections) {
    const lines = section.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (lines.length === 0) continue;

    const header = lines[0];
    const parts  = header.split('|').map(p => p.trim());

    const song       = parts[0] || '?';
    const artist     = parts[1] || '';
    const type       = parts[2] || '';
    const bpm        = (parts[3] || '').replace(/bpm\s*/i, '').trim();
    const rpe        = (parts[4] || '').replace(/rpe\s*/i, '').trim();
    const resistance = parseInt((parts[5] || '0').replace(/r/i, '')) || 0;
    const filename   = parts[6] || '';
    const audioPath  = filename ? `${folderPath}/${filename}` : null;

    const cues = [];
    for (let i = 1; i < lines.length; i++) {
      const match = lines[i].match(/^(\d+):(\d{2})\s+(.+)$/);
      if (match) {
        const secs = parseInt(match[1]) * 60 + parseInt(match[2]);
        cues.push({ at: secs, text: match[3] });
      }
    }

    tracks.push({ song, artist, type, bpm, rpe, resistance, audioPath, cues, blobUrl: null });
  }
  return tracks;
}

// ─── Runner state ─────────────────────────────────────────────────────────────
let tracks          = [];
let currentTrackIdx = 0;
let currentCueIdx   = -1;
let audio           = null;
let isPlaying       = false;
let classFolder     = '';
let blobUrls        = [];
let wakeLock        = null;
let classElapsed    = 0;
let classTimerInterval = null;

// ─── Wake lock ────────────────────────────────────────────────────────────────
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); }
    catch (e) { console.log('Wake lock unavailable:', e.message); }
  }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isPlaying) requestWakeLock();
});

// ─── Init runner ──────────────────────────────────────────────────────────────
async function initRunner(folderPath) {
  classFolder = folderPath;
  audio = document.getElementById('audio-player');
  document.getElementById('class-title').textContent = formatFolderName(folderPath.split('/').pop());

  let txt;
  try {
    txt = await dbxDownloadText(folderPath + '/class.txt');
  } catch (e) {
    alert('Could not load class.txt: ' + e.message);
    goHome(); return;
  }

  tracks = parseTxt(txt, folderPath);
  if (tracks.length === 0) { alert('No tracks found in class.txt'); goHome(); return; }

  // Show loading UI while preloading all audio
  setCueDisplay('loading', 'Downloading track 1 / ' + tracks.length + '…');
  document.getElementById('play-btn').disabled = true;

  await preloadAllTracks();

  document.getElementById('play-btn').disabled = false;

  // Wire audio events
  audio.addEventListener('ended', () => {
    if (currentTrackIdx < tracks.length - 1) nextTrack();
    else endOfClass();
  });
  audio.addEventListener('timeupdate', () => {
    updateTrackProgress();
    checkCues();
    updateCueCountdown();
  });
  audio.addEventListener('loadedmetadata', updateTrackProgress);

  // Mount and immediately start playing track 1
  mountTrack(0);
  startPlayback();
}

// ─── Preloading — downloads all tracks upfront ────────────────────────────────
async function preloadAllTracks() {
  for (let i = 0; i < tracks.length; i++) {
    setCueDisplay('loading', `Downloading track ${i + 1} / ${tracks.length}…`);
    const track = tracks[i];
    if (track.audioPath) {
      try {
        track.blobUrl = await dbxDownloadBlob(track.audioPath);
        blobUrls.push(track.blobUrl);
      } catch (e) {
        console.error('Preload failed for', track.song, e);
      }
    }
  }
}

// ─── Mount track (instant — blob already in memory) ───────────────────────────
function mountTrack(idx) {
  currentTrackIdx = idx;
  currentCueIdx   = -1;
  const track = tracks[idx];

  document.getElementById('track-label').textContent    = `Track ${idx + 1} / ${tracks.length}`;
  document.getElementById('song-name').textContent      = track.song;
  document.getElementById('song-artist').textContent    = track.artist;
  document.getElementById('track-type-tag').textContent = track.type;
  document.getElementById('meta-bpm').textContent       = track.bpm ? `⚡ ${track.bpm} BPM` : '—';
  document.getElementById('meta-rpe').textContent       = track.rpe ? `RPE ${track.rpe}` : '—';
  document.getElementById('meta-res').textContent       = track.resistance ? `R${track.resistance}` : '—';

  renderIntensityBars(track.resistance);
  renderCueDots(track.cues, -1);

  // Show countdown to first cue before audio starts
  if (track.cues.length) {
    setCueDisplay('Next cue in', formatTime(track.cues[0].at));
  } else {
    setCueDisplay('Cue', '—');
  }

  const next = tracks[idx + 1];
  document.getElementById('next-song').textContent = next ? `${next.song} — ${next.artist}` : 'End of class';
  document.getElementById('next-type').textContent = next ? `${next.type} · RPE ${next.rpe}` : '';

  if (track.blobUrl) { audio.src = track.blobUrl; audio.load(); }

  updateClassProgress();
}

// ─── Cue checking ─────────────────────────────────────────────────────────────
function checkCues() {
  const track = tracks[currentTrackIdx];
  if (!track || !track.cues.length) return;
  const t = audio.currentTime;

  let newIdx = -1;
  for (let i = 0; i < track.cues.length; i++) {
    if (t >= track.cues[i].at) newIdx = i;
  }

  if (newIdx !== currentCueIdx) {
    currentCueIdx = newIdx;
    if (newIdx >= 0) {
      document.getElementById('cue-text').innerHTML = renderMarkdown(track.cues[newIdx].text);
      const cueBox = document.getElementById('cue-box');
      cueBox.classList.add('cue-flash');
      setTimeout(() => cueBox.classList.remove('cue-flash'), 600);
    }
    renderCueDots(track.cues, newIdx);
  }
}

// Update the label with live countdown to next cue
function updateCueCountdown() {
  const track = tracks[currentTrackIdx];
  if (!track || !track.cues.length) return;
  const t = audio.currentTime;

  if (currentCueIdx === -1) {
    // Counting down to first cue
    const secsLeft = Math.max(0, track.cues[0].at - t);
    document.getElementById('cue-label').textContent = `Next cue in ${formatTime(secsLeft)}`;
    return;
  }

  const nextIdx = currentCueIdx + 1;
  if (nextIdx < track.cues.length) {
    const secsLeft = Math.max(0, track.cues[nextIdx].at - t);
    document.getElementById('cue-label').textContent = `Next cue in ${formatTime(secsLeft)}`;
  } else {
    document.getElementById('cue-label').textContent = 'Last cue';
  }
}

function setCueDisplay(label, text) {
  document.getElementById('cue-label').textContent = label;
  document.getElementById('cue-text').textContent  = text;
}

function renderCueDots(cues, activeIdx) {
  const container = document.getElementById('cue-dots');
  container.innerHTML = '';
  cues.forEach((_, i) => {
    const dot = document.createElement('div');
    dot.className = 'cue-dot' + (i === activeIdx ? ' active' : i < activeIdx ? ' done' : '');
    container.appendChild(dot);
  });
}

function renderMarkdown(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

// ─── Track progress bar ───────────────────────────────────────────────────────
function updateTrackProgress() {
  const cur = audio.currentTime || 0;
  const dur = audio.duration   || 0;
  document.getElementById('track-current').textContent  = formatTime(cur);
  document.getElementById('track-duration').textContent = formatTime(dur);
  document.getElementById('track-fill').style.width = dur > 0 ? (cur / dur * 100) + '%' : '0%';
}

function updateClassProgress() {
  document.getElementById('class-progress').style.width = (currentTrackIdx / tracks.length * 100) + '%';
}

function renderIntensityBars(resistance) {
  const container = document.getElementById('intensity-bars');
  container.innerHTML = '';
  for (let i = 1; i <= 10; i++) {
    const bar = document.createElement('div');
    bar.className = 'intensity-bar' + (i <= resistance ? ' on' : '');
    bar.style.height = (6 + i * 2.2) + 'px';
    container.appendChild(bar);
  }
  document.getElementById('intensity-val').textContent = resistance ? `${resistance} / 10` : '—';
}

function seekTrack(e) {
  if (!audio.duration) return;
  const bar  = document.getElementById('track-bar');
  const rect = bar.getBoundingClientRect();
  const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audio.currentTime = pct * audio.duration;
}

// ─── Playback controls ────────────────────────────────────────────────────────
function startPlayback() {
  audio.play().then(() => {
    isPlaying = true;
    document.getElementById('play-btn').textContent = '⏸';
    startClassTimer();
    requestWakeLock();
  }).catch(e => {
    // Autoplay blocked — user must tap play manually
    console.log('Autoplay blocked, waiting for user gesture');
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
    audio.play().catch(e => console.error(e));
    document.getElementById('play-btn').textContent = '⏸';
    isPlaying = true;
    startClassTimer();
    requestWakeLock();
  }
}

async function nextTrack() {
  if (currentTrackIdx < tracks.length - 1) {
    audio.pause();
    mountTrack(currentTrackIdx + 1);
    if (isPlaying) audio.play().catch(e => console.error(e));
  }
}

async function prevTrack() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (currentTrackIdx > 0) {
    audio.pause();
    mountTrack(currentTrackIdx - 1);
    if (isPlaying) audio.play().catch(e => console.error(e));
  }
}

function endOfClass() {
  isPlaying = false;
  document.getElementById('play-btn').textContent = '▶';
  setCueDisplay('Done', 'Great work! Class complete.');
  document.getElementById('class-progress').style.width = '100%';
  stopClassTimer();
  releaseWakeLock();
}

// ─── Class timer — only counts while audio plays ──────────────────────────────
function startClassTimer() {
  if (classTimerInterval) return;
  classTimerInterval = setInterval(() => {
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
  const s = Math.floor(secs);
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}
