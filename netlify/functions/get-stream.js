// netlify/functions/get-stream.js
// Proxies stream URL requests to the live Render MovieBox API.
// No mock data — if the API is unreachable, a 502 is returned.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

  const id = (event.queryStringParameters ?? {}).id;

  if (!id) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing required query parameter: id' }),
    };
  }

  if (!LIVE_API_BASE) {
    return {
      statusCode: 503,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'MOVIEBOX_API_URL is not configured on this server.' }),
    };
  }

  try {
    const apiUrl = `${LIVE_API_BASE}/api/stream/${encodeURIComponent(id)}`;
    // 8s timeout — quick fail so the browser retries fast.
    const resp = await fetch(apiUrl, {
      headers: { 'User-Agent': 'Wotchly/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });

    // 422 = unprocessable / content not streamable (upstream validation failure)
    if (resp.status === 422) {
      return {
        statusCode: 422,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'This title cannot be streamed right now. Please try a different title.' }),
      };
    }

    // 442 = custom "content unavailable" from the upstream MovieBox API
    if (resp.status === 442) {
      return {
        statusCode: 442,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'This title is not available for streaming right now. Try another title.' }),
      };
    }

    if (!resp.ok) {
      const upstreamBody = await resp.json().catch(() => ({}));
      const msg = upstreamBody?.error || upstreamBody?.message || `Upstream error ${resp.status}`;
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({ error: msg }),
      };
    }

    const data = await resp.json();
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(data) };
  } catch (err) {
    console.error('[get-stream] API error:', err.message);
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({
        error: isTimeout
          ? 'Server is waking up, please retry in a moment.'
          : `Stream unavailable: ${err.message}`,
      }),
    };
  }
};
