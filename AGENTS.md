# Base44 Dev Environment — Wotchly

## What this is
A Vite static site (vanilla JS/HTML/CSS) — a watch-together streaming dashboard.
No backend service runs in compose: the Vite dev server's `netlify-functions-dev-proxy`
plugin (`vite.config.js`) loads the real handlers in `netlify/functions/` in-process
via `server.ssrLoadModule`, so dev and Netlify production run the same code path.

Media sources (replace the defunct MovieBox backend):
- **Internet Archive** (`netlify/functions/_sources.js`) — the Discover catalogue.
  Real public-domain films/TV/animation served as direct MP4s, so they play in the
  app's own HTML5 player and room sync stays exact. No API key needed.
- **TMDB** (same file) — optional, used for worldwide search + official trailers
  when `TMDB_API_KEY` is set. Without a key the app still works on Archive alone.

Item ids are namespaced: `ia:<archive-id>` (full film) and
`tmdb:<movie|tv>:<id>` (YouTube trailer). `get-feed` returns `{items:[...]}`
and `get-stream` keeps the historical `stream_url` contract.

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

`TMDB_API_KEY` (optional) unlocks worldwide TMDB search + official trailers.
Set it in the Base44 secrets dashboard. Internet Archive needs no credentials,
so the Discover catalogue works with or without it.

## Verifying it works
```
curl -s 'http://localhost:3000/.netlify/functions/get-feed?category=trending' | head -c 400
curl -s 'http://localhost:3000/.netlify/functions/get-stream?id=ia:his_girl_friday'
```
The first returns a JSON list of Archive films; the second a real
`archive.org/download/...` MP4 URL.

## Key files
- `netlify/functions/_sources.js` — Archive + TMDB source helpers (feed + stream)
- `vite.config.js` — dev proxy that runs the real Netlify handlers in-process
- `script.js` — room page logic (host controls, sync, chat)
- `streamResolver.js` — anime/OTT embed resolution
- `firebase.js` — Firebase init + exports
- `netlify/functions/` — the media backend; the same handlers run in dev and on Netlify
