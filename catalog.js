// ============================================================
// Wotchly Cinema Catalog — REAL, full-length movies, dramas and
// shows streamed live from the Internet Archive open API
// (archive.org). Public-domain & open films — playable,
// previewable and downloadable. Open, free, CORS-friendly,
// no API key required.
// ============================================================

const IA_SEARCH   = 'https://archive.org/advancedsearch.php';
const IA_METADATA = 'https://archive.org/metadata/';
const IA_IMG      = id => `https://archive.org/services/img/${id}`;

const SEARCH_FIELDS = ['identifier', 'title', 'year', 'language', 'avg_rating', 'downloads', 'description', 'collection'];

// Category → Internet Archive query fragment. Hindi content is
// prioritized across the board. `mediatype:(movies)` is appended
// to every query so only real video items come back.
const CAT_QUERIES = {
  trending:  '(language:(hindi) OR subject:(bollywood)) AND -title:(trailer)',
  featured:  '(language:(hindi) OR subject:(bollywood)) AND -title:(trailer)',
  all:       '(language:(hindi) OR subject:(bollywood) OR collection:(feature_films) OR collection:(classic_tv)) AND -title:(trailer)',
  movie:     'collection:(feature_films)',
  movies:    'collection:(feature_films)',
  hollywood: 'collection:(feature_films)',
  drama:     'collection:(feature_films)',
  bollywood: '(language:(hindi) OR subject:(bollywood)) AND -title:(trailer)',
  hindi:     '(language:(hindi) OR subject:(bollywood)) AND -title:(trailer)',
  'short drama': '(language:(hindi) OR subject:(bollywood)) AND -title:(trailer)',
  tv:        'collection:(classic_tv)',
  anime:     'collection:(animationandcartoons)',
  midnight:  '(collection:(feature_films) AND subject:(horror))',
  serials:   'collection:(classic_tv)',
  korean:    '(language:(korean) AND mediatype:(movies))',
  south:     '((language:(tamil) OR language:(telugu)) AND mediatype:(movies))',
};

const LANG_NAMES = {
  hin: 'Hindi', hindi: 'Hindi', eng: 'English', english: 'English',
  urd: 'Urdu', ben: 'Bengali', tam: 'Tamil', tel: 'Telugu',
  mar: 'Marathi', pan: 'Punjabi', mal: 'Malayalam', kan: 'Kannada',
};

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

/** Map one Internet Archive search doc → app catalog item. */
function docToItem(doc) {
  const rawLang = String(first(doc.language) || '').trim();
  const lang = LANG_NAMES[rawLang.toLowerCase()] || rawLang;
  const colls = [].concat(doc.collection || []);
  const isHindi = rawLang.toLowerCase() === 'hin' || rawLang.toLowerCase() === 'hindi';
  const cat =
    isHindi                                    ? 'bollywood'
    : colls.includes('classic_tv')             ? 'tv'
    : colls.includes('animationandcartoons')   ? 'anime'
    : 'hollywood';
  let desc = String(first(doc.description) || '').replace(/<[^>]*>/g, '').slice(0, 220);
  return {
    id: doc.identifier,
    title: String(first(doc.title) || doc.identifier),
    year: (String(doc.year || '').match(/\d{4}/) || [''])[0],
    lang, cat,
    type: cat === 'tv' ? 'tv' : 'movie',
    rating: doc.avg_rating ? Number(doc.avg_rating).toFixed(1) : '',
    cover: IA_IMG(doc.identifier),
    previewUrl: `https://archive.org/embed/${doc.identifier}`,
    downloadUrl: `https://archive.org/download/${doc.identifier}/`,
    desc,
  };
}

const _feedCache = new Map();

/**
 * Fetch catalog items for a category or search query — LIVE from
 * the Internet Archive. Same return shape the app expects:
 * { items, errorType, status }. Never throws.
 */
export async function fetchCatalogFeed(category = 'trending', query = '') {
  const q = String(query || '').trim();
  const key = `${String(category).toLowerCase()}|${q.toLowerCase()}`;
  if (_feedCache.has(key)) return { items: _feedCache.get(key), errorType: null, status: 200 };

  const frag = q
    ? `((title:(${q}) OR description:(${q})) AND mediatype:(movies))`
    : `${CAT_QUERIES[String(category).toLowerCase()] || CAT_QUERIES.trending} AND mediatype:(movies)`;

  const params = new URLSearchParams();
  SEARCH_FIELDS.forEach(f => params.append('fl[]', f));
  params.append('q', frag);
  params.append('sort[]', 'downloads desc');
  params.append('rows', '36');
  params.append('page', '1');
  params.append('output', 'json');

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(`${IA_SEARCH}?${params.toString()}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { items: [], errorType: 'server_down', status: res.status };
    const data = await res.json();
    const items = (data?.response?.docs || []).map(docToItem);
    _feedCache.set(key, items);
    return { items, errorType: null, status: res.status };
  } catch (err) {
    return { items: [], errorType: err?.name === 'AbortError' ? 'timeout' : 'network', status: null };
  }
}

const _streamCache = new Map();

/**
 * Resolve an Internet Archive item to its direct, playable MP4 URL.
 * Uses the item's metadata API to pick the best streamable file.
 */
export async function loadCatalogStream(movieId) {
  if (!movieId) return null;
  if (_streamCache.has(movieId)) return _streamCache.get(movieId);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(`${IA_METADATA}${encodeURIComponent(movieId)}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const mp4s = (data?.files || []).filter(f => /\.mp4$/i.test(String(f.name || '')));
    // Prefer IA's stream-friendly h.264 derivative, then the 512kb
    // web derivative, then the original upload, then anything.
    const pick =
      mp4s.find(f => /h\.?264/i.test(String(f.format)) && f.source === 'derivative') ||
      mp4s.find(f => /\.512kb\.mp4$/i.test(String(f.name))) ||
      mp4s.find(f => f.source === 'original') ||
      mp4s[0];
    if (!pick) return null;
    const url = `https://archive.org/download/${movieId}/${encodeURIComponent(pick.name)}`;
    _streamCache.set(movieId, url);
    return url;
  } catch {
    return null;
  }
}
