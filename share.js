// ─── Class sharing ────────────────────────────────────────────────────────────
// Owner side (class.html, signed in): "Share this class" creates public Dropbox
// links for class.txt and every audio file, writes them to share.json in the
// class folder and hands out  share.html#<share.json link path>.
// Guest side (share.html, no sign-in): reads share.json, remembers the class
// and opens it in the normal class screen. The data layer that makes the class
// and listen screens read from public links lives in app.js (readShares,
// loadClassTxt, downloadAudio).
//
// Owner side needs the sharing.read + sharing.write scopes on the Dropbox app.
// Links are made with Dropbox's default settings: anyone with the link can
// download the file. Re-sharing reuses existing links, so the share URL stays
// the same; "Stop sharing" revokes every link inside the class folder.

var DBX_PUBLIC = 'https://dl.dropboxusercontent.com/';

// www.dropbox.com share links answer without CORS headers; the same link on
// dl.dropboxusercontent.com serves the file directly with
// Access-Control-Allow-Origin: *, so the app can fetch() it.
function directDropboxUrl(link) {
  var u = new URL(link);
  u.protocol = 'https:';
  u.hostname = 'dl.dropboxusercontent.com';
  u.searchParams.delete('dl');
  u.searchParams.delete('raw');
  return u.href;
}

// ─── Owner: Dropbox sharing API ───────────────────────────────────────────────
async function sharingCall(endpoint, body) {
  var res = await fetch(DBX_API + endpoint, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  var text = await res.text();
  var data = null;
  try { data = JSON.parse(text); } catch (e) {}
  if (res.ok) return data;

  var msg;
  if (/missing_scope/.test(text)) {
    msg = 'Sharing is not enabled for the app yet. In the Dropbox App Console open ' +
          'SpinOffApp → Permissions, tick sharing.read and sharing.write, submit, ' +
          'then disconnect SpinOff (⏏ on the home screen) and connect again.';
  } else if (res.status === 401) {
    msg = 'Dropbox session expired — disconnect (⏏ on the home screen) and connect again.';
  } else if (/not_found/.test(text)) {
    msg = 'file not found in Dropbox';
  } else {
    msg = 'Dropbox error ' + res.status + ': ' + ((data && data.error_summary) || text);
  }
  var err = new Error(msg);
  err.data = data;
  err.global = res.status === 401;   // not about one file — don't prefix a filename
  throw err;
}

// Public link for a file — reuses the existing link if there is one.
async function publicLinkFor(path) {
  try {
    return (await sharingCall('/sharing/create_shared_link_with_settings', { path: path })).url;
  } catch (e) {
    var error = e.data && e.data.error;
    if (!error || error['.tag'] !== 'shared_link_already_exists') throw e;
    // Dropbox inlines the existing link's metadata next to ".tag": "metadata"
    var meta = error.shared_link_already_exists || {};
    var url = meta.url || (meta.metadata && meta.metadata.url);
    if (url) return url;
    var list = await sharingCall('/sharing/list_shared_links', { path: path, direct_only: true });
    if (list.links && list.links.length) return list.links[0].url;
    throw e;
  }
}

// ─── Owner: share / stop sharing (class.html) ─────────────────────────────────
var shareUrl = null;

async function shareClass() {
  var folderPath = sessionStorage.getItem('current_class');
  if (!folderPath) return;
  showShareModal();
  setShareBusy(true);
  try {
    var txt = await dbxDownloadText(folderPath + '/class.txt');
    var audioPaths = parseTxt(txt, folderPath)
      .map(function(t) { return t.audioPath; })
      .filter(function(p, i, all) { return p && all.indexOf(p) === i; });

    var files = {};
    for (var i = 0; i < audioPaths.length; i++) {
      setShareStatus('Creating links… ' + (i + 1) + ' / ' + audioPaths.length);
      var file = audioPaths[i].slice(folderPath.length + 1);
      try {
        files[file.toLowerCase()] = directDropboxUrl(await publicLinkFor(audioPaths[i]));
      } catch (e) {
        throw e.global ? e : new Error(file + ': ' + e.message);
      }
    }

    setShareStatus('Writing share.json…');
    var manifest = {
      v: 1,
      name: folderPath.split('/').pop(),
      classTxt: directDropboxUrl(await publicLinkFor(folderPath + '/class.txt')),
      files: files
    };
    await dbxUploadText(folderPath + '/share.json', JSON.stringify(manifest, null, 2));
    var manifestUrl = directDropboxUrl(await publicLinkFor(folderPath + '/share.json'));

    shareUrl = new URL('share.html', window.location.href).href + '#' +
               manifestUrl.slice(DBX_PUBLIC.length);
    document.getElementById('share-url').value = shareUrl;
    document.getElementById('share-link-box').classList.remove('hidden');
    setShareStatus('Anyone with this link can run this class — no Dropbox needed. ' +
                   'Cue edits reach them automatically; after changing songs, tap Share again.');
  } catch (e) {
    console.error('shareClass failed:', e);
    setShareStatus('✗ ' + e.message, true);
  }
  setShareBusy(false);
}

async function stopSharing() {
  var folderPath = sessionStorage.getItem('current_class');
  if (!folderPath) return;
  if (!confirm('Stop sharing this class? The link stops working for everyone. ' +
               'Songs they already downloaded stay on their device.')) return;
  var prefix = folderPath.toLowerCase() + '/';
  setShareBusy(true);
  document.getElementById('share-link-box').classList.add('hidden');
  setShareStatus('Removing links…');
  try {
    var revoked = 0, failed = 0, cursor = null;
    var doomed = [];
    do {
      var page = await sharingCall('/sharing/list_shared_links', cursor ? { cursor: cursor } : {});
      (page.links || []).forEach(function(link) {
        if (link.path_lower && link.path_lower.indexOf(prefix) === 0) doomed.push(link.url);
      });
      cursor = page.has_more ? page.cursor : null;
    } while (cursor);
    for (var i = 0; i < doomed.length; i++) {
      try { await sharingCall('/sharing/revoke_shared_link', { url: doomed[i] }); revoked++; }
      catch (e) { failed++; console.warn('revoke failed:', doomed[i], e); }
    }
    shareUrl = null;
    setShareStatus(failed
      ? '✗ Removed ' + revoked + ' links, ' + failed + ' failed — try again.'
      : '✓ Sharing stopped (' + revoked + ' link' + (revoked === 1 ? '' : 's') + ' removed).', failed > 0);
  } catch (e) {
    console.error('stopSharing failed:', e);
    setShareStatus('✗ ' + e.message, true);
  }
  setShareBusy(false);
}

function showShareModal() {
  shareUrl = null;
  document.getElementById('share-link-box').classList.add('hidden');
  document.getElementById('share-native-btn').classList.toggle('hidden', !navigator.share);
  setShareStatus('');
  document.getElementById('share-modal').classList.remove('hidden');
}

function hideShareModal() {
  document.getElementById('share-modal').classList.add('hidden');
}

function setShareStatus(text, isError) {
  var el = document.getElementById('share-status');
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}

function setShareBusy(busy) {
  document.getElementById('share-stop-btn').disabled = busy;
}

async function copyShareUrl() {
  if (!shareUrl) return;
  var btn = document.getElementById('share-copy-btn');
  try {
    await navigator.clipboard.writeText(shareUrl);
  } catch (e) {
    var input = document.getElementById('share-url');
    input.select();
    try { document.execCommand('copy'); } catch (e2) {}
  }
  btn.textContent = '✓ Copied';
  setTimeout(function() { btn.textContent = 'Copy link'; }, 1500);
}

function nativeShareUrl() {
  if (!shareUrl || !navigator.share) return;
  var name = formatFolderName(sessionStorage.getItem('current_class').split('/').pop());
  navigator.share({ title: 'SpinOff · ' + name, url: shareUrl }).catch(function() {});
}

// ─── Guest: open a share link (share.html) ────────────────────────────────────
// Returns the stand-in folder path of the shared class. Works offline for a
// link that was opened before.
async function openShareLink(ref) {
  if (!/^(scl|s)\//.test(ref)) throw new Error('This share link is incomplete — ask for it again.');
  var manifestUrl = DBX_PUBLIC + ref;
  var shares = readShares();
  var known = Object.keys(shares).filter(function(fp) {
    return shares[fp].manifestUrl === manifestUrl;
  })[0];
  var m;
  try {
    m = await fetchShareManifest(manifestUrl);
  } catch (e) {
    if (known) return known;
    throw e;
  }
  var folderPath = known ||
    '/~shared-' + hashString(manifestUrl) + '/' + m.name.replace(/[\/\\]/g, '-');
  shares[folderPath] = { name: m.name, manifestUrl: manifestUrl, classTxt: m.classTxt,
                         files: m.files, addedAt: Date.now() };
  writeShares(shares);
  return folderPath;
}

function hashString(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// ─── Guest: "Shared with you" list (index.html) ───────────────────────────────
function renderSharedClasses(containerId) {
  var el = document.getElementById(containerId);
  if (!el) return;
  var shares = readShares();
  var paths = Object.keys(shares).sort(function(a, b) {
    return (shares[b].addedAt || 0) - (shares[a].addedAt || 0);
  });
  el.innerHTML = '';
  el.classList.toggle('hidden', paths.length === 0);
  if (paths.length === 0) return;

  var label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = 'Shared with you';
  var list = document.createElement('div');
  list.className = 'class-list';
  el.appendChild(label);
  el.appendChild(list);

  paths.forEach(function(fp) {
    var card = document.createElement('div');
    card.className = 'class-card';
    var info = document.createElement('div');
    info.className = 'class-card-info';
    info.style.cssText = 'flex:1;min-width:0';
    var name = document.createElement('div');
    name.className = 'class-card-name';
    name.textContent = formatFolderName(shares[fp].name);
    var sub = document.createElement('div');
    sub.className = 'class-card-sub';
    sub.textContent = 'shared class';
    info.appendChild(name);
    info.appendChild(sub);

    var del = document.createElement('button');
    del.className = 'class-delete-btn';
    del.textContent = '✕';
    del.title = 'Remove from this device';
    del.addEventListener('click', async function(e) {
      e.stopPropagation();
      if (!confirm('Remove this shared class and its downloaded songs from this device?')) return;
      await deleteClassCache(fp, null);
      var s = readShares();
      delete s[fp];
      writeShares(s);
      renderSharedClasses(containerId);
    });

    var arrow = document.createElement('div');
    arrow.className = 'class-card-arrow';
    arrow.textContent = '›';

    card.appendChild(info);
    card.appendChild(del);
    card.appendChild(arrow);
    card.addEventListener('click', function() { openClass(fp); });
    list.appendChild(card);
  });
}
