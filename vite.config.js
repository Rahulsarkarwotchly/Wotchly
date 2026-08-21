import { defineConfig, loadEnv } from 'vite';
import path from 'path';

const __dirname = import.meta.dirname;
const VITE_ENV = loadEnv(process.env.NODE_ENV || 'development', __dirname, '');

// Read VITE_MOVIEBOX_API_URL from Vite's loaded env files as well as the
// process environment. Vite does not automatically copy .env values into
// process.env while evaluating vite.config.js.
const MOVIEBOX_API = (() => {
  const raw = (VITE_ENV.VITE_MOVIEBOX_API_URL || process.env.VITE_MOVIEBOX_API_URL || '').trim();
  if (!raw) return '';
  return `${/^https?:\/\//i.test(raw) ? '' : 'https://'}${raw}`.replace(/\/$/, '');
})();

// Match the client identity expected by the Render MovieBox backend.
const CLIENT_HEADERS = {
  'User-Agent': 'MovieBoxPro/16.2.1 (Android 12; Pixel 6)',
  'X-M-Version': '16.2.1',
  'X-Play-Mode': '2',
  'Accept': 'application/json',
};

// Fallback streams for dev proxy when MOVIEBOX_API_URL is not set.
const DEV_FALLBACK_STREAMS = [
  'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
];
function devPickFallback(id) {
  let h = 0; const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return DEV_FALLBACK_STREAMS[Math.abs(h) % DEV_FALLBACK_STREAMS.length];
}

// Mock catalogue for dev feed when MOVIEBOX_API_URL is not set.
const DEV_MOCK_ITEMS = [
  { id: 'tt15398776', title: 'Oppenheimer',      year: 2023, lang: 'en', rating: 8.3, type: 'movie', cover: 'https://image.tmdb.org/t/p/w300/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg' },
  { id: 'tt9362722',  title: 'Spider-Man: Across the Spider-Verse', year: 2023, lang: 'en', rating: 8.7, type: 'movie', cover: 'https://image.tmdb.org/t/p/w300/8Vt6mWEReuy4Of61Lnj5Xj704m8.jpg' },
  { id: 'tt21823606', title: 'Dune: Part Two',   year: 2024, lang: 'en', rating: 8.5, type: 'movie', cover: 'https://image.tmdb.org/t/p/w300/8b8R8l88Qje9dn9OE8PY05Nxl1X.jpg' },
  { id: 'tt14154714', title: 'Animal',            year: 2023, lang: 'hi', rating: 6.9, type: 'movie', cover: 'https://image.tmdb.org/t/p/w300/pB9L0jAnEQLMKgexqCEocEW8TA.jpg' },
  { id: 'tt15671028', title: 'Jawan',             year: 2023, lang: 'hi', rating: 7.0, type: 'movie', cover: 'https://image.tmdb.org/t/p/w300/cxqkPwUEnbleTHlQKFmALNRN6Iy.jpg' },
  { id: 'tt13622776', title: 'Squid Game',        year: 2021, lang: 'ko', rating: 8.0, type: 'tv',    cover: 'https://image.tmdb.org/t/p/w300/dDlEmu3EZ0Pgg93QPTrgbyEPTKD.jpg' },
  { id: 'tt26101579', title: 'Pushpa: The Rule',  year: 2024, lang: 'te', rating: 7.8, type: 'movie', cover: 'https://image.tmdb.org/t/p/w300/aBFQA1Uf1jxG9V9CkYCBs2tniGG.jpg' },
  { id: 'tt0816692',  title: 'Interstellar',      year: 2014, lang: 'en', rating: 8.7, type: 'movie', cover: 'https://image.tmdb.org/t/p/w300/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg' },
];
const ROUTE_MAP = {
  trending: 'trending',
  movie: 'movies', movies: 'movies',
  tv: 'tv',
  anime: 'anime',
  midnight: 'midnight',
  'short drama': 'short-drama', 'short-drama': 'short-drama', shorts: 'short-drama',
  serials: 'serials',
  bollywood: 'bollywood',
  hindi: 'hindi',
  south: 'south',
  korean: 'korean',
  drama: 'drama',
  hollywood: 'hollywood',
  web: 'web-series', 'web series': 'web-series', 'web-series': 'web-series',
};

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main:       path.resolve(__dirname, 'index.html'),
        room:       path.resolve(__dirname, 'room.html'),
        about:      path.resolve(__dirname, 'about.html'),
        admin:      path.resolve(__dirname, 'admin.html'),
        contact:    path.resolve(__dirname, 'contact.html'),
        disclaimer: path.resolve(__dirname, 'disclaimer.html'),
        faq:        path.resolve(__dirname, 'faq.html'),
        license:    path.resolve(__dirname, 'license.html'),
        privacy:    path.resolve(__dirname, 'privacy.html'),
        terms:      path.resolve(__dirname, 'terms.html'),
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5000,
    allowedHosts: true,
  },
  plugins: [
    {
      // Dev-only proxy: mimics Netlify functions so the MovieBox API works
      // on Replit (or any local Vite dev server) without deploying to Netlify.
      name: 'netlify-functions-dev-proxy',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith('/.netlify/functions/')) { next(); return; }

          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': 'Content-Type',
              'Access-Control-Allow-Methods': 'GET, OPTIONS',
            });
            res.end();
            return;
          }

          const urlObj    = new URL(req.url, 'http://localhost');
          const fn        = urlObj.pathname.replace('/.netlify/functions/', '');
          const params    = Object.fromEntries(urlObj.searchParams);

          const corsHeaders = {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          };

          // ── get-feed ─────────────────────────────────────────────────────
          if (fn === 'get-feed') {
            // Local Replit preview needs its own VITE_MOVIEBOX_API_URL secret.
            if (!MOVIEBOX_API) {
              res.writeHead(503, corsHeaders);
              res.end(JSON.stringify({ error: 'VITE_MOVIEBOX_API_URL is not configured' }));
              return;
            }
            const apiUrl = params.q
              ? `${MOVIEBOX_API}/search?q=${encodeURIComponent(params.q)}`
              : `${MOVIEBOX_API}/${ROUTE_MAP[(params.category || 'trending').toLowerCase()] || (params.category || 'trending').toLowerCase()}`;
            try {
              const upstream = await fetch(apiUrl, {
                headers: CLIENT_HEADERS,
                signal: AbortSignal.timeout(10000),
              });
              if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
              const json = await upstream.json();
              const raw = Array.isArray(json?.data?.list)
                ? json.data.list.flatMap(section => Array.isArray(section?.items) ? section.items : [section])
                : Array.isArray(json) ? json
                : Array.isArray(json.results) ? json.results
                : Array.isArray(json.data) ? json.data
                : Array.isArray(json.items) ? json.items
                : Array.isArray(json.list) ? json.list
                : Array.isArray(json.content) ? json.content
                : Array.isArray(json.data?.items) ? json.data.items
                : null;
              if (!raw) throw new Error('Unexpected feed response shape');
              res.writeHead(200, corsHeaders);
              res.end(JSON.stringify(raw));
            } catch (err) {
              console.error('[get-feed] Render request failed:', err.message);
              res.writeHead(502, corsHeaders);
              res.end(JSON.stringify({ error: 'MovieBox API unavailable' }));
            }
            return;
          }

          // ── get-stream ────────────────────────────────────────────────────
          if (fn === 'get-stream') {
            if (!params.id) {
              res.writeHead(400, corsHeaders);
              res.end(JSON.stringify({ error: 'Missing required query parameter: id' }));
              return;
            }
            // Local Replit preview needs its own VITE_MOVIEBOX_API_URL secret.
            if (!MOVIEBOX_API) {
              res.writeHead(503, corsHeaders);
              res.end(JSON.stringify({ error: 'VITE_MOVIEBOX_API_URL is not configured' }));
              return;
            }
            const apiUrl = `${MOVIEBOX_API}/stream/${encodeURIComponent(params.id)}?season=${encodeURIComponent(params.season || '1')}&episode=${encodeURIComponent(params.episode || '1')}&quality=${encodeURIComponent(params.quality || '720P')}`;
            try {
              const upstream = await fetch(apiUrl, {
                headers: CLIENT_HEADERS,
                signal: AbortSignal.timeout(10000),
              });
              if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
              const data = await upstream.json();
              const streamUrl = data.stream_url || data.url || data.data?.stream_url || data.data?.url;
              if (!streamUrl) throw new Error('no playable stream URL');
              res.writeHead(200, corsHeaders);
              res.end(JSON.stringify({ ...data, stream_url: streamUrl }));
            } catch (err) {
              console.error('[get-stream] Render request failed:', err.message);
              res.writeHead(502, corsHeaders);
              res.end(JSON.stringify({ error: 'MovieBox API unavailable' }));
            }
            return;
          }

          next();
        });
      },
    },
  ],
});
