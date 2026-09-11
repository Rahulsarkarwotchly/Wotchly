# Wotchly — Base44 Dev Environment

## What this is
A Vite multi-page static site ("Wotchly") — a watch-together app. Vanilla JS + HTML + CSS, no frontend framework. Fully self-contained: room sync runs on its own WebSocket server (`server/sync-server.mjs`) — no Firebase, no third-party APIs, no credentials required.

## Running the app
```bash
docker compose -f docker-compose.base44.yml up -d
```
- `web` service: Vite dev server on port 5000 (container), mapped to host port 3000. Live reload (HMR) active — edits appear immediately.
- `sync` service: WebSocket sync server on port 8081. The Vite dev server proxies `/ws` → `ws://sync:8081` (single origin, no CORS issues).
- Room state/chat/presence live in the sync server's memory (ephemeral by design; rooms die on server restart).

## Architecture (post-rework)
| Piece | File | Notes |
|---|---|---|
| Sync client (Firebase-compatible API) | `sync.js` | Drop-in shim: same exports as the old `firebase.js` (`ref`, `set`, `get`, `push`, `update`, `remove`, `onValue`, `onDisconnect`) backed by WebSocket |
| Sync server | `server/sync-server.mjs` | In-memory store, subscriptions, presence cleanup via onDisconnect ops |
| Built-in content catalog | `catalog.js` | Public-domain + CC films (Internet Archive) and Apple/Mux HLS demos. Replaced the removed MovieBox/Render API |
| Keyboard handling | `keyboard.js` | `visualViewport`-based; keeps the video player visible when the mobile keyboard opens (portrait + landscape) |
| Luxury UI layer | `premium.css` | Loaded after style.css; aurora ambience, gold/glass surfaces, keyboard-open states |

- `script.js`/`index.html`/`admin.js` import `./sync.js`; `firebase.js` was deleted.
- `streamResolver.js`, `netlify/functions/` were removed (unauthorized OTT/anime embed providers).
- Legal playback sources: YouTube (official embeds, full sync via IFrame API), direct MP4/HLS URLs, Google Drive, the built-in Cinema catalog.
- Hindi audio: HLS multi-audio track switching auto-selects the preferred language (default `hi`, saved in localStorage as `wotchly_embed_lang`); Apple BipBop demo stream exercises it.
- Production deployment requires hosting the sync server (Netlify alone can't serve WebSockets). `netlify.toml` and `FIREBASE_RULES.md`/`firebase-rules.json` are outdated leftovers.

## Verification
- `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/` → 200
- Create room on landing page → room.html loads, presence works (users list fills)
- WebSocket: `wss` connection to `/ws` should stay open (check browser Network tab)
- Console should show no errors on landing and room pages
