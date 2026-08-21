// netlify/functions/get-stream.js
// Proxies stream URL requests to the live Render MovieBox API.
// The Render service owns the official MovieBox signing/authentication flow.
// This function normalizes the documented `url` response to the frontend's
// `stream_url` contract while keeping cookies server-side where possible.
import { createHash } from 'node:crypto';

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
  'Content-Type': 'application/json;charset=UTF-8',
  'Referer': 'https://api6.aoneroom.com/',
};

const LIVE_API_BASE = (
  process.env.BACKEND_ORIGIN ||
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

function clientHeaders() {
  const timestamp = String(Date.now());
  const digest = createHash('md5').update([...timestamp].reverse().join('')).digest('hex');
  return {
    ...CLIENT_HEADERS,
    'X-Client-Token': `${timestamp},${digest}`,
  };
}

function findStream(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findStream(entry);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const direct = value.url || value.streamUrl || value.stream_url ||
    value.playUrl || value.play_url || value.downloadUrl || value.download_url;
  if (typeof direct === 'string' && /^https?:\/\//i.test(direct)) {
    return {
      url: direct,
      cookie: value.cookie || value.signCookie || value.sign_cookie || '',
      quality: value.quality || value.definition || '',
      subtitles: value.subtitles || value.subTitleList || value.subtitleList || [],
    };
  }
  for (const key of ['streamList', 'stream_list', 'streams', 'data', 'result', 'resource']) {
    const found = findStream(value[key]);
    if (found) return found;
  }
  return null;
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
      body: JSON.stringify({ error: 'backend origin is not configured' }),
    };
  }

  try {
    let apiUrl = `${LIVE_API_BASE}/stream/${encodeURIComponent(id)}?season=${encodeURIComponent(season)}&episode=${encodeURIComponent(episode)}&quality=${encodeURIComponent(quality)}`;
    let resp = await fetch(apiUrl, {
      headers: clientHeaders(),
      signal: AbortSignal.timeout(20000),
    });

    // Support both the project's Render adapter and the official BFF
    // documented in OFFICIAL_API_DOCUMENTATION.md.
    if (resp.status === 404 || resp.status === 405) {
      const official = new URL(`${LIVE_API_BASE}/wefeed-mobile-bff/subject-api/play-info`);
      official.searchParams.set('subjectId', id);
      official.searchParams.set('se', season);
      official.searchParams.set('ep', episode);
      official.searchParams.set('quality', quality);
      apiUrl = official.toString();
      resp = await fetch(apiUrl, {
        headers: clientHeaders(),
        signal: AbortSignal.timeout(20000),
      });
    }

    if (!resp.ok) {
      console.error(`[get-stream] Upstream ${resp.status} for id=${id}`);
      return { statusCode: resp.status === 404 ? 404 : 502, headers: corsHeaders, body: JSON.stringify({ error: 'MovieBox stream unavailable' }) };
    }

    const data = await resp.json();
    const stream = findStream(data);
    const streamUrl = data.stream_url || data.url || data.data?.stream_url || data.data?.url || stream?.url;
    if (!streamUrl) {
      return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'MovieBox returned no playable stream URL' }) };
    }

    // README documents /proxy-media as the CORS/cookie-safe playback path.
    // Use it when the resolver returns CloudFront signing cookies; otherwise
    // preserve the direct URL for ordinary MP4/HLS responses.
    const cookie = data.cookie || data.signCookie || data.data?.cookie ||
      data.data?.signCookie || stream?.cookie || '';
    const playableUrl = cookie
      ? `${LIVE_API_BASE}/proxy-media?url=${encodeURIComponent(streamUrl)}&cookie=${encodeURIComponent(cookie)}`
      : streamUrl;

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ...data,
        stream_url: playableUrl,
        source_url: streamUrl,
        cookie,
        quality: data.quality || stream?.quality || quality,
        subtitles: data.subtitles || data.subTitleList || data.data?.subTitleList || stream?.subtitles || [],
      }),
    };

  } catch (err) {
    console.error('[get-stream] API error:', err.message);
    return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'MovieBox API unavailable' }) };
  }
};
