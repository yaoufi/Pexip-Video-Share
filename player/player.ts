import { registerWidget } from '@pexip/plugin-api';
import type { SyncMessage } from '../src/types';

const plugin = await registerWidget({ parentPluginId: 'video-share2' });

// ── Query params ───────────────────────────────────────────────────────────
const params      = new URLSearchParams(window.location.search);
const isSharer    = params.get('role') === 'sharer';
const initialUrl  = params.get('url') ?? '';
const sharerName  = params.get('sharerName') ?? 'Participant';
const sessionId   = params.get('sessionId') || `local-${Date.now()}`;
const initTime    = parseFloat(params.get('initTime')    ?? '0');
// Default to paused — viewer waits for sync-state from sharer before playing
const initPlaying = params.get('initPlaying') === 'true';
// Server URL and API key resolved by main.ts and passed as URL params
const UPLOAD_SERVER = params.get('serverUrl') ?? '';
const API_KEY       = params.get('apiKey')    ?? '';

// Authorization header for every request to the upload server
function authHeaders(): HeadersInit {
  return API_KEY ? { 'Authorization': `Bearer ${API_KEY}` } : {};
}

let selfUuid = params.get('selfUuid') ?? '';
let selfName  = isSharer ? sharerName : 'Viewer';

plugin.events.me.add((me: unknown) => {
  const p = me as Record<string, string>;
  selfUuid = p.uuid ?? selfUuid;
  selfName  = p.displayName ?? p.name ?? selfName;
});

// ── DOM ────────────────────────────────────────────────────────────────────
const shareFormEl   = document.getElementById('share-form')!;
const playerViewEl  = document.getElementById('player-view')!;
const videoEl       = document.getElementById('video') as HTMLVideoElement;
const playOverlay   = document.getElementById('play-overlay')!;
const peerBadge     = document.getElementById('peer-badge')!;
const peerNameEl    = document.getElementById('peer-name')!;
const fileDrop      = document.getElementById('file-drop')!;
const fileInput     = document.getElementById('file-input') as HTMLInputElement;
const fileLabel     = document.getElementById('file-label')!;
const shareBtn      = document.getElementById('share-btn') as HTMLButtonElement;
const progressWrap  = document.getElementById('progress-wrap')!;
const progressFill  = document.getElementById('progress-fill') as HTMLElement;
const statusMsg     = document.getElementById('status-msg')!;
const controlsEl    = document.getElementById('controls')!;
const viewerBar     = document.getElementById('viewer-bar')!;
const sharerLabel   = document.getElementById('sharer-label')!;
const playPauseBtn  = document.getElementById('play-pause-btn')!;
const seekBarEl     = document.getElementById('seek-bar') as HTMLInputElement;
const timeDisplay   = document.getElementById('time-display')!;
const pushSyncBtn   = document.getElementById('push-sync-btn')!;
const pullSyncBtn   = document.getElementById('pull-sync-btn')!;
const stopBtn       = document.getElementById('stop-btn')!;
const fullscreenBtn = document.getElementById('fullscreen-btn') as HTMLButtonElement | null;
const viewerFsBtn   = document.getElementById('viewer-fs-btn')  as HTMLButtonElement | null;

// ── State ──────────────────────────────────────────────────────────────────
let currentUrl    = '';
let isSeeking_    = false;
let seekRafId     = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let syncPollTimer: ReturnType<typeof setInterval> | null  = null;
let lastSyncAt    = 0;   // timestamp of last sync-state we applied (viewer debounce)

// ── File picker ────────────────────────────────────────────────────────────
fileDrop.addEventListener('dragover', e => { e.preventDefault(); fileDrop.classList.add('drag-over'); });
fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('drag-over'));
fileDrop.addEventListener('drop', e => {
  e.preventDefault();
  fileDrop.classList.remove('drag-over');
  const f = e.dataTransfer?.files[0];
  if (f) pickFile(f);
});
fileInput.addEventListener('change', () => { if (fileInput.files?.[0]) pickFile(fileInput.files[0]); });

function pickFile(f: File) {
  fileLabel.textContent = f.name;
  shareBtn.disabled     = false;
  setStatus('');
}

// ── Upload & share ─────────────────────────────────────────────────────────
shareBtn.addEventListener('click', async () => {
  if (!fileInput.files?.[0]) return;

  shareBtn.disabled = true;
  progressWrap.style.display = 'block';
  setStatus('Uploading…');

  try {
    const url = await uploadWithProgress(
      `${UPLOAD_SERVER}/upload`,
      fileInput.files[0],
      pct => { progressFill.style.width = `${pct}%`; },
    );
    progressWrap.style.display = 'none';

    // Signal main.ts via server — main.ts polls /pending-share and calls
    // sendApplicationMessage from the trusted plugin context.
    await fetch(`${UPLOAD_SERVER}/pending-share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ sessionId, url, sharerName: selfName }),
    }).catch((err) => console.error('[vs2] pending-share POST failed:', err));

    console.log('[vs2] pending-share posted', { sessionId, url });
    setStatus('Shared — waiting for participants…');
    startShare(url);
  } catch (err) {
    setStatus((err as Error).message, true);
    shareBtn.disabled = false;
    progressWrap.style.display = 'none';
  }
});

function uploadWithProgress(uploadUrl: string, file: File, onProgress: (pct: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fd  = new FormData();
    fd.append('files', file);
    xhr.open('POST', uploadUrl);
    if (API_KEY) xhr.setRequestHeader('Authorization', `Bearer ${API_KEY}`);
    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve((JSON.parse(xhr.responseText) as { files: { url: string }[] }).files[0].url); }
        catch { reject(new Error('Unexpected server response')); }
      } else {
        reject(new Error(`Upload failed (HTTP ${xhr.status})`));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Network error — check server URL')));
    xhr.send(fd);
  });
}

// ── Sharer: start sharing ──────────────────────────────────────────────────
function startShare(url: string) {
  currentUrl = url;
  loadVideo(url, 0, false);
  showPlayer(true);
  // Post sync-state immediately so viewers don't autoplay before sharer presses play
  postSyncState();
  startHeartbeat();
}

// ── Video player ───────────────────────────────────────────────────────────
function loadVideo(url: string, startTime: number, autoplay: boolean) {
  currentUrl          = url;
  videoEl.src         = url;
  videoEl.currentTime = startTime;
  videoEl.addEventListener('loadedmetadata', () => { startSeekUpdater(); setStatus(''); }, { once: true });
  videoEl.addEventListener('ended', () => { if (isSharer) deleteUploadedFile(currentUrl); }, { once: true });
  videoEl.addEventListener('error', () => {
    setStatus(`Could not load video. <a href="${url}" target="_blank">Open ↗</a>`, true);
  }, { once: true });
  if (autoplay) {
    videoEl.play().catch(() => { playOverlay.style.display = 'flex'; });
  }
}

playOverlay.addEventListener('click', () => {
  videoEl.play().catch(() => undefined);
  playOverlay.style.display = 'none';
});

// ── Sharer controls ────────────────────────────────────────────────────────
playPauseBtn.addEventListener('click', () => {
  if (videoEl.paused) {
    videoEl.play().catch(() => undefined);
    postSyncState();
  } else {
    videoEl.pause();
    postSyncState();
  }
  updatePlayPause();
});

pushSyncBtn.addEventListener('click', () => { postSyncState(); });
pullSyncBtn.addEventListener('click', () => { applySyncFromServer(); });

let isSeeking2 = false;
seekBarEl.addEventListener('mousedown',  () => { isSeeking2 = true; });
seekBarEl.addEventListener('touchstart', () => { isSeeking2 = true; });
seekBarEl.addEventListener('input', () => {
  const t = (parseFloat(seekBarEl.value) / 1000) * (videoEl.duration || 0);
  timeDisplay.textContent = `${fmt(t)} / ${fmt(videoEl.duration || 0)}`;
});
seekBarEl.addEventListener('change', () => {
  isSeeking2 = false;
  videoEl.currentTime = (parseFloat(seekBarEl.value) / 1000) * (videoEl.duration || 0);
  postSyncState();
});

stopBtn.addEventListener('click', () => {
  deleteUploadedFile(currentUrl);
  // Signal stop via server — same relay pattern as video:open.
  // main.ts polls /stop-signal and calls sendApplicationMessage from the trusted plugin context.
  if (sessionId && UPLOAD_SERVER) {
    fetch(`${UPLOAD_SERVER}/stop-signal/${sessionId}`, {
      method: 'POST',
      headers: { ...authHeaders() },
    }).catch(() => undefined);
  }
  stopHeartbeat();
  stopSyncPoll();
  videoEl.pause(); videoEl.src = '';
  currentUrl = '';
  showForm();
});

// ── Fullscreen ─────────────────────────────────────────────────────────────
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {
      // Fallback: try the video element directly
      videoEl.requestFullscreen().catch(() => undefined);
    });
  } else {
    document.exitFullscreen().catch(() => undefined);
  }
}

fullscreenBtn?.addEventListener('click', toggleFullscreen);
viewerFsBtn?.addEventListener('click', toggleFullscreen);

// Double-click on video also toggles fullscreen (common UX pattern)
videoEl.addEventListener('dblclick', toggleFullscreen);

document.addEventListener('fullscreenchange', () => {
  const icon = document.fullscreenElement ? '⊡' : '⛶';
  if (fullscreenBtn) fullscreenBtn.textContent = icon;
  if (viewerFsBtn)   viewerFsBtn.textContent   = icon;
});

// Delete the uploaded file once sharing ends (Stop button or video ended)
function deleteUploadedFile(url: string) {
  if (!url || !url.startsWith(UPLOAD_SERVER)) return;
  fetch(url, { method: 'DELETE', headers: authHeaders() }).catch(() => undefined);
}

// ── Post sync state to server (sharer → server → viewer poll) ─────────────
function postSyncState() {
  if (!sessionId) return;
  fetch(`${UPLOAD_SERVER}/sync-state/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ time: videoEl.currentTime, playing: !videoEl.paused }),
  }).catch(() => undefined);
}

// ── Viewer: poll server for sync state ────────────────────────────────────
function startSyncPoll() {
  stopSyncPoll();
  syncPollTimer = setInterval(() => { applySyncFromServer(); }, 1000);
}
function stopSyncPoll() {
  if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }
}

async function applySyncFromServer() {
  if (!sessionId) return;
  try {
    const res  = await fetch(`${UPLOAD_SERVER}/sync-state/${sessionId}`, { cache: 'no-store', headers: authHeaders() });
    const data = await res.json() as { time: number; playing: boolean; updatedAt: number } | null;
    if (!data) return;
    // Only apply if the state is recent (within last 60 seconds)
    const age = (Date.now() - data.updatedAt) / 1000;
    if (age > 60) return;

    // Project the sharer's position forward by how long ago the state was saved.
    // Without this, a 10s-old heartbeat at time=90 would make the viewer seek
    // back from 100 to 90 every poll cycle — creating a loop.
    const expectedTime = data.playing ? data.time + age : data.time;

    // Only correct if meaningfully out of sync (>3 seconds drift)
    const drift = Math.abs(videoEl.currentTime - expectedTime);
    if (drift > 3) {
      videoEl.currentTime = expectedTime;
    }

    // Sync play/pause state
    if (data.playing && videoEl.paused) {
      videoEl.play().catch(() => { playOverlay.style.display = 'flex'; });
    } else if (!data.playing && !videoEl.paused) {
      videoEl.pause();
    }
    updatePlayPause();
  } catch { /* server unreachable */ }
}

// ── Seek bar ───────────────────────────────────────────────────────────────
function startSeekUpdater() {
  cancelAnimationFrame(seekRafId);
  const tick = () => {
    if (!isSeeking_ && !isSeeking2) {
      const pos = videoEl.currentTime;
      const dur = videoEl.duration || 0;
      seekBarEl.value = String(dur > 0 ? Math.round((pos / dur) * 1000) : 0);
      timeDisplay.textContent = `${fmt(pos)} / ${fmt(dur)}`;
      updatePlayPause();
    }
    seekRafId = requestAnimationFrame(tick);
  };
  seekRafId = requestAnimationFrame(tick);
}

function updatePlayPause() {
  playPauseBtn.textContent = videoEl.paused ? '▶' : '⏸';
}

// ── Heartbeat for late joiners ─────────────────────────────────────────────
function startHeartbeat() {
  heartbeatTimer = setInterval(() => {
    if (!currentUrl) return;
    plugin.conference.sendApplicationMessage({
      payload: {
        type: 'video:heartbeat',
        url: currentUrl,
        sharerName: selfName,
        time: videoEl.currentTime,
        playing: !videoEl.paused,
        senderUuid: selfUuid,
        sessionId,
      } as Record<string, unknown>,
    }).catch(() => undefined);
    if (isSharer) postSyncState(); // keep sync-state fresh for viewers
  }, 10_000);
}
function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ── Incoming applicationMessage (sync events from sharer) ─────────────────
plugin.events.applicationMessage.add((event: unknown) => {
  const msg = (event as { message: SyncMessage }).message;
  if (!('type' in msg)) return;
  if (msg.senderUuid === selfUuid) return;

  if (msg.type === 'video:open' || msg.type === 'video:heartbeat') {
    peerNameEl.textContent  = msg.sharerName || 'sharer';
    peerBadge.style.display = 'flex';
  }
  if (msg.type === 'video:stop') {
    peerBadge.style.display = 'none';
    stopSyncPoll();
  }
  if (msg.type === 'video:request-sync' && isSharer && currentUrl) {
    plugin.conference.sendApplicationMessage({
      payload: {
        type: 'video:sync-state',
        time: videoEl.currentTime,
        playing: !videoEl.paused,
        senderUuid: selfUuid,
      } as Record<string, unknown>,
    }).catch(() => undefined);
  }
});

// ── UI helpers ─────────────────────────────────────────────────────────────
function showPlayer(asSharer: boolean) {
  shareFormEl.style.display  = 'none';
  playerViewEl.style.display = 'flex';
  controlsEl.style.display   = asSharer ? 'flex' : 'none';
  viewerBar.style.display    = asSharer ? 'none'  : 'block';
  pushSyncBtn.style.display  = asSharer ? ''      : 'none';
  pullSyncBtn.style.display  = asSharer ? ''      : 'none';
  if (!asSharer && sharerName) sharerLabel.textContent = sharerName;
  if (!asSharer) startSyncPoll();
}

function showForm() {
  shareFormEl.style.display  = 'flex';
  playerViewEl.style.display = 'none';
  cancelAnimationFrame(seekRafId);
}

function setStatus(msg: string, isError = false) {
  statusMsg.innerHTML = msg;
  statusMsg.classList.toggle('error', isError);
}

function fmt(s: number): string {
  if (!isFinite(s)) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// ── Initial render ─────────────────────────────────────────────────────────
if (isSharer) {
  showForm();
} else if (initialUrl) {
  loadVideo(initialUrl, initTime, initPlaying);
  showPlayer(false);
}
