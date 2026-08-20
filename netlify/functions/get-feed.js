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
  'User-Agent': 'MovieBoxPro/16.2.1 (Android 14; com.community.mbox.in)',
  'Accept': 'application/json',
  'Accept-Encoding': 'gzip',
  'Content-Type': 'application/json;charset=UTF-8',
  'X-Sign-Version': '2.0',
  appid: '302770f8bb6543ce8bdff585943a1eca',
  appkey: 'a9d263ae575d4f5d94eab086a150c67e',
  region: 'IN',
  lang: 'en',
  os: 'android',
};

const LIVE_API_BASE = (
  process.env.MOVIEBOX_API_URL ||
  process.env.VITE_MOVIEBOX_API_URL ||
  ''
).replace(/\/$/, '');

// Render's moviebox-internal-api exposes the stable frontend contract below.
// Feed: GET /home?page=1
// Search: GET /search?q=<keyword>&page=1
const RENDER_ROUTE_BASE = LIVE_API_BASE.replace(/\/$/, '');

/* Legacy demo catalogue intentionally removed: MovieBox cards must always come
   from the configured Render service. */
const MOCK_ITEMS = [];
  { id: 'tt15398776', title: 'Oppenheimer',         year: 2023, lang: 'en', rating: 8.3, type: 'movie',  cover: 'https://image.tmdb.org/t/p/w300/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg',  cat: 'hollywood' },
  { id: 'tt9362722',  title: 'Spider-Man: Across the Spider-Verse', year: 2023, lang: 'en', rating: 8.7, type: 'movie', cover: 'https://image.tmdb.org/t/p/w300/8Vt6mWEReuy4Of61Lnj5Xj704m8.jpg', cat: 'hollywood' },
  { id: 'tt1517268',  title: 'Barbie',               year: 2023, lang: 'en', rating: 6.9, type: 'movie',  cover: 'https://image.tmdb.org/t/p/w300/iuFNMS8vlbRBa6v4bANVFqVvnGW.jpg', cat: 'hollywood' },
  { id: 'tt14444726', title: 'Poor Things',           year: 2023, lang: 'en', rating: 8.0, type: 'movie',  cover: 'https://image.tmdb.org/t/p/w300/kCGlIMHnOm8JPXIwfXF6zqIzON0.jpg', cat: 'hollywood' },
  { id: 'tt21823606', title: 'Dune: Part Two',        year: 2024, lang: 'en', rating: 8.5, type: 'movie',  cover: 'https://image.tmdb.org/t/p/w300/8b8R8l88Qje9dn9OE8PY05Nxl1X.jpg', cat: 'hollywood' },
  { id: 'tt13623988', title: 'Godzilla x Kong',       year: 2024, lang: 'en', rating: 6.3, type: 'movie',  cover: 'https://image.tmdb.org/t/p/w300/z1p34vh7dEOnLDmyCrlUVLuoDzd.jpg', cat: 'hollywood' },
  { id: 'tt11315808', title: 'Kingdom of the Planet of the Apes', year: 2024, lang: 'en', rating: 7.1, type: 'movie', cover: 'https://image.tmdb.org/t/p/w300/gKkl37BQuKTanygYQG1pyYgLVgf.jpg', cat: 'hollywood' },
  { id: 'tt0468569',  title: 'The Dark Knight',       year: 2008, lang: 'en', rating: 9.0, type: 'movie',  cover: 'https://image.tmdb.org/t/p/w300/qJ2tW6WMUDux911r6m7haRef0WH.jpg', cat: 'hollywood' },
  { id: 'tt26101579', title: 'Pushpa: The Rule',      year: 2024, lang: 'te', rating: 7.8, type: 'movie',  cover: 'https://image.tmdb.org/t/p/w300/aBFQA1Uf1jxG9V9CkYCBs2tniGG.jpg', cat: 'south'     },
  { id: 'tt13560574', title: 'Kalki 2898-AD',         year: 2024, lang: 'te', rating: 7.2, type: 'movie',  cover: 'https://image.tmdb.org/t/p/w300/tR3W8oU7zHtRcHFm4r8Ekp4SGUI.jpg', cat: 'south'     },
  { id: 'tt14154714', title: 'Animal',                year: 2023, lang: 'hi', rating: 6.9, type: 'movie',  cover: 'https://image.tmdb.org/t/p/w300/pB9L0jAnEQLMKgexqCEocEW8TA.jpg',  cat: 'bollywood' },
  { id: 'tt15671028', title: 'Jawan',                 year: 2023, lang: 'hi', rating: 7.0, type: 'movie',  cover: 'https://image.tmdb.org/t/p/w300/cxqkPwUEnbleTHlQKFmALNRN6Iy.jpg', cat: 'bollywood' },
  { id: 'tt14259824', title: 'Pathaan',               year: 2023, lang: 'hi', rating: 5.9, type: 'movie',  cover: 'https://image.tmdb.org/t/p/w300/qSbMSRcVvFDFRPDXnSmMaHHsAcW.jpg', cat: 'bollywood' },
  { id: 'tt9114286',  title: 'Black Panther: Wakanda Forever', year: 2022, lang: 'en', rating: 6.7, type: 'movie', cover: 'https://image.tmdb.org/t/p/w300/sv1xJUazXeYqALzczSZ3O6nkH75.jpg', cat: 'hollywood' },
  { id: 'tt1877830',  title: 'The Batman',            year: 2022, lang: 'en', rating: 7.8, type: 'movie',  cover: 'https://image.tmdb.org/t/p/w300/74xTEgt7R36Fpooo50r9T25onhq.jpg', cat: 'hollywood' },
  { id: 'tt0816692',  title: 'Interstellar',          year: 2014, lang: 'en', rating: 8.7, type: 'movie',  cover: 'https://image.tmdb.org/t/p/w300/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg', cat: 'hollywood' },
];

// Korean dramas mock
const MOCK_KOREAN = [
  { id: 'tt13622776', title: 'Squid Game',            year: 2021, lang: 'ko', rating: 8.0, type: 'tv',    cover: 'https://image.tmdb.org/t/p/w300/dDlEmu3EZ0Pgg93QPTrgbyEPTKD.jpg', cat: 'korean' },
  { id: 'tt20247352', title: 'Moving',                year: 2023, lang: 'ko', rating: 8.6, type: 'tv',    cover: 'https://image.tmdb.org/t/p/w300/5zE9jJpXSaJsGKuXikHDpq7oHEf.jpg', cat: 'korean' },
  { id: 'tt9209966',  title: 'Crash Landing on You',  year: 2019, lang: 'ko', rating: 8.5, type: 'tv',    cover: 'https://image.tmdb.org/t/p/w300/yccHIiAnxODMmCUOmWHbKRBrXRl.jpg', cat: 'korean' },
  { id: 'tt8108198',  title: 'Itaewon Class',         year: 2020, lang: 'ko', rating: 8.2, type: 'tv',    cover: 'https://image.tmdb.org/t/p/w300/pWLCjhfgPKbXkf7lZ3gzjGsTLvw.jpg', cat: 'korean' },
];

// Category → subset filter
const CAT_FILTER = {
  trending:  () => true,
  movie:     i => i.type === 'movie',
  movies:    i => i.type === 'movie',
  tv:        i => i.type === 'tv',
  bollywood: i => i.cat === 'bollywood',
  south:     i => i.cat === 'south',
  hollywood: i => i.cat === 'hollywood',
  korean:    i => i.cat === 'korean',
};

function getMockItems(category) {
  const pool = [...MOCK_ITEMS, ...MOCK_KOREAN];
  const key  = (category || 'trending').toLowerCase().replace(/-/g, ' ');
  const fn   = CAT_FILTER[key] || (() => true);
  const filtered = pool.filter(fn);
  return (filtered.length ? filtered : pool).map(i => ({
    ...i,
    _mock: true,   // so the frontend can tell these are demo items
  }));
}

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
  const timestamp = String(Date.now());
  const digest = createHash('md5').update([...timestamp].reverse().join('')).digest('hex');
  return { ...CLIENT_HEADERS, 'X-Timestamp': timestamp, 'X-Client-Token': `${timestamp},${digest}` };
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
  if (Array.isArray(json?.data?.list)) {
    return json.data.list.flatMap(section => Array.isArray(section?.items) ? section.items : [section]);
  }
  if (Array.isArray(json?.data?.items)) return json.data.items;
  if (Array.isArray(json?.data?.subjects)) return json.data.subjects;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.items)) return json.items;
  if (Array.isArray(json?.list)) return json.list;
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
    item.contentId || item.content_id || item.id || item.idStr;
  const title = item.title || item.name || item.subjectName || item.subject_name || item.subjectTitle || item.showName;
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
      body: JSON.stringify({ error: 'MOVIEBOX_API_URL is not configured' }),
    };
  }

  const key = (category || 'trending').toLowerCase();
  const candidates = q
    ? [{ url: `${RENDER_ROUTE_BASE}/search?q=${encodeURIComponent(q)}&page=1` }]
    : [{ url: `${RENDER_ROUTE_BASE}/home?page=1` }];
  /* Direct official routes are only used when the configured URL is itself the
     MovieBox BFF. The Render repository is the source of truth for this app. */
  if (LIVE_API_BASE.includes(OFFICIAL_PATH)) {
    candidates.push(...(q
      ? [{ url: officialUrl('/subject-api/search', { q, page: 1, pageSize: 24 }), method: 'POST', body: JSON.stringify({ keyword: q, page: 1, pageSize: 24 }) }]
      : [{ url: officialUrl('/subject-api/daily-movie-rec'), method: 'POST', body: JSON.stringify({ page: 1, pageSize: 24 }) }]));
  }
  /* Legacy category candidates are intentionally not used for the Render
     adapter: /home and /search are the tested routes in moviebox-internal-api. */
  /*
    : [
        { url: `${ROOT_API_BASE}/${customRoute === 'trending' ? 'trending' : customRoute}` },
        ...(key === 'trending'
          ? [{
              url: officialUrl('/subject-api/trending/v2'),
              method: 'POST',
              body: JSON.stringify({ page: 1, pageSize: 24 }),
            }]
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
  */
  let upstreamUrl = candidates[0].url;

  try {
    let resp;
    let raw = [];
    const failures = [];
    // The imported UI historically used a small Render adapter contract
    // (/search and /trending). If MOVIEBOX_API_URL points directly at an
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
    if (!raw.length) {
      throw new Error(`Render MovieBox returned an empty ${q ? 'search' : 'home'} response`);
    }

    // Normalize README/official-doc response shapes to a plain item array.
    // Home endpoints may return section objects ({items:[...]}) inside
    // {data:{list:[...]}} while search commonly returns a direct list.
    let items = raw.map(item => normalizeItem(item, key)).filter(Boolean);
    if (!items.length) {
      throw new Error('Render MovieBox returned no content');
    }
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(items) };

  } catch (err) {
    console.error('[get-feed] Error:', err.message, '| Route:', new URL(upstreamUrl).pathname);
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'MovieBox API unavailable', detail: err.message }),
    };
  }
};
