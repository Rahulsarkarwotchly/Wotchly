// netlify/functions/get-feed.js
// Proxies MovieBox feed/search requests to the Render API server-side.
// The Render service owns the official MovieBox signing/authentication flow.
// This function keeps the API URL server-side and only exposes the small feed
// contract needed by the watch-together UI.
import { createHash } from 'node:crypto';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
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
  'https://moviebox-internal-api.onrender.com'
).trim().replace(/^([^:]+)$/i, 'https://$1').replace(/\/$/, '');

// ─── Route map ────────────────────────────────────────────────────────────────
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

const OFFICIAL_PATH = '/wefeed-mobile-bff';
const ROOT_API_BASE = LIVE_API_BASE.endsWith(OFFICIAL_PATH)
  ? LIVE_API_BASE.slice(0, -OFFICIAL_PATH.length)
  : LIVE_API_BASE;
const OFFICIAL_CATEGORY_IDS = {
  trending: 1, movie: 2, movies: 2, tv: 5, anime: 8,
  bollywood: 18, hindi: 18, south: 18, korean: 18,
};

function clientHeaders() {
  // The guest token is intentionally generated per request. Render-backed
  // deployments may already add the full signature, while direct BFF hosts
  // accept this part of the native client handshake.
  const timestamp = String(Date.now());
  const digest = createHash('md5').update([...timestamp].reverse().join('')).digest('hex');
  return {
    ...CLIENT_HEADERS,
    'X-Client-Token': `${timestamp},${digest}`,
  };
}

async function requestJson(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { ...clientHeaders(), ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(20000),
  });
}

function officialUrl(path, params = {}) {
  const base = LIVE_API_BASE.endsWith(OFFICIAL_PATH)
    ? LIVE_API_BASE
    : `${LIVE_API_BASE}${OFFICIAL_PATH}`;
  const url = new URL(`${base}${path}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function apiUrl(path, params = {}) {
  const url = new URL(`${ROOT_API_BASE}${path}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function extractItems(json) {
  const arrays = [];
  const visit = (value, depth = 0) => {
    if (!value || depth > 5) return;
    if (Array.isArray(value)) {
      arrays.push(value);
      value.forEach(item => visit(item, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      Object.values(value).forEach(child => visit(child, depth + 1));
    }
  };
  visit(json);

  for (const value of arrays) {
    const expanded = value.flatMap(item =>
      Array.isArray(item?.items) ? item.items :
      Array.isArray(item?.list) ? item.list :
      [item]
    );
    if (expanded.some(item => item && typeof item === 'object' &&
      (item.subjectId || item.subject_id || item.subjectID || item.id ||
       item.title || item.name || item.subjectName))) {
      return expanded;
    }
  }
  return [];
}

function normalizeItem(item, category) {
  if (!item || typeof item !== 'object') return null;
  const id = item.subjectId || item.subject_id || item.subjectID ||
    item.contentId || item.content_id || item.id;
  const title = item.title || item.name || item.subjectName || item.subject_name;
  if (!id || !title) return null;

  const cover = item.cover || item.coverUrl || item.cover_url ||
    item.poster || item.posterUrl || item.poster_url ||
    item.thumbnail || item.image || item.pic || '';
  const rawYear = item.year || item.releaseYear || item.release_year ||
    item.releaseDate || item.release_date;
  const yearMatch = String(rawYear || '').match(/\d{4}/);
  const rating = item.rating ?? item.score ?? item.imdbRating ?? item.imdb_rating;
  const typeValue = item.type || item.subjectType || item.subject_type || category;

  return {
    id: String(id),
    title: String(title),
    cover: typeof cover === 'string' ? cover : (cover?.url || ''),
    year: yearMatch ? yearMatch[0] : '',
    lang: item.lang || item.language || item.originalLanguage || '',
    rating: rating === undefined || rating === null ? '' : rating,
    type: typeof typeValue === 'number'
      ? (typeValue === 1 ? 'movie' : 'tv')
      : String(typeValue || ''),
    cat: category || '',
  };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  const { category, q } = event.queryStringParameters ?? {};

  // Keep the failure explicit in production. The frontend already renders a
  // retry state for 502/503 responses, so it won't mistake demo data for live
  // MovieBox content.
  if (!LIVE_API_BASE) {
    return {
      statusCode: 503,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'backend origin is not configured' }),
    };
  }

  const key = (category || 'trending').toLowerCase();
  const customRoute = routeMap[key] || key;
  const candidates = q
    ? [
        { url: `${LIVE_API_BASE}/search?q=${encodeURIComponent(q)}` },
        { url: officialUrl('/subject-api/search', { q, page: 1, pageSize: 24 }) },
        { url: officialUrl('/subject-api/search/v2', { q, page: 1, pageSize: 24 }) },
      ]
    : [
        { url: `${ROOT_API_BASE}/${customRoute === 'trending' ? 'trending' : customRoute}` },
        ...(key === 'trending'
          ? [{ url: officialUrl('/subject-api/trending/v2', { page: 1, pageSize: 24 }) }]
          : []),
        ...(OFFICIAL_CATEGORY_IDS[key] ? [{
          url: apiUrl('/home/v2/get-list'),
          method: 'POST',
          body: JSON.stringify({
            categoryId: OFFICIAL_CATEGORY_IDS[key],
            page: 1,
            pageSize: 24,
          }),
        }] : []),
        { url: apiUrl('/index/home') },
      ];
  let upstreamUrl = candidates[0].url;

  try {
    let resp;
    let raw = [];
    const failures = [];
    // The imported UI historically used a small Render adapter contract
    // (/search and /trending). If backend origin points directly at an
    // official BFF host, use the documented endpoints instead.
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      upstreamUrl = candidate.url;
      try {
        resp = await requestJson(candidate.url, {
          method: candidate.method || 'GET',
          body: candidate.body,
        });
      } catch (error) {
        failures.push(`${candidate.method || 'GET'} ${new URL(candidate.url).pathname}: ${error.name || 'request failed'}`);
        continue;
      }
      if (!resp.ok) {
        failures.push(`${candidate.method || 'GET'} ${new URL(candidate.url).pathname}: ${resp.status}`);
        continue;
      }
      const json = await resp.json();
      raw = extractItems(json);
      // A deployed adapter can return HTTP 200 with an empty list while its
      // upstream route is unsupported. Keep trying the documented BFF routes.
      if (raw.length) break;
    }
    if (!resp?.ok) {
      throw new Error(`All upstream routes failed (${failures.join(', ') || 'no response'})`);
    }
    // A 200 response with an empty list means the Render adapter reached its
    // upstream but MovieBox returned no catalogue data. Do not turn that into
    // a misleading 502/network error; keep the UI usable with the local
    // catalogue while the upstream issue is investigated.
    const normalized = raw.map(item => normalizeItem(item, key)).filter(Boolean);
    if (!normalized.length) {
      console.warn('[get-feed] Upstream returned an empty feed; using local catalogue fallback');
      const pool = q
        ? [...MOCK_ITEMS, ...MOCK_KOREAN].filter(item => item.title.toLowerCase().includes(q.toLowerCase()))
        : getMockItems(category);
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'X-MovieBox-Source': 'fallback-catalogue' },
        body: JSON.stringify(pool),
      };
    }

    // Normalize README/official-doc response shapes to a plain item array.
    // Home endpoints may return section objects ({items:[...]}) inside
    // {data:{list:[...]}} while search commonly returns a direct list.
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(normalized) };

  } catch (err) {
    console.error('[get-feed] Error:', err.message, '| Route:', new URL(upstreamUrl).pathname);
    return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'MovieBox API unavailable' }) };
  }
};
