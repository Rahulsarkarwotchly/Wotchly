// netlify/functions/get-feed.js
// Proxies MovieBox feed/search requests to the Render API server-side.
// Avoids CORS issues — browser calls this function, function calls Render API.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

const LIVE_API_BASE = (
  process.env.MOVIEBOX_API_URL ||
  process.env.VITE_MOVIEBOX_API_URL ||
  ''
).replace(/\/$/, '');

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (!LIVE_API_BASE) {
    return {
      statusCode: 503,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'MOVIEBOX_API_URL is not configured on this server.' }),
    };
  }

  const { category, q } = event.queryStringParameters ?? {};

  let apiUrl;
  if (q) {
    apiUrl = `${LIVE_API_BASE}/search?q=${encodeURIComponent(q)}`;
  } else {
    const routeMap = {
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
    const key = (category || 'trending').toLowerCase();
    const route = routeMap[key] || key;
    apiUrl = `${LIVE_API_BASE}/api/home/${route}`;
  }

  try {
    // 8s timeout — quick fail so the browser retries fast. Render cold-starts take
    // 30-60s; the browser retry loop covers that with many short attempts.
    const resp = await fetch(apiUrl, {
      headers: { 'User-Agent': 'Wotchly/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`Upstream returned ${resp.status}`);
    const data = await resp.json();
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(data) };
  } catch (err) {
    console.error('[get-feed] Error:', err.message, '| URL:', apiUrl);
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({
        error: isTimeout
          ? 'Server is waking up, please retry in a moment.'
          : err.message,
      }),
    };
  }
};
