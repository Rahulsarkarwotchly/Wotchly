# Wotchly — Base44 Dev Environment

## What this is
A Vite multi-page static site ("Wotchly") — a watch-together app. Vanilla JS + HTML + CSS, no frontend framework. Room sync (rooms, chat, presence) runs on **Firebase Realtime Database**; no self-hosted backend is needed.

## Running the app
```bash
docker compose -f docker-compose.base44.yml up -d
```
- Single `web` service: Vite dev server on port 5000 (container), mapped to host port 3000. Live reload (HMR) active — edits appear immediately.
- Firebase client credentials are delivered via `/run/base44/app.env` (see `.base44/environment.json`); Vite exposes `VITE_*`-prefixed vars to the client.

## Architecture
| Piece | File | Notes |
|---|---|---|
| Firebase client | `firebase.js` | Thin wrapper over `firebase/database`: exports `db`, `ref`, `set`, `get`, `push`, `update`, `remove`, `onValue`, `onDisconnect` |
| Built-in content catalog | `catalog.js` | Public-domain + CC films (Internet Archive) and Apple/Mux HLS demos |
| Keyboard handling | `keyboard.js` | `visualViewport`-based; keeps the video player visible when the mobile keyboard opens (portrait + landscape) |
| Luxury UI layer | `premium.css` | Loaded after style.css; aurora ambience, gold/glass surfaces, keyboard-open states |

- `script.js`/`index.html`/`admin.js` import `./firebase.js`.
- RTDB security rules live in `firebase-rules.json` (publish them in the Firebase console; `FIREBASE_RULES.md` has the long-form writeup).
- Legal playback sources: YouTube (official embeds, full sync via IFrame API), direct MP4/HLS URLs, Google Drive, the built-in Cinema catalog.
- Hindi audio: HLS multi-audio track switching auto-selects the preferred language (default `hi`, saved in localStorage as `wotchly_embed_lang`).
- Deployment is fully static (Netlify/any static host); no WebSocket server to host.

## Verification
- `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/` → 200
- Create room on landing page → room.html loads, presence works (users list fills)
- Console should show no errors on landing and room pages
