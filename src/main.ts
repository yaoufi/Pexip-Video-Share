import { registerPlugin } from '@pexip/plugin-api';
import type { SyncMessage } from './types';
import { DEFAULT_UPLOAD_SERVER, DEFAULT_API_KEY } from './constants';

const SETTINGS_KEY_SERVER = 'vs2-upload-server';
const SETTINGS_KEY_APIKEY = 'vs2-api-key';

const plugin = await registerPlugin({ id: 'video-share2', version: 0 });

// ── Resolve config from manifest + localStorage ────────────────────────────
// Priority: localStorage (settings button) → manifest.json → empty
async function resolveConfig(): Promise<{ uploadServer: string; apiKey: string }> {
  // Start with hardcoded defaults — guaranteed to work for this deployment
  let uploadServer = DEFAULT_UPLOAD_SERVER;
  let apiKey       = DEFAULT_API_KEY;

  // localStorage overrides (set via the settings button)
  const storedServer = localStorage.getItem(SETTINGS_KEY_SERVER);
  const storedKey    = localStorage.getItem(SETTINGS_KEY_APIKEY);
  if (storedServer) uploadServer = storedServer;
  if (storedKey)    apiKey       = storedKey;

  // Manifest overrides (set by customer in their branding manifest.json)
  // Plugin: .../webapp3/branding/plugins/video-share2/index.html
  // Manifest: .../webapp3/branding/manifest.json  (two levels up)
  try {
    const manifestUrl = new URL('../../manifest.json', window.location.href).href;
    const manifest    = await fetch(manifestUrl, { cache: 'no-store' }).then(r => r.json()) as Record<string, unknown>;
    const cfg         = manifest.videoShare as Record<string, string> | undefined;
    if (cfg?.uploadServer) uploadServer = cfg.uploadServer.replace(/\/$/, '');
    if (cfg?.apiKey)       apiKey       = cfg.apiKey;
  } catch { /* manifest not reachable — use defaults */ }

  return { uploadServer, apiKey };
}

const config = await resolveConfig();
let uploadServer = config.uploadServer;
let apiKey       = config.apiKey;

let selfUuid  = '';
let selfName  = 'Participant';
let activeWidget: Awaited<ReturnType<typeof plugin.ui.addWidget>> | null = null;
let pollTimer:     ReturnType<typeof setInterval> | null = null;
let stopPollTimer: ReturnType<typeof setInterval> | null = null;
let isSharing = false;
let currentVideo:    { url: string; sharerName: string; sessionId: string } | null = null;
let lastOpenedUrl  = ''; // deduplication — ignores repeated video:open for the same URL

// Generated fresh on each share — prevents stop-signals from previous shares
// bleeding into the next share (was the root cause of the 50% alternating bug).
function newShareId() { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
let currentShareId = '';

plugin.events.me.add((me: unknown) => {
  const p = me as Record<string, string>;
  selfUuid = p.uuid ?? selfUuid;
  selfName  = p.displayName ?? p.name ?? 'Participant';
});

// ── Build widget URL ───────────────────────────────────────────────────────
function playerUrl(extra: Record<string, string>): string {
  const base = new URL('./player/player.html', window.location.href).href;
  return `${base}?${new URLSearchParams(extra)}`;
}

async function openWidget(params: Record<string, string>, title: string) {
  if (activeWidget) {
    try { await activeWidget.remove(); } catch { /* already removed or stale */ }
    activeWidget = null;
  }
  activeWidget = await plugin.ui.addWidget({
    src: playerUrl({ ...params, serverUrl: uploadServer, apiKey }),
    type: 'floating',
    title,
    draggable: true,
    isVisible: true,
    dimensions: { width: '760px', height: '520px' },
  });
}

// ── Reliable send: retry sendApplicationMessage up to 3 times ─────────────
// Pexip sometimes drops messages (race conditions, internal queue). Retrying
// with a short delay makes delivery much more reliable.
async function sendReliable(payload: Record<string, unknown>) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
    try {
      await plugin.conference.sendApplicationMessage({ payload });
    } catch { /* retry */ }
  }
}

// ── Settings button — configure server URL ─────────────────────────────────
const settingsBtn = await plugin.ui.addButton({
  position: 'settingsMenu',
  label: 'Video Share — Server Settings',
  inMeetingOnly: false,
});

settingsBtn.onClick.add(async () => {
  const result = await plugin.ui.showForm({
    title: 'Video Share — Server Settings',
    description: 'Override the server URL and API key from manifest.json. Leave blank to use the manifest values.',
    form: {
      elements: {
        serverUrl: { name: 'Upload Server URL', type: 'url',      value: uploadServer, autoComplete: 'off' },
        apiKey:    { name: 'API Key',           type: 'password', value: apiKey,        autoComplete: 'off' },
      },
      submitBtnTitle: 'Save',
    },
  });
  if (!result) return;
  const r = result as Record<string, string>;
  const newUrl = r.serverUrl?.trim().replace(/\/$/, '') ?? '';
  const newKey = r.apiKey?.trim() ?? '';

  uploadServer = newUrl;
  apiKey       = newKey;

  if (newUrl) localStorage.setItem(SETTINGS_KEY_SERVER, newUrl);
  else        localStorage.removeItem(SETTINGS_KEY_SERVER);

  if (newKey) localStorage.setItem(SETTINGS_KEY_APIKEY, newKey);
  else        localStorage.removeItem(SETTINGS_KEY_APIKEY);

  await plugin.ui.showToast({ message: 'Settings saved.' });
});

// ── Poll /pending-share until the widget signals the uploaded URL ──────────
function startPolling(sessionId: string) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res  = await fetch(`${uploadServer}/pending-share/${sessionId}`, {
        cache: 'no-store',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      const data = await res.json() as { url: string | null };
      if (!data.url) return;

      clearInterval(pollTimer!); pollTimer = null;

      const payload: SyncMessage = {
        type:       'video:open',
        url:        data.url,
        sharerName: selfName,
        senderUuid: selfUuid,
        sessionId,
      };
      // Retry up to 3 times — Pexip sometimes drops messages
      void sendReliable(payload as Record<string, unknown>);

      // Now poll for stop signal — widget POSTs here when Stop is clicked
      startStopPolling(sessionId);

    } catch { /* server unreachable */ }
  }, 2000);
}

// ── Poll /stop-signal after a video:open is sent ─────────────────────────
// Widget signals stop via server (same relay pattern as video:open).
// main.ts polls here and calls sendApplicationMessage from the trusted context.
function startStopPolling(sessionId: string) {
  if (stopPollTimer) clearInterval(stopPollTimer);
  stopPollTimer = setInterval(async () => {
    try {
      const res  = await fetch(`${uploadServer}/stop-signal/${sessionId}`, {
        cache: 'no-store',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      const data = await res.json() as { stopped: boolean };
      if (!data.stopped) return;
      console.log('[vs2] stop-signal detected for session', sessionId);

      clearInterval(stopPollTimer!); stopPollTimer = null;
      isSharing    = false;
      currentVideo = null;
      if (activeWidget) {
        try { await activeWidget.remove(); } catch { /* already gone */ }
        activeWidget = null;
      }
      void sendReliable({ type: 'video:stop', senderUuid: selfUuid });
    } catch { /* server unreachable */ }
  }, 500); // 500 ms — fast enough for near-instant stop on remote
}

// ── Share Video toolbar button ─────────────────────────────────────────────
const shareBtn = await plugin.ui.addButton({
  position: 'toolbar',
  icon: 'IconPlayRound',
  tooltip: 'Share Video',
});

shareBtn.onClick.add(async () => {
  // Viewer re-opening a closed widget — but first verify the share is still active
  if (!isSharing && currentVideo) {
    try {
      const r = await fetch(`${uploadServer}/stop-signal/${currentVideo.sessionId}`, {
        cache: 'no-store',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      const d = await r.json() as { stopped: boolean };
      if (d.stopped) {
        // Share already ended — clear stale state and fall through to sharer mode
        currentVideo = null;
      }
    } catch { /* unreachable — assume still active */ }

    if (currentVideo) {
      await openWidget(
        { role: 'viewer', url: currentVideo.url, sharerName: currentVideo.sharerName, selfUuid, sessionId: currentVideo.sessionId },
        `${currentVideo.sharerName} is sharing`,
      );
      return;
    }
  }

  // Sharer opening the upload form
  if (!uploadServer) {
    await plugin.ui.showToast({
      message: 'No upload server configured. Open "Video Share Settings" in the ⋮ menu.',
      isDanger: true,
    });
    return;
  }

  isSharing = true;
  if (stopPollTimer) { clearInterval(stopPollTimer); stopPollTimer = null; }
  currentShareId = newShareId(); // fresh ID — isolated from any previous share's stop-signal
  startPolling(currentShareId);
  await openWidget(
    { role: 'sharer', selfUuid, sharerName: selfName, sessionId: currentShareId },
    'Share Video',
  );
});

// ── Incoming messages ──────────────────────────────────────────────────────
plugin.events.applicationMessage.add(async (event: unknown) => {
  try {
    const msg = (event as { message: SyncMessage }).message;
    if (!('type' in msg) || !msg.type.startsWith('video:')) return;
    if (selfUuid && msg.senderUuid === selfUuid) return;

    const sid = (msg as unknown as Record<string, string>).sessionId ?? '';

    switch (msg.type) {
      case 'video:open':
        if (isSharing) break;
        if (msg.url === lastOpenedUrl) break; // duplicate retry — already opened
        lastOpenedUrl = msg.url;
        currentVideo = { url: msg.url, sharerName: msg.sharerName, sessionId: sid };
        await openWidget(
          { role: 'viewer', url: msg.url, sharerName: msg.sharerName, selfUuid, sessionId: sid },
          `${msg.sharerName} is sharing`,
        );
        break;

      case 'video:stop':
        isSharing     = false;
        currentVideo  = null;
        lastOpenedUrl = '';
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (activeWidget) { await activeWidget.remove(); activeWidget = null; }
        break;

      case 'video:heartbeat':
        currentVideo = { url: msg.url, sharerName: msg.sharerName, sessionId: sid };
        if (!activeWidget && !isSharing) {
          await openWidget(
            { role: 'viewer', url: msg.url, sharerName: msg.sharerName, selfUuid, sessionId: sid, initTime: String(msg.time), initPlaying: String(msg.playing) },
            `${msg.sharerName} is sharing`,
          );
        }
        break;
    }
  } catch (err) {
    console.error('[vs2] applicationMessage error:', err);
  }
});

// ── On join: ask if a video is already being shared ───────────────────────
try {
  await plugin.conference.sendApplicationMessage({
    payload: { type: 'video:request-sync', senderUuid: selfUuid } satisfies SyncMessage,
  });
} catch { /* not in conference yet */ }
