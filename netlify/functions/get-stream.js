// netlify/functions/get-stream.js
// Proxies stream URL requests to the live Render MovieBox API.
// Fallback: when the live API is unreachable or the title is unavailable,
// returns a stable open-source demo stream so the player never hard-crashes.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

// Desktop Chrome UA — avoids Cloudflare bot-detection on the Render backend.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const LIVE_API_BASE = (
  process.env.MOVIEBOX_API_URL ||
  process.env.VITE_MOVIEBOX_API_URL ||
  ''
).replace(/\/$/, '');

// Stable, royalty-free fallback streams (HLS + MP4).
// Served when the live API is down, returns 422/442, or provides no stream_url.
const FALLBACK_STREAMS = [
  'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',                                                       // Big Buck Bunny HLS
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',                       // Big Buck Bunny MP4
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',                     // Elephants Dream
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',                    // For Bigger Blazes
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4',       // Subaru Outback
];

/**
 * Pick a fallback stream deterministically from the movie ID so the same title
 * always maps to the same demo clip (consistent across retries / room members).
 */
function pickFallback(id) {
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return FALLBACK_STREAMS[Math.abs(h) % FALLBACK_STREAMS.length];
}

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

  // MOVIEBOX_API_URL not configured → serve fallback immediately (no point trying).
  if (!LIVE_API_BASE) {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        stream_url: pickFallback(id),
        fallback: true,
        fallback_reason: 'server_not_configured',
      }),
    };
  }

  try {
    const apiUrl = `${LIVE_API_BASE}/api/stream/${encodeURIComponent(id)}`;
    const resp = await fetch(apiUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(20000),
    });

    // 422 = unprocessable / content not streamable
    // 442 = custom "content unavailable" from the upstream MovieBox API
    // → fall back silently instead of surfacing an error to the player
    if (resp.status === 422 || resp.status === 442) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          stream_url: pickFallback(id),
          fallback: true,
          fallback_reason: resp.status === 422 ? 'not_streamable' : 'unavailable',
        }),
      };
    }

    if (!resp.ok) {
      console.error(`[get-stream] Upstream ${resp.status} for id=${id}`);
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          stream_url: pickFallback(id),
          fallback: true,
          fallback_reason: `upstream_${resp.status}`,
        }),
      };
    }

    const data = await resp.json();

    // Live API returned 200 but no usable stream URL → fall back
    if (!data.stream_url) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          stream_url: pickFallback(id),
          fallback: true,
          fallback_reason: 'no_stream_url',
        }),
      };
    }

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(data) };

  } catch (err) {
    console.error('[get-stream] API error:', err.message);
    // Network error, timeout, or any unhandled exception → fallback stream
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        stream_url: pickFallback(id),
        fallback: true,
        fallback_reason: (err.name === 'TimeoutError' || err.name === 'AbortError')
          ? 'timeout'
          : `error_${err.message}`,
      }),
    };
  }
};
