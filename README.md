# VideoShare2 — Pexip Webapp3 Plugin

A Pexip Infinity webapp3 plugin that lets any participant in a conference upload and share a video file with all other participants. Video playback is synchronized in real time — play, pause, and seek on the sharer's side are reflected on all viewer screens within ~1 second.

---

## How it works

```
Sharer uploads a video  →  file stored on your server
                        →  all participants automatically see a floating player
                        →  play/pause/seek is synced to all viewers
                        →  file is deleted when sharing stops
```

The plugin runs entirely inside Pexip webapp3 as a floating widget. No browser extensions, no separate apps.

---

## Prerequisites

| Requirement | Details |
|---|---|
| Pexip Infinity | v34 or later (webapp3 plugin API support) |
| Upload server | A Linux host with Docker, reachable over **HTTPS** |
| Domain + TLS | Required — browsers block mixed HTTP/HTTPS uploads |
| Pexip management access | To upload branding and configure CSP |

---

## Part 1 — Deploy the Upload Server

The server stores video files and coordinates real-time playback sync between participants. Deploy it on any Linux host (tested on Fedora 40).

### 1.1 Install Docker

```bash
sudo dnf install -y docker docker-compose-plugin   # Fedora / RHEL
# OR
sudo apt install -y docker.io docker-compose-plugin # Ubuntu / Debian

sudo systemctl enable --now docker
```

Open firewall ports:

```bash
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

### 1.2 Generate an API key

```bash
openssl rand -hex 32
# Example output: a3f8d2c1b4e7f9...
```

Save this — you'll need it in two places: the server environment and the branding manifest.

### 1.3 Copy the server files

Copy the `VideoShare2/server/` folder to your Linux host:

```bash
scp -r ./server user@your-server.com:~/vs2-server/
```

### 1.4 Build and start the container

```bash
ssh user@your-server.com
cd ~/vs2-server

docker build -t vs2-server .

docker run -d \
  --name vs2-server \
  --restart unless-stopped \
  -p 127.0.0.1:4001:4001 \
  -v /home/user/vs2-uploads:/app/uploads \
  -e VS2_API_KEY=YOUR_API_KEY_HERE \
  vs2-server
```

Verify it started:

```bash
docker logs vs2-server --tail 10
```

### 1.5 Configure nginx as HTTPS reverse proxy

Add these location blocks to your nginx server block (inside the `server { listen 443 ssl; ... }` section):

```nginx
# VideoShare2 — file upload (authenticated)
location = /upload {
    proxy_pass http://127.0.0.1:4001/upload;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 500M;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_request_buffering off;
}

# VideoShare2 — serve uploaded files (no auth — video element can't send headers)
location /uploads/ {
    proxy_pass http://127.0.0.1:4001/uploads/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Range $http_range;
    proxy_set_header If-Range $http_if_range;
    proxy_read_timeout 300s;
}

# VideoShare2 — signaling endpoints (authenticated)
location /pending-share {
    proxy_pass http://127.0.0.1:4001/pending-share;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /stop-signal/ {
    proxy_pass http://127.0.0.1:4001/stop-signal/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /sync-state/ {
    proxy_pass http://127.0.0.1:4001/sync-state/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# VideoShare2 — health check (no auth)
location = /health {
    proxy_pass http://127.0.0.1:4001/health;
}
```

Reload nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Verify:

```bash
curl https://your-server.com/health
# Expected: {"ok":true}
```

---

## Part 2 — Build the Branding Package

### 2.1 Install dependencies

```bash
cd VideoShare2
npm install
```

### 2.2 Configure the manifest

Edit `branding-package/webapp3/branding/manifest.json` and set your server URL and API key:

```json
{
  "version": 0,
  "meta": {
    "name": "DEFAULT",
    "brandVersion": "n/a"
  },
  "images": {},
  "translations": {},
  "videoShare": {
    "uploadServer": "https://your-server.com",
    "apiKey": "YOUR_API_KEY_HERE"
  },
  "plugins": [
    {
      "id": "video-share2",
      "src": "./plugins/video-share2/index.html",
      "sandboxValues": [
        "allow-scripts",
        "allow-same-origin",
        "allow-forms",
        "allow-popups",
        "allow-popups-to-escape-sandbox"
      ]
    }
  ]
}
```

> **Note:** If you already have a branding package with custom images or translations, merge the `videoShare` block and the `plugins` array into your existing manifest — do not replace the whole file.

### 2.3 Build and zip

```bash
npm run build

# Copy built files into branding package
rm -rf branding-package/webapp3/branding/plugins/video-share2
cp -r dist/. branding-package/webapp3/branding/plugins/video-share2/

# Create the zip (from Git Bash or Linux — preserves forward-slash paths)
cd branding-package
zip -r ../videoshare2-branding.zip webapp3

cd ..
```

The file `videoshare2-branding.zip` is ready to upload to Pexip.

---

## Part 3 — Configure the Pexip Management Node

Log in to your Pexip management node (e.g. `https://pexmgr.your-domain.com`).

### 3.1 Add connect-src to the CSP

The plugin makes HTTP requests to your upload server. Pexip's Content Security Policy must allow this.

1. Go to **Platform → Global Settings → Security**
2. Find **HTTP Content-Security-Policy**
3. In the **connect-src** field, add:
   ```
   https://your-server.com
   ```
4. In the **media-src** field, add:
   ```
   https://your-server.com
   ```
   *(Required so the `<video>` element can load the uploaded file)*
5. Click **Save**

> The CSP change takes effect immediately for new browser sessions. Existing sessions need a hard-reload (`Ctrl+Shift+R`).

### 3.2 Upload the branding package

1. Go to **Web App → Web App Branding**
2. Click **Add Webapp branding package** (bottom of the page)
3. Fill in the fields:

| Field | Value |
|---|---|
| **Name** | e.g. `VideoShare2` |
| **Description** | Optional |
| **Web app version** | Select the applicable webapp3 version |
| **Branding package to upload** | Select `videoshare2-branding.zip` |

4. Click **Save**

> Allow approximately **one minute** for the package to replicate to all Conferencing Nodes before testing.

### 3.3 Apply the branding to a web app path

Branding in Pexip is **path-based** — it applies to all participants who access meetings via a specific web app path, not to individual VMRs.

1. Go to **Web App → Web App Paths**
2. Select the path you want to apply the branding to (or create a new one)
3. Set **Branding package** to the package you just uploaded
4. Click **Save**

> To apply the plugin to all meetings, assign the branding package to your default web app path.

---

## Part 4 — Using the Plugin

Once the branding is applied and participants join a webapp3 meeting:

### Sharing a video (host/any participant)

1. Click the **▶ (play)** button in the webapp3 toolbar
2. Drag and drop a video file onto the drop zone, or click to browse
3. Click **Upload & Share**
4. All other participants automatically see the video player open

### Controls (sharer only)

| Control | Action |
|---|---|
| **▶ / ⏸** | Play / Pause — synced to all viewers |
| Seek bar | Drag to seek — synced to all viewers |
| **⇾ Sync** | Push your current position to all viewers |
| **⛶** | Toggle fullscreen |
| **■ Stop** | End sharing — closes the player for everyone and deletes the file |

### Viewer controls

| Control | Action |
|---|---|
| **⛶** | Toggle fullscreen |
| Double-click video | Toggle fullscreen |
| **▶ toolbar button** | Re-open the player if you accidentally closed it |

### Stopping a share

Click **■ Stop Sharing**. This:
- Closes the player for all participants within ~500 ms
- Deletes the uploaded video file from the server

---

## Part 5 — Advanced Configuration

### Runtime server override (settings button)

If you need to change the server URL or API key without rebuilding:

1. In webapp3, click **⋮ (more menu)**
2. Click **Video Share — Server Settings**
3. Enter the new URL and/or API key
4. Click **Save**

Settings saved here take priority over the manifest.

### Supported video formats

MP4, MOV, WebM, AVI, MKV — up to 500 MB per file.

### File cleanup

- Files are deleted automatically when the sharer clicks **■ Stop**
- Files are also deleted when the video reaches its natural end
- A cleanup job runs every hour and removes any files older than 24 hours (safety net for browser crashes etc.)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Pexip Webapp3 (HTTPS)                                  │
│                                                         │
│  ┌──────────────┐       ┌──────────────────────────┐   │
│  │ main.ts      │       │ player.html (widget)     │   │
│  │ registerPlugin│       │ registerWidget           │   │
│  │              │       │                          │   │
│  │ polls server ◄───────► POSTs to server          │   │
│  │ sendAppMsg() │       │ plays video              │   │
│  └──────────────┘       └──────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
              │                        │
              │ HTTPS + API key        │ HTTPS + API key
              ▼                        ▼
┌─────────────────────────────────────────────────────────┐
│  Upload Server (your Linux host)                        │
│                                                         │
│  POST /upload          — receive video file             │
│  GET  /uploads/:file   — serve video (no auth)          │
│  POST /pending-share   — widget signals URL to main.ts  │
│  GET  /pending-share/  — main.ts polls for URL          │
│  POST /stop-signal/    — widget signals stop            │
│  GET  /stop-signal/    — main.ts polls for stop         │
│  POST /sync-state/     — sharer posts play position     │
│  GET  /sync-state/     — viewers poll play position     │
└─────────────────────────────────────────────────────────┘
```

### Why a relay server?

Pexip plugin widgets run in a sandboxed iframe and cannot call `sendApplicationMessage` directly (a Pexip SDK restriction). The server acts as a relay: the widget POSTs state to the server, and `main.ts` (which runs in the trusted plugin context) polls the server and calls `sendApplicationMessage` from there.

---

## Updating the Plugin

When a new version is available:

```bash
cd VideoShare2
npm install
npm run build

rm -rf branding-package/webapp3/branding/plugins/video-share2
cp -r dist/. branding-package/webapp3/branding/plugins/video-share2/

cd branding-package
zip -r ../videoshare2-branding.zip webapp3
```

Re-upload via **Web App → Web App Branding → Add Webapp branding package**. No server changes needed unless the changelog says otherwise.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Toolbar button missing | Branding not applied to the web app path | Go to **Web App → Web App Paths**, assign the branding package to the path |
| "No branding files found" when uploading | Wrong zip structure or `meta.name` not `"DEFAULT"` | Verify `manifest.json` has `"name": "DEFAULT"` and `"brandVersion": "n/a"` |
| Upload fails | Server not reachable or API key wrong | Check `https://your-server.com/health` returns `{"ok":true}`; verify API key in manifest matches `VS2_API_KEY` env var |
| Remote participant doesn't see the video | CSP `connect-src` missing server domain | Add `https://your-server.com` to `connect-src` in Pexip management |
| Video plays but can't seek | CSP `media-src` missing server domain | Add `https://your-server.com` to `media-src` in Pexip management |
| Files not deleted after sharing | Browser crashed before Stop was clicked | The hourly cleanup job removes files older than 24 hours automatically |
| Plugin broken after Pexip upgrade | API version mismatch | Rebuild the plugin with updated `@pexip/plugin-api` version matching your Pexip version |

---

## File Structure

```
VideoShare2/
├── src/
│   ├── main.ts         ← Plugin entry (toolbar button, polling, sendApplicationMessage)
│   ├── types.ts        ← SyncMessage type definitions
│   └── constants.ts    ← Default server URL and API key
├── player/
│   ├── player.html     ← Video player widget UI
│   └── player.ts       ← Video player widget logic
├── server/
│   ├── server.js       ← Node.js/Express upload + signaling server
│   ├── package.json
│   └── Dockerfile
├── branding-package/
│   └── webapp3/branding/
│       ├── manifest.json   ← Plugin registration + server config
│       └── plugins/video-share2/  ← Built plugin files (after npm run build)
├── package.json
├── vite.config.ts
└── videoshare2-branding.zip  ← Ready to upload to Pexip (after build)
```
