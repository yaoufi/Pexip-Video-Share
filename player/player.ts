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
// selfName comes from main.ts (which has the real display name from plugin.events.me).
// Widget's own me event is unreliable — don't rely on it for the name.
let selfName  = isSharer ? sharerName : (params.get('selfName') || 'Viewer');

plugin.events.me.add((me: unknown) => {
  const p = me as Record<string, string>;
  selfUuid = p.uuid ?? selfUuid;
  selfName  = p.displayName ?? p.name ?? selfName;
});

// ── YouTube helper ─────────────────────────────────────────────────────────
function getYouTubeId(url: string): string | null {
  return url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/)?.[1] ?? null;
}
const isYouTube = !!getYouTubeId(initialUrl);

// ── DOM ────────────────────────────────────────────────────────────────────
const shareFormEl   = document.getElementById('share-form')!;
const playerViewEl  = document.getElementById('player-view')!;
const playerInner   = document.getElementById('player-inner')!;
const videoEl       = document.getElementById('video') as HTMLVideoElement;
const playOverlay   = document.getElementById('play-overlay')!;
const peerBadge     = document.getElementById('peer-badge')!;
const unmuteBar     = document.getElementById('unmute-bar')!;
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
const pushSyncBtn   = document.getElementById('push-sync-btn') as HTMLButtonElement | null;
const pullSyncBtn   = document.getElementById('pull-sync-btn')!;
const stopBtn          = document.getElementById('stop-btn')!;
// Share form elements
const cardLocal        = document.getElementById('card-local')!;
const cardYouTube      = document.getElementById('card-youtube')!;
const localPanel       = document.getElementById('local-panel')!;
const youtubePanel     = document.getElementById('youtube-panel')!;
const youtubeUrlInput  = document.getElementById('youtube-url-input') as HTMLInputElement;
const shareYoutubeBtn  = document.getElementById('share-youtube-btn') as HTMLButtonElement;
const resizeBtn        = document.getElementById('resize-btn')        as HTMLButtonElement | null;
const fullscreenBtn    = document.getElementById('fullscreen-btn')    as HTMLButtonElement | null;
const viewerFsBtn      = document.getElementById('viewer-fs-btn')     as HTMLButtonElement | null;
const speedSelect      = document.getElementById('speed-select')      as HTMLSelectElement | null;
const muteBtn          = document.getElementById('mute-btn')          as HTMLButtonElement | null;
const volumeBar        = document.getElementById('volume-bar')        as HTMLInputElement  | null;
const viewerMuteBtn    = document.getElementById('viewer-mute-btn')   as HTMLButtonElement | null;
const viewerVolumeBar  = document.getElementById('viewer-volume-bar') as HTMLInputElement  | null;

// Draw overlay
const drawCanvas         = document.getElementById('draw-canvas')          as HTMLCanvasElement;
const drawBtn            = document.getElementById('draw-btn')             as HTMLButtonElement | null;
const colorSwatchesEl    = document.getElementById('color-swatches')!;
const clearDrawBtn       = document.getElementById('clear-draw-btn')       as HTMLButtonElement | null;
const viewerDrawBtn      = document.getElementById('viewer-draw-btn')      as HTMLButtonElement | null;
const viewerColorSwatches = document.getElementById('viewer-color-swatches')!;
const viewerClearDrawBtn  = document.getElementById('viewer-clear-draw-btn') as HTMLButtonElement | null;

// ── State ──────────────────────────────────────────────────────────────────
let currentUrl    = '';
let isSeeking_    = false;
let seekRafId     = 0;
let heartbeatTimer:    ReturnType<typeof setInterval> | null = null;
let syncPollTimer:     ReturnType<typeof setInterval> | null = null;
let viewerCountTimer:  ReturnType<typeof setInterval> | null = null;
let lastSyncAt    = 0;   // timestamp of last sync-state we applied (viewer debounce)

// Stable per-session viewer ID (independent of selfUuid which arrives late)
const viewerId = `v-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
let viewerRegistered = false;

// ── Draw state ─────────────────────────────────────────────────────────────
let drawMode     = false;
let drawColor    = '#ff4444';
let isDrawing    = false;
let currentStroke: { x: number; y: number }[] = [];
let annoStrokes:   { id: string; points: { x: number; y: number }[]; color: string; width: number }[] = [];
let annoCount    = 0;   // stroke count at last redraw — used to skip no-op redraws
let annoPollTimer: ReturnType<typeof setInterval> | null = null;

// ── Source card switching (Local / YouTube) ───────────────────────────────
function selectSource(type: 'local' | 'youtube') {
  cardLocal.classList.toggle('active', type === 'local');
  cardYouTube.classList.toggle('active', type === 'youtube');
  localPanel.style.display    = type === 'local'   ? 'flex' : 'none';
  youtubePanel.style.display  = type === 'youtube' ? 'flex' : 'none';
}
cardLocal.addEventListener('click',   () => selectSource('local'));
cardYouTube.addEventListener('click', () => selectSource('youtube'));

// ── YouTube URL share ─────────────────────────────────────────────────────
shareYoutubeBtn.addEventListener('click', async () => {
  const url = youtubeUrlInput.value.trim();
  const id  = getYouTubeId(url);
  if (!id) { setStatus('Please paste a valid YouTube URL', true); return; }

  const canonicalUrl = `https://www.youtube.com/watch?v=${id}`;

  if (!UPLOAD_SERVER) {
    setStatus('No upload server configured.', true); return;
  }
  setStatus('Sharing…');
  shareYoutubeBtn.disabled = true;

  try {
    await fetch(`${UPLOAD_SERVER}/pending-share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ sessionId, url: canonicalUrl, sharerName: selfName }),
    }).catch(() => undefined);
    setStatus('');
    startShare(canonicalUrl);
  } catch {
    setStatus('Failed to share.', true);
    shareYoutubeBtn.disabled = false;
  }
});

// ── File picker ────────────────────────────────────────────────────────────
// No explicit click handler — the <label> natively forwards clicks to the
// <input> when it contains it. The input uses opacity/position (not
// display:none) so iOS Safari preserves the label→input association.
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
  postSyncState();
  startHeartbeat();
}

// ── YouTube IFrame Player ──────────────────────────────────────────────────
type YTPlayer = {
  playVideo(): void; pauseVideo(): void;
  seekTo(s: number, allow: boolean): void;
  getCurrentTime(): number; getDuration(): number;
  getPlayerState(): number; setPlaybackRate(r: number): void;
  mute(): void; unMute(): void; isMuted(): boolean; setVolume(v: number): void;
  destroy(): void;
};
let ytPlayer: YTPlayer | null = null;
let ytApiReady = false;

function loadYouTubePlayer(videoId: string, startTime: number, autoplay: boolean) {
  videoEl.style.display = 'none'; // hide <video>, show YouTube iframe

  // Inject YouTube IFrame API script once
  if (!document.getElementById('yt-api')) {
    const s = document.createElement('script');
    s.id = 'yt-api'; s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  }

  const container = document.createElement('div');
  container.id = 'yt-container';
  container.style.cssText = 'width:100%;height:100%;';
  playerInner.innerHTML = '';
  playerInner.appendChild(container);

  const createPlayer = () => {
    if (ytPlayer) { ytPlayer.destroy(); ytPlayer = null; }
    ytPlayer = new (window as Record<string,unknown>).YT.Player('yt-container', {
      videoId,
      width: '100%', height: '100%',
      playerVars: {
        start: Math.floor(startTime),
        autoplay: autoplay ? 1 : 0,
        rel: 0, modestbranding: 1,
        origin: window.location.origin,
      },
      events: {
        onReady: () => { startSeekUpdater(); },
        onStateChange: (e: { data: number }) => {
          // 1 = playing, 2 = paused — post sync so viewers follow
          if (isSharer && (e.data === 1 || e.data === 2)) postSyncState();
        },
      },
    }) as unknown as YTPlayer;
  };

  if (ytApiReady) {
    createPlayer();
  } else {
    (window as Record<string,unknown>).onYouTubeIframeAPIReady = () => {
      ytApiReady = true;
      createPlayer();
    };
  }
}

// Current time / duration helpers that work for both local and YouTube
function getCurrentTime(): number {
  if (ytPlayer) { try { return ytPlayer.getCurrentTime(); } catch { return 0; } }
  return videoEl.currentTime;
}
function getDuration(): number {
  if (ytPlayer) { try { return ytPlayer.getDuration(); } catch { return 0; } }
  return videoEl.duration || 0;
}
function isPaused(): boolean {
  if (ytPlayer) { try { return ytPlayer.getPlayerState() !== 1; } catch { return true; } }
  return videoEl.paused;
}
function isMuted(): boolean {
  if (ytPlayer) { try { return ytPlayer.isMuted(); } catch { return false; } }
  return videoEl.muted || videoEl.volume === 0;
}

// ── Video player (local files) ─────────────────────────────────────────────
function loadVideo(url: string, startTime: number, autoplay: boolean) {
  const ytId = getYouTubeId(url);
  currentUrl = url;

  if (ytId) {
    loadYouTubePlayer(ytId, startTime, autoplay);
    return;
  }

  // Local video
  videoEl.style.display = 'block';
  playerInner.innerHTML = '';
  playerInner.appendChild(videoEl);
  videoEl.src         = url;
  videoEl.currentTime = startTime;
  videoEl.addEventListener('loadedmetadata', () => { startSeekUpdater(); setStatus(''); }, { once: true });
  videoEl.addEventListener('error', () => {
    setStatus(`Could not load video. <a href="${url}" target="_blank">Open ↗</a>`, true);
  }, { once: true });
  if (autoplay) { void tryPlay(); }
}

playOverlay.addEventListener('click', () => { void tryPlay(); });

// ── Sharer controls ────────────────────────────────────────────────────────
playPauseBtn.addEventListener('click', () => {
  if (ytPlayer) {
    if (isPaused()) { ytPlayer.playVideo(); } else { ytPlayer.pauseVideo(); }
    postSyncState();
  } else {
    if (videoEl.paused) { void tryPlay(); } else { videoEl.pause(); }
    postSyncState();
  }
  updatePlayPause();
});

// Viewer: force-snap to sharer's position (bypasses the 3s drift threshold)
pullSyncBtn.addEventListener('click', async () => {
  if (!sessionId || !UPLOAD_SERVER) return;
  try {
    const res  = await fetch(`${UPLOAD_SERVER}/sync-state/${sessionId}`, { cache: 'no-store', headers: authHeaders() });
    const data = await res.json() as { time: number; playing: boolean; speed?: number; updatedAt: number } | null;
    if (!data || !data.time) return;
    const snapTime = data.time + (Date.now() - data.updatedAt) / 1000 * (data.speed ?? 1);
    if (ytPlayer) { ytPlayer.seekTo(snapTime, true); }
    else           { videoEl.currentTime = snapTime; videoEl.playbackRate = data.speed ?? 1; }
    if (data.playing) void tryPlay();
    else if (ytPlayer) ytPlayer.pauseVideo();
    else videoEl.pause();
  } catch { /* server unreachable */ }
});

let isSeeking2 = false;
seekBarEl.addEventListener('mousedown',  () => { isSeeking2 = true; });
seekBarEl.addEventListener('touchstart', () => { isSeeking2 = true; });
seekBarEl.addEventListener('input', () => {
  const t = (parseFloat(seekBarEl.value) / 1000) * getDuration();
  timeDisplay.textContent = `${fmt(t)} / ${fmt(getDuration())}`;
});
seekBarEl.addEventListener('change', () => {
  isSeeking2 = false;
  const t = (parseFloat(seekBarEl.value) / 1000) * getDuration();
  if (ytPlayer) { ytPlayer.seekTo(t, true); } else { videoEl.currentTime = t; }
  postSyncState();
});

stopBtn.addEventListener('click', () => {
  deleteUploadedFile(currentUrl);
  stopViewerCount();
  if (sessionId && UPLOAD_SERVER) {
    fetch(`${UPLOAD_SERVER}/stop-signal/${sessionId}`, {
      method: 'POST', headers: { ...authHeaders() },
    }).catch(() => undefined);
  }
  stopHeartbeat();
  stopSyncPoll();
  stopAnnoPoll();
  annoStrokes = []; annoCount = 0;
  const ctx = drawCanvas.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  if (drawMode) toggleDrawMode(); // reset draw mode for next share
  if (ytPlayer) { try { ytPlayer.destroy(); } catch {} ytPlayer = null; }
  videoEl.pause(); videoEl.src = '';
  videoEl.style.display = 'block'; // restore for next local video share
  currentUrl = '';
  showForm();
});

// ── Autoplay helper ────────────────────────────────────────────────────────
// Mobile browsers block autoplay with sound. Strategy:
//   1. Try normal play (works on desktop and after a user gesture)
//   2. If blocked, try muted play (always permitted on mobile) → show unmute prompt
//   3. If even muted fails, fall back to tap-to-play overlay
async function tryPlay(): Promise<void> {
  // YouTube — use the player API directly (no autoplay restrictions)
  if (ytPlayer) {
    try { ytPlayer.playVideo(); } catch {}
    playOverlay.style.display = 'none';
    return;
  }
  // Already playing — don't interrupt muted playback or hide the unmute bar
  if (!videoEl.paused) {
    playOverlay.style.display = 'none';
    return;
  }
  try {
    await videoEl.play();
    // Unmuted play succeeded — only hide the bar if we're not muted
    if (!videoEl.muted) unmuteBar.style.display = 'none';
    playOverlay.style.display = 'none';
  } catch {
    // Play blocked (browser autoplay policy) — try muted
    try {
      videoEl.muted = true;
      await videoEl.play();
      // Muted play worked — show unmute prompt instead of blocking overlay
      unmuteBar.style.display = 'block';
      unmuteBar.onclick = () => {
        videoEl.muted = false;
        unmuteBar.style.display = 'none';
        if (viewerVolumeBar) viewerVolumeBar.value = '100';
        if (viewerMuteBtn)   viewerMuteBtn.textContent = '🔊';
        if (volumeBar)       volumeBar.value = '100';
        if (muteBtn)         muteBtn.textContent = '🔊';
      };
    } catch {
      // Completely blocked — show tap-to-play overlay as last resort
      videoEl.muted = false;
      playOverlay.style.display = 'flex';
    }
  }
}

// ── Resize button — cycles through size presets ────────────────────────────
// Writes to localStorage → storage event fires in main.ts → widget re-created at new size.
const SIZE_LABELS = ['⊡ Small', '⊞ Medium', '⊟ Large'];
const sizeIndexParam = parseInt(params.get('sizeIndex') ?? '1', 10);
if (resizeBtn) resizeBtn.title = `Resize — currently ${SIZE_LABELS[sizeIndexParam] ?? 'Medium'}\nClick to cycle sizes`;

resizeBtn?.addEventListener('click', () => {
  try {
    localStorage.setItem('vs2-resize', String(Date.now())); // value change triggers storage event
  } catch { /* sandboxed */ }
});

// ── Narrow layout detection ────────────────────────────────────────────────
// CSS media queries are unreliable inside Pexip widget iframes (the iframe
// may have a fixed width regardless of screen size). Use JS instead.
function updateLayout() {
  document.body.classList.toggle('narrow', window.innerWidth < 540);
}
updateLayout();
window.addEventListener('resize', updateLayout);

// ── Fullscreen ─────────────────────────────────────────────────────────────
function toggleFullscreen() {
  const isFullscreen = !!(document.fullscreenElement || (document as Record<string,unknown>).webkitFullscreenElement);

  if (!isFullscreen) {
    // For YouTube: try fullscreening the iframe first (works better on mobile)
    if (ytPlayer) {
      const ytFrame = playerInner.querySelector('iframe') as (HTMLIFrameElement & { webkitRequestFullscreen?(): void }) | null;
      if (ytFrame) {
        if (ytFrame.requestFullscreen) { ytFrame.requestFullscreen().catch(() => {}); return; }
        if (ytFrame.webkitRequestFullscreen) { ytFrame.webkitRequestFullscreen(); return; }
      }
    }
    // Standard fullscreen on the whole document
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?(): Promise<void> };
    const req = el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.();
    if (req) {
      (req as Promise<void>).catch(() => {
        const v = videoEl as HTMLVideoElement & { webkitEnterFullscreen?(): void };
        v.webkitEnterFullscreen?.();
      });
    } else {
      const v = videoEl as HTMLVideoElement & { webkitEnterFullscreen?(): void };
      v.webkitEnterFullscreen?.();
    }
  } else {
    const doc = document as Document & { webkitExitFullscreen?(): void };
    doc.exitFullscreen?.(); doc.webkitExitFullscreen?.();
  }
}

fullscreenBtn?.addEventListener('click', toggleFullscreen);
viewerFsBtn?.addEventListener('click', toggleFullscreen);

// Double-click on video also toggles fullscreen (common UX pattern)
videoEl.addEventListener('dblclick', toggleFullscreen);

const onFsChange = () => {
  const isFs = !!(document.fullscreenElement || (document as Record<string,unknown>).webkitFullscreenElement);
  const icon = isFs ? '⊡' : '⛶';
  if (fullscreenBtn) fullscreenBtn.textContent = icon;
  if (viewerFsBtn)   viewerFsBtn.textContent   = icon;
};
document.addEventListener('fullscreenchange',       onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);

// Delete the uploaded file once sharing ends (Stop button or video ended)
function deleteUploadedFile(url: string) {
  if (!url || !url.startsWith(UPLOAD_SERVER)) return;
  fetch(url, { method: 'DELETE', headers: authHeaders() }).catch(() => undefined);
}

// ── Speed control (sharer — synced to viewers via sync-state) ────────────
function applySpeed(speed: number) {
  if (ytPlayer) { try { ytPlayer.setPlaybackRate(speed); } catch {} }
  else { videoEl.playbackRate = speed; }
  if (speedSelect) speedSelect.value = String(speed);
  postSyncState();
}

speedSelect?.addEventListener('change', () => {
  if (!speedSelect) return;
  applySpeed(parseFloat(speedSelect.value));
});

// ── Volume control (local only — each participant sets their own) ─────────
// Volume sliders use 0–100 integer range (decimal steps are unreliable on mobile).
// applyVolume receives a 0–100 value and converts to 0–1 for the video element.
function applyVolume(el: HTMLInputElement | null, muteEl: HTMLButtonElement | null, v100: number) {
  const v = Math.max(0, Math.min(100, Math.round(v100))) / 100;
  if (ytPlayer) {
    // YouTube player has its own volume/mute API
    try {
      if (v === 0) { ytPlayer.mute(); }
      else         { ytPlayer.unMute(); ytPlayer.setVolume(Math.round(v100)); }
    } catch {}
  } else {
    videoEl.volume = v;
    videoEl.muted  = v === 0;
  }
  if (muteEl) muteEl.textContent = v === 0 ? '🔇' : '🔊';
  if (el)     el.value           = String(Math.round(v100));
}

const handleVolume     = () => { if (volumeBar)      applyVolume(volumeBar,      muteBtn,      parseFloat(volumeBar.value));      };
const handleViewerVol  = () => { if (viewerVolumeBar) applyVolume(viewerVolumeBar, viewerMuteBtn, parseFloat(viewerVolumeBar.value)); };

// iOS Safari does not allow programmatic volume control — videoEl.volume is read-only.
// Hide the slider so we don't show a non-functional control; mute button still works.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (isIOS) {
  if (volumeBar)       volumeBar.style.display       = 'none';
  if (viewerVolumeBar) viewerVolumeBar.style.display  = 'none';
}

muteBtn?.addEventListener('click', () => {
  applyVolume(volumeBar, muteBtn, isMuted() ? 100 : 0);
});
volumeBar?.addEventListener('input',  handleVolume);
volumeBar?.addEventListener('change', handleVolume); // fallback for mobile browsers

viewerMuteBtn?.addEventListener('click', () => {
  applyVolume(viewerVolumeBar, viewerMuteBtn, isMuted() ? 100 : 0);
});
viewerVolumeBar?.addEventListener('input',  handleViewerVol);
viewerVolumeBar?.addEventListener('change', handleViewerVol); // fallback for mobile browsers

// ── Post sync state to server (sharer → server → viewer poll) ─────────────
function postSyncState() {
  if (!sessionId) return;
  fetch(`${UPLOAD_SERVER}/sync-state/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ time: getCurrentTime(), playing: !isPaused(), speed: ytPlayer ? 1 : videoEl.playbackRate }),
  }).catch(() => undefined);
}

// ── Viewer: poll server for sync state ────────────────────────────────────
function startSyncPoll() {
  stopSyncPoll();
  syncPollTimer = setInterval(() => { applySyncFromServer(); }, 1000);
}
function stopSyncPoll() {
  if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }
  stopAnnoPoll();
  unregisterAsViewer();
}

async function applySyncFromServer() {
  if (!sessionId) return;
  try {
    const res  = await fetch(`${UPLOAD_SERVER}/sync-state/${sessionId}`, { cache: 'no-store', headers: authHeaders() });
    const data = await res.json() as { time: number; playing: boolean; speed?: number; updatedAt: number } | null;
    if (!data) return;
    // Sharer disconnect detection — no sync update for >30 s means they stopped sharing
    const age = (Date.now() - data.updatedAt) / 1000;
    if (age > 30) {
      setStatus('⚠ Sharer may have disconnected.', true);
      return;
    }

    // Project the sharer's position forward, accounting for playback speed.
    // e.g. at 2× speed, 5 seconds of wall-clock time = 10 seconds of video.
    const speed = data.speed ?? 1;
    const expectedTime = data.playing ? data.time + age * speed : data.time;

    // Only correct if meaningfully out of sync (>3 seconds drift)
    const drift = Math.abs(getCurrentTime() - expectedTime);
    if (drift > 3) {
      if (ytPlayer) { ytPlayer.seekTo(expectedTime, true); }
      else           { videoEl.currentTime = expectedTime; }
    }

    // Sync playback speed (sharer-controlled, local video only)
    if (!ytPlayer && data.speed && Math.abs(data.speed - videoEl.playbackRate) > 0.01) {
      videoEl.playbackRate = data.speed;
    }

    // Sync play/pause state
    if (ytPlayer) {
      if (data.playing && isPaused()) ytPlayer.playVideo();
      else if (!data.playing && !isPaused()) ytPlayer.pauseVideo();
    } else {
      if (data.playing && videoEl.paused) { void tryPlay(); }
      else if (!data.playing && !videoEl.paused) { videoEl.pause(); }
    }
    updatePlayPause();
  } catch { /* server unreachable */ }
}

// ── Seek bar ───────────────────────────────────────────────────────────────
function startSeekUpdater() {
  cancelAnimationFrame(seekRafId);
  const tick = () => {
    if (!isSeeking_ && !isSeeking2) {
      const pos = getCurrentTime();
      const dur = getDuration();
      seekBarEl.value = String(dur > 0 ? Math.round((pos / dur) * 1000) : 0);
      timeDisplay.textContent = `${fmt(pos)} / ${fmt(dur)}`;
      updatePlayPause();
    }
    seekRafId = requestAnimationFrame(tick);
  };
  seekRafId = requestAnimationFrame(tick);
}

function updatePlayPause() {
  playPauseBtn.textContent = isPaused() ? '▶' : '⏸';
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

// ── Annotation drawing ─────────────────────────────────────────────────────

function resizeCanvas() {
  const rect = drawCanvas.getBoundingClientRect();
  if (rect.width === 0) return;
  drawCanvas.width  = rect.width;
  drawCanvas.height = rect.height;
  redrawAnnotations();
}

function getCanvasPos(e: MouseEvent | Touch): { x: number; y: number } {
  const rect = drawCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top)  / rect.height,
  };
}

function redrawAnnotations() {
  const ctx = drawCanvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  for (const stroke of annoStrokes) {
    if (stroke.points.length < 2) continue;
    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth   = Math.max(2, stroke.width * drawCanvas.width / 800);
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    const [first, ...rest] = stroke.points;
    ctx.moveTo(first.x * drawCanvas.width, first.y * drawCanvas.height);
    for (const p of rest) ctx.lineTo(p.x * drawCanvas.width, p.y * drawCanvas.height);
    ctx.stroke();
  }
}

function onDrawStart(e: MouseEvent | TouchEvent) {
  if (!drawMode) return;
  e.preventDefault();
  isDrawing = true;
  const pos = 'touches' in e ? getCanvasPos(e.touches[0]) : getCanvasPos(e);
  currentStroke = [pos];
}

function onDrawMove(e: MouseEvent | TouchEvent) {
  if (!drawMode || !isDrawing) return;
  e.preventDefault();
  const pos = 'touches' in e ? getCanvasPos(e.touches[0]) : getCanvasPos(e);
  currentStroke.push(pos);
  const ctx = drawCanvas.getContext('2d');
  if (!ctx || currentStroke.length < 2) return;
  const prev = currentStroke[currentStroke.length - 2];
  ctx.beginPath();
  ctx.strokeStyle = drawColor;
  ctx.lineWidth   = Math.max(2, 3 * drawCanvas.width / 800);
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.moveTo(prev.x * drawCanvas.width, prev.y * drawCanvas.height);
  ctx.lineTo(pos.x  * drawCanvas.width, pos.y  * drawCanvas.height);
  ctx.stroke();
}

async function onDrawEnd() {
  if (!drawMode || !isDrawing) return;
  isDrawing = false;
  if (currentStroke.length < 2) { currentStroke = []; return; }
  const stroke = {
    id:     `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    points: currentStroke,
    color:  drawColor,
    width:  3,
  };
  currentStroke = [];
  annoStrokes.push(stroke);
  annoCount = annoStrokes.length;
  if (sessionId && UPLOAD_SERVER) {
    fetch(`${UPLOAD_SERVER}/annotations/${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ stroke }),
    }).catch(() => undefined);
  }
}

function toggleDrawMode() {
  drawMode = !drawMode;
  drawCanvas.classList.toggle('active', drawMode);
  colorSwatchesEl.classList.toggle('visible', drawMode);
  viewerColorSwatches.classList.toggle('visible', drawMode);
  if (clearDrawBtn)      clearDrawBtn.style.display      = drawMode ? '' : 'none';
  if (viewerClearDrawBtn) viewerClearDrawBtn.style.display = drawMode ? '' : 'none';
  drawBtn?.classList.toggle('draw-active', drawMode);
  viewerDrawBtn?.classList.toggle('draw-active', drawMode);
  if (!drawMode) redrawAnnotations(); // clean up any in-progress stroke artifacts
}

async function clearAnnotations() {
  annoStrokes = [];
  annoCount   = 0;
  const ctx = drawCanvas.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  if (sessionId && UPLOAD_SERVER) {
    fetch(`${UPLOAD_SERVER}/annotations/${sessionId}`, {
      method: 'DELETE', headers: authHeaders(),
    }).catch(() => undefined);
  }
}

function startAnnoPoll() {
  if (annoPollTimer) return;
  annoPollTimer = setInterval(async () => {
    if (!sessionId || !UPLOAD_SERVER) return;
    try {
      const res  = await fetch(`${UPLOAD_SERVER}/annotations/${sessionId}`, {
        cache: 'no-store', headers: authHeaders(),
      });
      const data = await res.json() as { strokes: typeof annoStrokes };
      if (data.strokes.length !== annoCount) {
        annoStrokes = data.strokes;
        annoCount   = data.strokes.length;
        redrawAnnotations();
      }
    } catch { /* server unreachable */ }
  }, 500);
}

function stopAnnoPoll() {
  if (annoPollTimer) { clearInterval(annoPollTimer); annoPollTimer = null; }
}

// Canvas events
drawCanvas.addEventListener('mousedown',  onDrawStart);
drawCanvas.addEventListener('mousemove',  onDrawMove);
drawCanvas.addEventListener('mouseup',    () => { void onDrawEnd(); });
drawCanvas.addEventListener('mouseleave', () => { void onDrawEnd(); });
drawCanvas.addEventListener('touchstart', onDrawStart, { passive: false });
drawCanvas.addEventListener('touchmove',  onDrawMove,  { passive: false });
drawCanvas.addEventListener('touchend',   () => { void onDrawEnd(); });

// Draw / clear buttons
drawBtn?.addEventListener('click',            toggleDrawMode);
viewerDrawBtn?.addEventListener('click',      toggleDrawMode);
clearDrawBtn?.addEventListener('click',       () => { void clearAnnotations(); });
viewerClearDrawBtn?.addEventListener('click', () => { void clearAnnotations(); });

// Color swatch selection — shared between sharer and viewer swatches
document.querySelectorAll<HTMLButtonElement>('.color-swatch').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    drawColor = btn.dataset.color ?? '#ff4444';
  });
});

// Resize canvas when video-wrap changes size (widget resize, window resize)
new ResizeObserver(() => {
  if (playerViewEl.style.display !== 'none') resizeCanvas();
}).observe(document.getElementById('video-wrap')!);

// ── UI helpers ─────────────────────────────────────────────────────────────
// ── Viewer presence ────────────────────────────────────────────────────────

function registerAsViewer() {
  if (isSharer || !sessionId || !UPLOAD_SERVER || viewerRegistered) return;
  viewerRegistered = true;

  // selfName is passed from main.ts via URL params — already the real display name.
  fetch(`${UPLOAD_SERVER}/viewers/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ id: viewerId, name: selfName }),
  }).catch(() => undefined);
}

function unregisterAsViewer() {
  if (!viewerRegistered || !sessionId || !UPLOAD_SERVER) return;
  viewerRegistered = false;
  fetch(`${UPLOAD_SERVER}/viewers/${sessionId}/${viewerId}`, {
    method: 'DELETE', headers: authHeaders(),
  }).catch(() => undefined);
}

// Sharer: poll viewer count every 5 s and show in controls bar
function startViewerCount() {
  const countEl = document.getElementById('viewer-count');
  if (!countEl || !sessionId || !UPLOAD_SERVER) return;
  viewerCountTimer = setInterval(async () => {
    try {
      const res  = await fetch(`${UPLOAD_SERVER}/viewers/${sessionId}`, { cache: 'no-store', headers: authHeaders() });
      const data = await res.json() as { count: number; viewers: { name: string }[] };
      countEl.textContent = String(data.count);
      const presence = document.getElementById('viewer-presence');
      if (presence) presence.title = data.viewers.map(v => v.name).join(', ') || 'No viewers yet';
    } catch { /* server unreachable */ }
  }, 5000);
}

function stopViewerCount() {
  if (viewerCountTimer) { clearInterval(viewerCountTimer); viewerCountTimer = null; }
}

function showPlayer(asSharer: boolean) {
  shareFormEl.style.display  = 'none';
  playerViewEl.style.display = 'flex';
  controlsEl.style.display   = asSharer ? 'flex' : 'none';
  viewerBar.style.display    = asSharer ? 'none'  : 'block';
  if (pushSyncBtn) pushSyncBtn.style.display = 'none'; // removed — seek bar already syncs
  pullSyncBtn.style.display  = asSharer ? 'none' : ''; // viewer only (in viewer bar)
  if (speedSelect) speedSelect.style.display = asSharer ? '' : 'none';
  if (muteBtn)     muteBtn.style.display     = asSharer ? '' : 'none';
  if (volumeBar)   volumeBar.style.display   = asSharer ? '' : 'none';
  if (!asSharer && sharerName) sharerLabel.textContent = sharerName;
  // YouTube has its own native fullscreen button — hide ours to avoid confusion
  if (fullscreenBtn) fullscreenBtn.style.display = isYouTube ? 'none' : '';
  if (viewerFsBtn)   viewerFsBtn.style.display   = isYouTube ? 'none' : '';
  if (resizeBtn)     resizeBtn.style.display      = isYouTube ? 'none' : '';
  if (!asSharer) {
    startSyncPoll();
    registerAsViewer();
  }
  if (asSharer) startViewerCount();
  requestAnimationFrame(() => resizeCanvas());
  startAnnoPoll();
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
if (isSharer && !initialUrl) {
  // Fresh share — show the upload form
  showForm();
} else if (isSharer && initialUrl) {
  // Sharer re-opened after minimising — resume video and restart heartbeat
  loadVideo(initialUrl, initTime, false);
  showPlayer(true);
  startHeartbeat();
} else if (initialUrl) {
  loadVideo(initialUrl, initTime, initPlaying);
  showPlayer(false);
  // Late-joiner indicator — show sync message then clear after video loads
  if (initTime > 0) {
    setStatus('Syncing to current position…');
    videoEl.addEventListener('loadedmetadata', () => {
      setTimeout(() => setStatus(''), 2000);
    }, { once: true });
  }
}
