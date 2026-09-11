# Wotchly — Base44 Dev Environment

## What this is
A Vite multi-page static site ("Wotchly") — a watch-together app. Vanilla JS + HTML + CSS, no framework. Uses Firebase Realtime Database for room sync/chat/presence, and proxies a MovieBox content API through a Vite dev-server middleware (no backend service needed).

## Running the app
```bash
docker compose -f docker-compose.base44.yml up -d
```
- Vite dev server runs on port 5000 inside the container, mapped to host port 3000.
- Live reload is active (Vite HMR). Edits to HTML/JS/CSS appear immediately.
- `allowedHosts: true` is set in vite.config.js, so the preview origin is accepted.

## Environment / Secrets
- **Firebase** (`VITE_FIREBASE_*`): Required for the app to boot — `firebase.js` calls `initializeApp` + `getDatabase` at module load, and both `index.html` and `room.html` import it. Placeholder values in `.env.base44-defaults` let the app start; real Firebase project credentials must be provided via the Base44 dashboard (Secrets page) to enable room sync, chat, and presence.
- **MovieBox API**: No credentials needed. The Vite dev server middleware proxies to `https://moviebox-internal-api.onrender.com` (configured in `vite.config.js`). The Render free tier cold-starts (~30s).

## Compose structure
- Single `web` service: `node:22-slim`, source bind-mounted, pnpm installs deps at startup, runs `pnpm run dev`.
- `env_file` order: `.env.base44-defaults` (placeholders, FIRST) → `/run/base44/app.env` (real secrets, LAST — wins).

## Key files
| File | Purpose |
|---|---|
| `index.html` | Landing page — create/join room (imports firebase.js) |
| `room.html` + `script.js` | Watch room UI and all room logic |
| `firebase.js` | Firebase init (reads `VITE_FIREBASE_*` env vars) |
| `streamResolver.js` | OTT embed + anime stream resolution |
| `vite.config.js` | Vite config + dev proxy for MovieBox API |
| `netlify/functions/` | Production Netlify functions (not used in dev) |

## Verification
- `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/` → 200
- Browser console should show no errors on the landing page
- Room sync features require real Firebase credentials
