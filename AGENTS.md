# Base44 Dev Environment — Wotchly

## What this is
A Vite static site (vanilla JS/HTML/CSS) — a watch-together streaming dashboard.
No backend service runs in compose; the Vite dev server includes a middleware
plugin (`vite.config.js` → `netlify-functions-dev-proxy`) that proxies feed/stream
requests to `https://moviebox-internal-api.onrender.com`, mimicking the Netlify
Functions used in production.

## Stack
- **Vite 8** dev server on port 5000 (mapped to host 3000)
- **pnpm** (lockfile v9) — installed via corepack at container start
- **hls.js** for video playback
- **Firebase Realtime Database** for sync rooms (client-side, via `firebase.js`)

## Running
```
docker compose -f docker-compose.base44.yml up -d
```
The container runs `pnpm install && pnpm dev`. Source is bind-mounted at `/app`,
so edits hot-reload via Vite HMR.

## Credentials
Firebase config (`VITE_FIREBASE_*`) is required for the watch-together room
feature. Placeholder values in `.env.base44-defaults` let the app boot; real
values should be supplied via the Base44 secrets dashboard (delivered to
`/run/base44/app.env`). The browsing/streaming features work without Firebase.

## Key files
- `vite.config.js` — dev proxy for MovieBox API (get-feed, get-stream)
- `script.js` — room page logic (host controls, sync, chat)
- `streamResolver.js` — anime/OTT embed resolution
- `firebase.js` — Firebase init + exports
- `netlify/functions/` — production serverless functions (not used in dev)
