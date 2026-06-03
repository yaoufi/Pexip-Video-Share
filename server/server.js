const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const { execFile } = require('child_process');

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PORT       = process.env.PORT ?? 4001;
const API_KEY    = process.env.VS2_API_KEY ?? '';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Storage: timestamped filenames (same approach as M&M upload.js) ────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const ext    = path.extname(file.originalname);
    cb(null, `${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
});

const app = express();
app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',   '*');
  res.setHeader('Access-Control-Allow-Methods',  'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',  'Content-Type, Range, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  // Preflight: respond immediately before auth check (browser never sends auth on OPTIONS)
  if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// ── Serve uploaded files — NO auth required ────────────────────────────────
// Files use random UUID-based names so the URL itself is the secret.
// The <video> element cannot send Authorization headers, so this must be open.
// express.static handles Range requests natively for video seeking.
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders: (res) => { res.setHeader('Accept-Ranges', 'bytes'); },
}));

// ── Health check — NO auth required (monitoring) ───────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── API key auth — applied to all remaining routes ─────────────────────────
// Set VS2_API_KEY in the environment. If unset, server is open (dev/test mode).
app.use((req, res, next) => {
  if (!API_KEY) { next(); return; }
  const provided = (req.headers.authorization ?? '').replace('Bearer ', '').trim();
  if (provided !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
});

// ── MP4 fast-start optimisation ────────────────────────────────────────────
// Moves the moov atom to the front of the file so browsers can start
// streaming immediately without downloading the whole file first.
// Falls back silently for non-MP4 formats (WebM, AVI, etc.).
function fastStart(filePath) {
  return new Promise((resolve) => {
    const tmpPath = filePath + '.faststart.tmp';
    const name    = require('path').basename(filePath);

    execFile('ffmpeg', [
      '-i', filePath,
      '-c', 'copy',
      '-movflags', 'faststart',
      '-f', 'mp4',          // explicit format — required when output extension is not .mp4
      '-y',
      tmpPath
    ], { timeout: 120_000 }, (err, _stdout, stderr) => {
      if (err) {
        fs.unlink(tmpPath, () => {});
        // Log the reason so we can diagnose mobile incompatibilities
        const reason = (stderr || err.message || '').split('\n').filter(l =>
          l.includes('Error') || l.includes('Invalid') || l.includes('not supported')
        ).slice(0, 2).join(' | ') || err.message;
        console.log(`[ffmpeg] ${name} — skipped fast-start: ${reason}`);
        resolve(false);
      } else {
        fs.rename(tmpPath, filePath, (e) => {
          if (e) {
            console.log(`[ffmpeg] ${name} — rename failed: ${e.message}`);
            resolve(false);
          } else {
            console.log(`[ffmpeg] ${name} — fast-start OK`);
            resolve(true);
          }
        });
      }
    });
  });
}

// ── Upload endpoint ────────────────────────────────────────────────────────
app.post('/upload', upload.array('files'), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files received.' });
  }

  // Build fully-qualified URLs, respecting X-Forwarded-* headers from a reverse proxy
  const protocol = req.headers['x-forwarded-proto'] ?? req.protocol;
  const host     = req.headers['x-forwarded-host']  ?? req.get('host');

  // Optimise each file for web streaming (fast-start) before returning URLs.
  // Runs in parallel; non-video files fail silently and keep the original.
  await Promise.all(req.files.map(f => fastStart(f.path)));

  const uploaded = req.files.map((file) => {
    const url = `${protocol}://${host}/uploads/${file.filename}`;
    console.log(`[upload] ${file.originalname} → ${url}`);
    return {
      originalName: file.originalname,
      filename:     file.filename,
      size:         file.size,
      mimetype:     file.mimetype,
      url,
    };
  });

  res.json({ files: uploaded });
});

// ── Delete an uploaded file ────────────────────────────────────────────────
app.delete('/uploads/:filename', (req, res) => {
  // path.basename prevents path traversal (e.g. ../../etc/passwd)
  const filename = path.basename(req.params.filename);
  const filePath = path.join(UPLOAD_DIR, filename);
  fs.unlink(filePath, (err) => {
    if (err) return res.status(404).json({ error: 'File not found' });
    console.log(`[delete] ${filename}`);
    res.json({ ok: true });
  });
});


// ── Viewer presence tracking ──────────────────────────────────────────────
// Viewers register when they open the player and deregister when they close.
// Sharer polls /viewers/:sessionId to display a live watcher count + names.
const viewers = {}; // sessionId → { [viewerId]: { name, joinedAt } }

app.post('/viewers/:sessionId', (req, res) => {
  const { id, name } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  if (!viewers[req.params.sessionId]) viewers[req.params.sessionId] = {};
  viewers[req.params.sessionId][id] = { name: name || 'Viewer', joinedAt: Date.now() };
  res.json({ ok: true });
});

app.delete('/viewers/:sessionId/:viewerId', (req, res) => {
  const s = viewers[req.params.sessionId];
  if (s) delete s[req.params.viewerId];
  res.json({ ok: true });
});

app.get('/viewers/:sessionId', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache');
  const s = viewers[req.params.sessionId] ?? {};
  const list = Object.values(s);
  res.json({ count: list.length, viewers: list });
});

// ── Signaling: stop signal ────────────────────────────────────────────────
// Widget can't call sendApplicationMessage; it POSTs here when Stop is clicked.
// main.ts polls this and calls sendApplicationMessage({ type: 'video:stop' }).
const stopSignals = {}; // sessionId → true

app.post('/stop-signal/:sessionId', (req, res) => {
  stopSignals[req.params.sessionId] = Date.now();
  console.log(`[stop-signal] session=${req.params.sessionId}`);
  res.json({ ok: true });
});

// Non-consuming GET — both main.ts poll and toolbar check can read it.
// Auto-expires after 30 s so stale signals don't block future shares.
app.get('/stop-signal/:sessionId', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache');
  const ts = stopSignals[req.params.sessionId];
  const stopped = !!ts && (Date.now() - ts) < 30_000;
  if (ts && !stopped) delete stopSignals[req.params.sessionId]; // clean up expired
  res.json({ stopped });
});

// ── Signaling: pending share ───────────────────────────────────────────────
// Widget can't call sendApplicationMessage directly (Pexip sandbox restriction).
// Instead: widget POSTs the URL here after upload; main.ts polls and calls
// sendApplicationMessage from the trusted plugin context.
const pendingShares = {}; // sessionId → { url, sharerName }

app.post('/pending-share', (req, res) => {
  const { sessionId, url, sharerName } = req.body;
  if (!sessionId || !url) return res.status(400).json({ error: 'sessionId and url required' });
  pendingShares[sessionId] = { url, sharerName: sharerName || 'Participant' };
  console.log(`[pending-share] session=${sessionId} url=${url}`);
  res.json({ ok: true });
});

app.get('/pending-share/:sessionId', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache');
  res.setHeader('Pragma', 'no-cache');
  const share = pendingShares[req.params.sessionId];
  if (share) {
    delete pendingShares[req.params.sessionId]; // consume once
    return res.json(share);
  }
  res.json({ url: null });
});

// ── Signaling: playback sync state ────────────────────────────────────────
// Sharer widget POSTs current play/pause/seek state here.
// Viewer widgets poll this endpoint every second to stay in sync.
const syncStates = {}; // sessionId → { time, playing, updatedAt }

app.post('/sync-state/:sessionId', (req, res) => {
  const { time, playing, speed } = req.body;
  syncStates[req.params.sessionId] = { time, playing, speed: speed ?? 1, updatedAt: Date.now() };
  res.json({ ok: true });
});

app.get('/sync-state/:sessionId', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache');
  res.setHeader('Pragma', 'no-cache');
  res.json(syncStates[req.params.sessionId] || null);
});

// ── Clean up uploads older than 24 h, every hour ──────────────────────────
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const p = path.join(UPLOAD_DIR, file);
      fs.stat(p, (e, stat) => {
        if (!e && stat.mtimeMs < cutoff) {
          fs.unlink(p, () => undefined);
          console.log(`[cleanup] ${file}`);
        }
      });
    });
  });
}, 60 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n[video-share2 server] http://0.0.0.0:${PORT}`);
  console.log(`  Auth: ${API_KEY ? 'API key required (VS2_API_KEY set)' : 'OPEN — set VS2_API_KEY to enable auth'}`);
  console.log(`  POST   /upload          — upload a video file`);
  console.log(`  GET    /uploads/:file   — serve uploaded file`);
  console.log(`  DELETE /uploads/:file   — delete uploaded file`);
  console.log(`  POST   /pending-share   — signal main.ts of uploaded URL`);
  console.log(`  GET    /sync-state/:id  — playback sync polling`);
  console.log(`\n  NOTE: Deploy behind HTTPS when using inside Pexip.\n`);
});
