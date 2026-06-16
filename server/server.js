const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const https      = require('https');
const { execFile } = require('child_process');

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const SLIDES_DIR = path.join(UPLOAD_DIR, 'slides');
const PORT       = process.env.PORT ?? 4001;
const API_KEY    = process.env.VS2_API_KEY ?? '';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(SLIDES_DIR)) fs.mkdirSync(SLIDES_DIR, { recursive: true });

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
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
});

const slideUpload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
  fileFilter: (_req, file, cb) => {
    const ok = /\.(pptx|pdf)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .pptx and .pdf files are allowed'), ok);
  },
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

// ── Helper: run a CLI command as a promise ─────────────────────────────────
function runCmd(cmd, args) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 120_000 }, (err) => err ? reject(err) : resolve()));
}

// ── Serve uploaded files — NO auth required ────────────────────────────────
// Files use random UUID-based names so the URL itself is the secret.
// The <video> element cannot send Authorization headers, so this must be open.
// express.static handles Range requests natively for video seeking.
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders: (res) => { res.setHeader('Accept-Ranges', 'bytes'); },
}));

// ── Serve slide images — NO auth required ─────────────────────────────────
// <img> elements cannot send Authorization headers, so this must be open.
// The random sessionId in the path is the effective secret.
app.get('/slides/:sessionId/:index', (req, res) => {
  const sessionId = path.basename(req.params.sessionId);
  const index     = parseInt(req.params.index, 10);
  if (isNaN(index) || index < 0) return res.status(400).end();
  const file = path.join(SLIDES_DIR, sessionId, `${index}.png`);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

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
  delete annotations[req.params.sessionId];    // clean up annotations when sharing stops
  delete laserPositions[req.params.sessionId]; // clean up laser positions
  delete slideStates[req.params.sessionId];    // clean up slide state
  fs.rm(path.join(SLIDES_DIR, req.params.sessionId), { recursive: true, force: true }, () => {});
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

// ── Annotations ───────────────────────────────────────────────────────────
// Any participant can draw on the canvas overlay. Strokes are stored per
// session and polled by all participants every 500 ms.
const annotations = {}; // sessionId → [{ id, points:[{x,y}], color, width }]

app.post('/annotations/:sessionId', (req, res) => {
  const { stroke } = req.body;
  if (!stroke) return res.status(400).json({ error: 'stroke required' });
  if (!annotations[req.params.sessionId]) annotations[req.params.sessionId] = [];
  annotations[req.params.sessionId].push(stroke);
  res.json({ ok: true });
});

app.get('/annotations/:sessionId', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache');
  res.json({ strokes: annotations[req.params.sessionId] ?? [] });
});

app.delete('/annotations/:sessionId', (req, res) => {
  annotations[req.params.sessionId] = [];
  console.log(`[annotations] cleared session=${req.params.sessionId}`);
  res.json({ ok: true });
});

app.delete('/annotations/:sessionId/:strokeId', (req, res) => {
  const strokes = annotations[req.params.sessionId];
  if (strokes) {
    annotations[req.params.sessionId] = strokes.filter(s => s.id !== req.params.strokeId);
  }
  res.json({ ok: true });
});

// ── YouTube embeddability check ────────────────────────────────────────────
// Hits YouTube's oEmbed API server-side to check if a video allows embedding
// before the sharer broadcasts it to other participants.
// Returns { embeddable: true/false, status: <http status> }
app.get('/check-youtube/:videoId', (req, res) => {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(req.params.videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${req.params.videoId}`)}&format=json`;
  const request = https.get(oembedUrl, { timeout: 5000 }, (r) => {
    res.json({ embeddable: r.statusCode === 200, status: r.statusCode });
    r.resume(); // drain without buffering
  });
  request.on('error', (err) => res.json({ embeddable: true, error: String(err) }));
  request.on('timeout', () => { request.destroy(); res.json({ embeddable: true, error: 'timeout' }); });
});

// ── Slide conversion ──────────────────────────────────────────────────────
// Accepts .pptx or .pdf, converts to PNG images via LibreOffice + pdftoppm.
// Images stored at SLIDES_DIR/<sessionId>/<index>.png (0-indexed).
app.post('/convert-slides', slideUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const inputPath = req.file.path;
  const outDir    = path.join(SLIDES_DIR, path.basename(sessionId));
  fs.mkdirSync(outDir, { recursive: true });

  let pdfPath = inputPath;
  try {
    if (/\.pptx$/i.test(req.file.originalname)) {
      // Step 1: PPTX → PDF
      const tmpDir = path.dirname(inputPath);
      await runCmd('libreoffice', [
        '--headless', '--convert-to', 'pdf', '--outdir', tmpDir, inputPath,
      ]);
      pdfPath = inputPath.replace(/\.[^.]+$/, '.pdf');
    }

    // Step 2: PDF → PNGs  (pdftoppm names: slide-1.png, slide-2.png, …)
    await runCmd('pdftoppm', ['-r', '150', '-png', pdfPath, path.join(outDir, 'slide')]);

    // Rename to 0-indexed: slide-1.png → 0.png, slide-2.png → 1.png, …
    const files = fs.readdirSync(outDir)
      .filter(f => /^slide-\d+\.png$/.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

    files.forEach((f, i) =>
      fs.renameSync(path.join(outDir, f), path.join(outDir, `${i}.png`)));

    console.log(`[convert-slides] session=${sessionId} slides=${files.length}`);
    res.json({ slideCount: files.length });
  } catch (err) {
    fs.rm(outDir, { recursive: true, force: true }, () => {});
    console.error(`[convert-slides] error: ${err}`);
    res.status(500).json({ error: String(err) });
  } finally {
    fs.unlink(inputPath, () => {});
    if (pdfPath !== inputPath) fs.unlink(pdfPath, () => {});
  }
});

// ── Slide state (current slide index) ─────────────────────────────────────
const slideStates = {}; // sessionId → { index }

app.post('/slide-state/:sessionId', (req, res) => {
  const index = parseInt(req.body.index, 10);
  if (isNaN(index)) return res.status(400).json({ error: 'index required' });
  slideStates[req.params.sessionId] = { index };
  res.json({ ok: true });
});

app.get('/slide-state/:sessionId', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache');
  res.json(slideStates[req.params.sessionId] ?? { index: 0 });
});

// ── Laser pointer positions ────────────────────────────────────────────────
// Each participant POSTs their cursor position while laser mode is active.
// Positions auto-expire after 2 s (no explicit DELETE needed).
const laserPositions = {}; // sessionId → { [userId]: { x, y, name, color, updatedAt } }

app.post('/laser/:sessionId', (req, res) => {
  const { userId, x, y, name, color } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!laserPositions[req.params.sessionId]) laserPositions[req.params.sessionId] = {};
  laserPositions[req.params.sessionId][userId] = { x, y, name: name || 'Participant', color: color || '#ff4444', updatedAt: Date.now() };
  res.json({ ok: true });
});

app.get('/laser/:sessionId', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache');
  const session = laserPositions[req.params.sessionId] ?? {};
  const now = Date.now();
  const active = Object.entries(session)
    .filter(([, v]) => now - v.updatedAt < 2000)
    .map(([id, v]) => ({ id, ...v }));
  res.json({ lasers: active });
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
