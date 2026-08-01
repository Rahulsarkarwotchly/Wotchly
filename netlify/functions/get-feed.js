// netlify/functions/get-feed.js
// Proxies MovieBox feed/search requests to the Render API server-side.
// Fallback: when the live API is unreachable, returns curated mock data so the
// browse UI stays functional and never shows "API unavailable" hard errors.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
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

// ─── Mock / fallback catalogue ────────────────────────────────────────────────
// Shown whenever the live Render API is unreachable (cold-start, downtime, etc.).
// These entries use stable TMDB poster CDN URLs for covers.
const MOCK_ITEMS = [
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

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  const { category, q } = event.queryStringParameters ?? {};

  // MOVIEBOX_API_URL not configured → serve mock immediately.
  if (!LIVE_API_BASE) {
    const items = q ? [] : getMockItems(category);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(items),
    };
  }

  let apiUrl;
  if (q) {
    apiUrl = `${LIVE_API_BASE}/search?q=${encodeURIComponent(q)}`;
  } else {
    const key   = (category || 'trending').toLowerCase();
    const route = routeMap[key] || key;
    apiUrl = `${LIVE_API_BASE}/api/home/${route}`;
  }

  try {
    const resp = await fetch(apiUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      // 10s timeout — if Render is cold-starting, the client retry loop handles retries.
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) throw new Error(`Upstream returned ${resp.status}`);

    const data = await resp.json();
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(data) };

  } catch (err) {
    console.error('[get-feed] Error:', err.message, '| URL:', apiUrl);

    // API down / timeout → serve mock data so the UI stays functional.
    const items = q ? [] : getMockItems(category);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(items),
    };
  }
};
