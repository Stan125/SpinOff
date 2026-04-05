// ─── Config ───────────────────────────────────────────────────────────────────
const APP_KEY      = '1ko2h058qpnvrn1';
const REDIRECT_URI = 'https://Stan125.github.io/SpinOff/auth.html';
const DBX_ROOT     = '';
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
  showScreen('auth-screen');
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

async function dbxGetTempLink(path) {
  const data = await dbxPost('/files/get_temporary_link', { path });
  return data.link;
}

// ─── Screen routing ───────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

function goHome() {
  if (audio) { audio.pause(); audio.src = ''; }
  window.location.href = 'index.html';
}

// ─── Class list ───────────────────────────────────────────────────────────────
async function loadClasses() {
  const list = document.getElementById('class-list');
  try {
    const data = await dbxPost('/files/list_folder', { path: DBX_ROOT });
    const folders = data.entries.filter(e => e['.tag'] === 'folder');
    if (folders.length === 0) {
      list.innerHTML = '<div class="empty-state">No classes found in Dropbox/Apps/SpinOffApp</div>';
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
// Format:
// ## Song Title | Artist | Type | BPM 138 | RPE 8 | R7 | 01_file.mp3
// 0:00 Cue text here **bold works**
// 1:30 Next cue
//
// ## Next Song | ...
function parseTxt(txt, folderPath) {
  const tracks = [];
  const sections = txt.split(/^##\s+/m).filter(s => s.trim());

  for (const section of sections) {
    const lines = section.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    const header = lines[0];
    const parts = header.split('|').map(p => p.trim());

    const song       = parts[0] || '?';
    const artist     = parts[1] || '';
    const type       = parts[2] || '';
    const bpm        = (parts[3] || '').replace(/bpm\s*/i, '');
    const rpe        = (parts[4] || '').replace(/rpe\s*/i, '');
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

    tracks.push({ song, artist, type, bpm, rpe, resistance, audioPath, cues });
  }
  return tracks;
}

// ─── Runner ───────────────────────────────────────────────────────────────────
let tracks = [];
let currentTrackIdx = 0;
let currentCueIdx = 0;
let audio = null;
let classStartTime = null;
let classTimerInterval = null;
let cueWatchInterval = null;
let isPlaying = false;
let classFolder = '';

async function initRunner(folderPath) {
  classFolder = folderPath;
  audio = document.getElementById('audio-player');

  const titleEl = document.getElementById('class-title');
  titleEl.textContent = formatFolderName(folderPath.split('/').pop());

  try {
    const txt = await dbxDownloadText(folderPath + '/class.txt');
    tracks = parseTxt(txt, folderPath);
    if (tracks.length === 0) throw new Error('No tracks found in class.txt');
    await loadTrack(0);
    startClassTimer();
  } catch (e) {
    alert('Could not load class: ' + e.message);
    goHome();
  }

  audio.addEventListener('ended', () => {
    if (currentTrackIdx < tracks.length - 1) nextTrack();
    else endOfClass();
  });

  audio.addEventListener('timeupdate', () => {
    updateTrackProgress();
    checkCues();
  });

  audio.addEventListener('loadedmetadata', () => {
    updateTrackProgress();
  });
}

async function loadTrack(idx) {
  currentTrackIdx = idx;
  currentCueIdx = -1;
  const track = tracks[idx];

  // Update song card
  document.getElementById('track-label').textContent = `Track ${idx + 1} / ${tracks.length}`;
  document.getElementById('song-name').textContent = track.song;
  document.getElementById('song-artist').textContent = track.artist;
  document.getElementById('track-type-tag').textContent = track.type;
  document.getElementById('meta-bpm').textContent = track.bpm ? `⚡ ${track.bpm} BPM` : '—';
  document.getElementById('meta-rpe').textContent = track.rpe ? `RPE ${track.rpe}` : '—';
  document.getElementById('meta-res').textContent = track.resistance ? `R${track.resistance}` : '—';

  renderIntensityBars(track.resistance);
  renderCueDots(track.cues, -1);
  document.getElementById('cue-text').textContent = 'Get ready…';

  // Next track info
  const next = tracks[idx + 1];
  document.getElementById('next-song').textContent = next ? `${next.song} — ${next.artist}` : 'End of class';
  document.getElementById('next-type').textContent = next ? `${next.type} · RPE ${next.rpe}` : '';

  // Load audio
  if (track.audioPath) {
    try {
      const link = await dbxGetTempLink(track.audioPath);
      audio.src = link;
      audio.load();
    } catch (e) {
      console.error('Audio load failed:', e);
    }
  }

  updateClassProgress();
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

function renderCueDots(cues, activeIdx) {
  const container = document.getElementById('cue-dots');
  container.innerHTML = '';
  cues.forEach((_, i) => {
    const dot = document.createElement('div');
    dot.className = 'cue-dot' + (i === activeIdx ? ' active' : i < activeIdx ? ' done' : '');
    container.appendChild(dot);
  });
}

function checkCues() {
  const track = tracks[currentTrackIdx];
  if (!track || !track.cues.length) return;
  const t = audio.currentTime;

  // Find the last cue whose 'at' has been passed
  let newIdx = -1;
  for (let i = 0; i < track.cues.length; i++) {
    if (t >= track.cues[i].at) newIdx = i;
  }

  if (newIdx !== currentCueIdx) {
    currentCueIdx = newIdx;
    const cueEl = document.getElementById('cue-text');
    const cueBox = document.getElementById('cue-box');

    if (newIdx >= 0) {
      cueEl.innerHTML = renderMarkdown(track.cues[newIdx].text);
      cueBox.classList.add('cue-flash');
      setTimeout(() => cueBox.classList.remove('cue-flash'), 600);
    } else {
      cueEl.textContent = 'Get ready…';
    }
    renderCueDots(track.cues, newIdx);
  }
}

// Very simple markdown: **bold**
function renderMarkdown(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function updateTrackProgress() {
  const cur = audio.currentTime || 0;
  const dur = audio.duration || 0;
  document.getElementById('track-current').textContent = formatTime(cur);
  document.getElementById('track-duration').textContent = formatTime(dur);
  const pct = dur > 0 ? (cur / dur) * 100 : 0;
  document.getElementById('track-fill').style.width = pct + '%';
}

function updateClassProgress() {
  const done = currentTrackIdx / tracks.length;
  document.getElementById('class-progress').style.width = (done * 100) + '%';
}

function seekTrack(e) {
  if (!audio.duration) return;
  const bar = document.getElementById('track-bar');
  const rect = bar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audio.currentTime = pct * audio.duration;
}

// ─── Playback controls ────────────────────────────────────────────────────────
function togglePlay() {
  if (isPlaying) {
    audio.pause();
    document.getElementById('play-btn').textContent = '▶';
    isPlaying = false;
  } else {
    audio.play().catch(e => console.error(e));
    document.getElementById('play-btn').textContent = '⏸';
    isPlaying = true;
    if (!classStartTime) classStartTime = Date.now();
  }
}

async function nextTrack() {
  if (currentTrackIdx < tracks.length - 1) {
    const wasPlaying = isPlaying;
    audio.pause();
    await loadTrack(currentTrackIdx + 1);
    if (wasPlaying) {
      audio.play().catch(e => console.error(e));
    }
  }
}

async function prevTrack() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  if (currentTrackIdx > 0) {
    const wasPlaying = isPlaying;
    audio.pause();
    await loadTrack(currentTrackIdx - 1);
    if (wasPlaying) {
      audio.play().catch(e => console.error(e));
    }
  }
}

function endOfClass() {
  isPlaying = false;
  document.getElementById('play-btn').textContent = '▶';
  document.getElementById('cue-text').textContent = 'Great work! Class complete.';
  document.getElementById('class-progress').style.width = '100%';
}

// ─── Class timer ──────────────────────────────────────────────────────────────
function startClassTimer() {
  classStartTime = null;
  classTimerInterval = setInterval(() => {
    if (!classStartTime || !isPlaying) return;
    const elapsed = Math.floor((Date.now() - classStartTime) / 1000);
    document.getElementById('class-elapsed').textContent = formatTime(elapsed);
  }, 1000);
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function formatTime(secs) {
  const s = Math.floor(secs);
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}
