# Wotchly

A "watch together" web app — create a room, invite friends, and enjoy videos in perfect sync.

## Stack
- **Frontend**: Vite multi-page app (static HTML + vanilla JS + CSS)
- **Sync**: Firebase Realtime Database (room state, chat, presence)
- **Content**: MovieBox API via a Render-hosted backend (proxied through Netlify Functions)
- **Deployment**: Netlify (build → `dist/`, functions in `netlify/functions/`)

## Running locally
```bash
npm install
npm run dev   # Vite dev server on port 5000
```
Firebase features require env vars (see `.env.example`). The Vite dev server is configured with `allowedHosts: true` for Replit preview.

## Key files
| File | Purpose |
|---|---|
| `index.html` | Landing/home page |
| `room.html` + `script.js` | Watch room UI and all logic |
| `firebase.js` | Firebase init (reads `VITE_FIREBASE_*` env vars) |
| `netlify/functions/get-feed.js` | Proxy: MovieBox feed + search → Render API |
| `netlify/functions/get-stream.js` | Proxy: stream URL lookup → Render API |
| `netlify.toml` | Build config + Netlify function timeout (26s) |
| `style.css` | All styles |
| `streamResolver.js` | OTT embed + anime stream resolution |

## Environment variables (set in Netlify site settings)
```
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_DATABASE_URL
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET
VITE_FIREBASE_MESSAGING_SENDER_ID
VITE_FIREBASE_APP_ID
# MOVIEBOX_API_URL is configured only in Netlify server-side environment variables.
```

## Notes
- The Render backend is on the free tier — it cold-starts in ~30s after inactivity. Netlify function timeout is set to 26s (free-tier max) with 25s internal HTTP timeouts to handle this gracefully.
- `MOVIEBOX_API_URL` must NOT have a `VITE_` prefix — it's server-side only (Netlify function reads it; the browser never sees it).
- The `public/_redirects` and `_headers` files are copied into `dist/` by vite-plugin-static-copy.

## User preferences
