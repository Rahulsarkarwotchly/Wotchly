import { defineConfig } from 'vite';
import path from 'path';

const __dirname = import.meta.dirname;

// Read from env var — set VITE_MOVIEBOX_API_URL in Replit Secrets for local dev.
// On Netlify, the functions handle proxying so this is only needed for Replit dev.
const MOVIEBOX_API = (process.env.VITE_MOVIEBOX_API_URL || '').replace(/\/$/, '');

// Desktop Chrome UA — avoids Cloudflare bot-detection on Render backends.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
            // No API URL configured → serve mock items immediately
            if (!MOVIEBOX_API) {
              res.writeHead(200, corsHeaders);
              res.end(JSON.stringify(DEV_MOCK_ITEMS));
              return;
            }
            const apiUrl = params.q
              ? `${MOVIEBOX_API}/search?q=${encodeURIComponent(params.q)}`
              : `${MOVIEBOX_API}/api/home/${ROUTE_MAP[(params.category || 'trending').toLowerCase()] || (params.category || 'trending').toLowerCase()}`;
            try {
              const upstream = await fetch(apiUrl, {
                headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
                signal: AbortSignal.timeout(10000),
              });
              if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
              const body = await upstream.text();
              res.writeHead(200, corsHeaders);
              res.end(body);
            } catch {
              // API down / timeout → return mock data so the browse UI stays functional
              res.writeHead(200, corsHeaders);
              res.end(JSON.stringify(params.q ? [] : DEV_MOCK_ITEMS));
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
            // No API URL configured → serve fallback stream immediately
            if (!MOVIEBOX_API) {
              res.writeHead(200, corsHeaders);
              res.end(JSON.stringify({ stream_url: devPickFallback(params.id), fallback: true, fallback_reason: 'dev_no_api_url' }));
              return;
            }
            const apiUrl = `${MOVIEBOX_API}/api/stream/${encodeURIComponent(params.id)}`;
            try {
              const upstream = await fetch(apiUrl, {
                headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
                signal: AbortSignal.timeout(10000),
              });
              if (upstream.status === 422 || upstream.status === 442) {
                res.writeHead(200, corsHeaders);
                res.end(JSON.stringify({ stream_url: devPickFallback(params.id), fallback: true, fallback_reason: String(upstream.status) }));
                return;
              }
              if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
              const data = await upstream.json();
              if (!data.stream_url) throw new Error('no stream_url');
              res.writeHead(200, corsHeaders);
              res.end(JSON.stringify(data));
            } catch {
              res.writeHead(200, corsHeaders);
              res.end(JSON.stringify({ stream_url: devPickFallback(params.id), fallback: true, fallback_reason: 'upstream_error' }));
            }
            return;
          }

          next();
        });
      },
    },
  ],
});
