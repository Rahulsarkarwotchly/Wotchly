import { defineConfig } from 'vite';
import path from 'path';

const __dirname = import.meta.dirname;

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
      // Dev-only proxy: runs the real Netlify functions in-process so local
      // preview and production share one source of truth (no duplicated logic).
      // Netlify deploys run these same handlers as serverless functions.
      name: 'netlify-functions-dev-proxy',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith('/.netlify/functions/')) { next(); return; }

          const corsHeaders = {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          };

          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              ...corsHeaders,
              'Access-Control-Allow-Headers': 'Content-Type',
              'Access-Control-Allow-Methods': 'GET, OPTIONS',
            });
            res.end();
            return;
          }

          const urlObj = new URL(req.url, 'http://localhost');
          const fn = urlObj.pathname
            .replace('/.netlify/functions/', '')
            .replace(/\.js$/, '')
            .replace(/[^a-z0-9_-]/gi, '');

          try {
            const mod = await server.ssrLoadModule(`/netlify/functions/${fn}.js`);
            const result = await mod.handler({
              httpMethod: req.method,
              queryStringParameters: Object.fromEntries(urlObj.searchParams),
              headers: req.headers,
              body: null,
            });
            res.writeHead(result.statusCode || 200, { ...corsHeaders, ...(result.headers || {}) });
            res.end(result.body ?? '');
          } catch (err) {
            console.error(`[${fn}] dev proxy error:`, err.message);
            res.writeHead(502, corsHeaders);
            res.end(JSON.stringify({ error: `Function ${fn} failed: ${err.message}` }));
          }
        });
      },
    },
  ],
});