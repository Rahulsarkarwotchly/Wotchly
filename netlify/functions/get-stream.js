// netlify/functions/get-stream.js
// Proxies stream URL requests to the live Render MovieBox API.
// The Render service owns the official MovieBox signing/authentication flow.
// This function normalizes the documented `url` response to the frontend's
// `stream_url` contract while keeping cookies server-side where possible.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

const CLIENT_HEADERS = {
  'User-Agent': 'MovieBoxPro/16.2.1 (Android 12; Pixel 6)',
  'X-M-Version': '16.2.1',
  'X-Play-Mode': '2',
  'Accept': 'application/json',
};

const LIVE_API_BASE = (
  process.env.MOVIEBOX_API_URL ||
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

  const params = event.queryStringParameters ?? {};
  const season = params.season || '1';
  const episode = params.episode || '1';
  const quality = params.quality || '720P';

  // Do not hide a missing production configuration behind a demo stream.
  if (!LIVE_API_BASE) {
    return {
      statusCode: 503,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'MOVIEBOX_API_URL is not configured' }),
    };
  }

  try {
    const apiUrl = `${LIVE_API_BASE}/stream/${encodeURIComponent(id)}?season=${encodeURIComponent(season)}&episode=${encodeURIComponent(episode)}&quality=${encodeURIComponent(quality)}`;
    const resp = await fetch(apiUrl, {
      headers: CLIENT_HEADERS,
      signal: AbortSignal.timeout(20000),
    });

    if (!resp.ok) {
      console.error(`[get-stream] Upstream ${resp.status} for id=${id}`);
      return { statusCode: resp.status === 404 ? 404 : 502, headers: corsHeaders, body: JSON.stringify({ error: 'MovieBox stream unavailable' }) };
    }

    const data = await resp.json();
    const streamUrl = data.stream_url || data.url || data.data?.stream_url || data.data?.url;
    if (!streamUrl) {
      return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'MovieBox returned no playable stream URL' }) };
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ ...data, stream_url: streamUrl }),
    };

  } catch (err) {
    console.error('[get-stream] API error:', err.message);
    return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'MovieBox API unavailable' }) };
  }
};
