import { defineConfig } from 'vite';
import path from 'path';

const __dirname = import.meta.dirname;

// Read from env var — set VITE_MOVIEBOX_API_URL in Replit Secrets for local dev.
// On Netlify, the functions handle proxying so this is only needed for Replit dev.
const MOVIEBOX_API = (process.env.VITE_MOVIEBOX_API_URL || '').replace(/\/$/, '');
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

          let apiUrl;
          if (fn === 'get-feed') {
            if (params.q) {
              apiUrl = `${MOVIEBOX_API}/search?q=${encodeURIComponent(params.q)}`;
            } else {
              const cat   = (params.category || 'trending').toLowerCase();
              const route = ROUTE_MAP[cat] || cat;
              apiUrl = `${MOVIEBOX_API}/api/home/${route}`;
            }
          } else if (fn === 'get-stream') {
            if (!params.id) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing required query parameter: id' }));
              return;
            }
            apiUrl = `${MOVIEBOX_API}/api/stream/${encodeURIComponent(params.id)}`;
          }

          if (!apiUrl) { next(); return; }

          const corsHeaders = {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          };

          try {
            const upstream = await fetch(apiUrl, {
              headers: { 'User-Agent': 'Wotchly/1.0', Accept: 'application/json' },
              signal: AbortSignal.timeout(25000),
            });
            const body = await upstream.text();
            res.writeHead(upstream.status, corsHeaders);
            res.end(body);
          } catch (err) {
            const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
            res.writeHead(502, corsHeaders);
            res.end(JSON.stringify({
              error: isTimeout
                ? 'Stream server timed out. The server may be waking up — please retry.'
                : `Upstream error: ${err.message}`,
            }));
          }
        });
      },
    },
  ],
});
