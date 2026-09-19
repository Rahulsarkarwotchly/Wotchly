// netlify/functions/_sources.js
//
// Shared media-source helpers for Wotchly's Discover feed + stream resolver.
//
// Two real, lawful backends replace the defunct MovieBox API:
//
//   • Internet Archive — full-length public-domain films, classic TV, animation,
//     noir and serials. Streams are real MP4 files served by archive.org, so they
//     play in the app's OWN HTML5 player and room sync stays exact.
//     No API key required.
//
//   • TMDB — worldwide metadata for search (posters, year, rating, language).
//     A TMDB title plays its official trailer through the YouTube player.
//     Optional: only used when TMDB_API_KEY is configured.
//
// Item ids are namespaced so the stream resolver knows where to look:
//   ia:<archive-identifier>          → full film
//   tmdb:<movie|tv>:<tmdb-id>        → official trailer

const ARCHIVE_SEARCH = 'https://archive.org/advancedsearch.php';
const ARCHIVE_METADATA = 'https://archive.org/metadata';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const FETCH_TIMEOUT = 15000;

// ─── shared helpers ────────────────────────────────────────────────────────

async function getJson(url, headers = {}) {
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/** archive.org returns most scalar fields as a string OR a single-element array. */
function first(value) {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

const LANG_CODE = {
  english: 'en', hindi: 'hi', urdu: 'ur', korean: 'ko', japanese: 'ja',
  tamil: 'ta', telugu: 'te', malayalam: 'ml', kannada: 'kn', bengali: 'bn',
  chinese: 'zh', mandarin: 'zh', cantonese: 'zh', french: 'fr', spanish: 'es',
  german: 'de', russian: 'ru', italian: 'it', portuguese: 'pt', arabic: 'ar',
  turkish: 'tr', thai: 'th', indonesian: 'id', dutch: 'nl', polish: 'pl',
};

/** Normalise a language name / code ("English", "en", "hi-IN") to an ISO code. */
export function normalizeLang(value) {
  const raw = String(first(value) || '').trim().toLowerCase();
  if (!raw) return '';
  if (LANG_CODE[raw]) return LANG_CODE[raw];
  const base = raw.split(/[-_,;:/]/)[0].trim();
  if (base.length === 2) return base;
  return LANG_CODE[base] || base;
}

function normalizeYear(value) {
  const m = String(first(value) || '').match(/\d{4}/);
  return m ? m[0] : '';
}

// ─── Internet Archive ──────────────────────────────────────────────────────

// Category / pill → archive.org query. Results sort by downloads so every shelf
// leads with the most-watched public-domain titles.
const ARCHIVE_BASE = 'collection:(feature_films) AND mediatype:(movies)';

const ARCHIVE_QUERIES = {
  trending: `${ARCHIVE_BASE} AND year:[1900 TO 1999]`,
  movie: `${ARCHIVE_BASE} AND year:[1900 TO 1999]`,
  movies: `${ARCHIVE_BASE} AND year:[1900 TO 1999]`,
  hollywood: `${ARCHIVE_BASE} AND year:[1900 TO 1999]`,
  drama: `${ARCHIVE_BASE} AND subject:(drama)`,
  tv: 'collection:(classic_tv) AND mediatype:(movies)',
  serials: 'collection:(classic_tv) AND mediatype:(movies)',
  anime: 'collection:(animationandcartoons) AND mediatype:(movies)',
  midnight: `${ARCHIVE_BASE} AND subject:(horror)`,
  'short drama': `${ARCHIVE_BASE} AND subject:(drama)`,
  shorts: `${ARCHIVE_BASE} AND subject:(drama)`,
  bollywood: 'mediatype:(movies) AND (language:(Hindi) OR subject:(bollywood))',
  hindi: 'mediatype:(movies) AND (language:(Hindi) OR title:(hindi))',
  south: 'mediatype:(movies) AND (language:(Tamil) OR language:(Telugu))',
  korean: 'mediatype:(movies) AND (language:(Korean) OR title:(korean))',
  chinese: 'mediatype:(movies) AND (language:(Chinese) OR title:(chinese))',
  web: 'collection:(feature_films) AND mediatype:(movies)',
};

function archiveSearchUrl(query, rows, sort = 'downloads desc') {
  const params = new URLSearchParams();
  params.set('q', query);
  for (const f of ['identifier', 'title', 'year', 'language', 'downloads', 'subject', 'description']) {
    params.append('fl[]', f);
  }
  params.set('rows', String(rows));
  params.set('page', '1');
  params.set('output', 'json');
  params.append('sort[]', sort);
  return `${ARCHIVE_SEARCH}?${params.toString()}`;
}

function archiveItemToCard(doc) {
  const identifier = first(doc.identifier);
  if (!identifier) return null;
  const title = first(doc.title).replace(/\s+/g, ' ').trim();
  if (!title) return null;
  return {
    id: `ia:${identifier}`,
    title,
    year: normalizeYear(doc.year),
    lang: normalizeLang(doc.language),
    rating: '',
    cover: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
    type: 'movie',
    cat: '',
    downloads: Number(first(doc.downloads)) || 0,
  };
}

/**
 * Query the Internet Archive catalogue.
 * @param {{category?: string, query?: string, rows?: number}} opts
 */
export async function archiveFeed({ category = 'trending', query = '', rows = 36 } = {}) {
  const safe = String(query || '').replace(/["\\]/g, ' ').trim();
  const q = safe
    ? `mediatype:(movies) AND (title:("${safe}") OR description:("${safe}"))`
    : ARCHIVE_QUERIES[String(category).toLowerCase()] || ARCHIVE_QUERIES.trending;

  const json = await getJson(archiveSearchUrl(q, rows));
  const docs = json?.response?.docs || [];
  return docs.map(archiveItemToCard).filter(Boolean);
}

const MP4_PRIORITY = ['h.264', 'mpeg4', '512kb mpeg4', 'h.264 ia', 'mpeg4 ia', 'windows media'];

/** Resolve an archive.org identifier to a directly playable file URL. */
export async function archiveStream(identifier) {
  const json = await getJson(`${ARCHIVE_METADATA}/${encodeURIComponent(identifier)}`);
  const files = Array.isArray(json?.files) ? json.files : [];
  const videos = files.filter(f => /\.(mp4|m4v|webm|ogv|mpg|mpeg)$/i.test(f.name || ''));

  const rank = file => {
    const format = String(file.format || '').toLowerCase();
    const idx = MP4_PRIORITY.indexOf(format);
    return idx === -1 ? MP4_PRIORITY.length : idx;
  };
  const playable = videos
    .filter(f => /\.(mp4|m4v)$/i.test(f.name))
    .sort((a, b) => rank(a) - rank(b))[0]
    || videos.find(f => /\.(webm|ogv)$/i.test(f.name))
    || videos[0];

  if (!playable) throw new Error('no playable video file for this archive item');

  const subtitles = files
    .filter(f => /\.(vtt|srt)$/i.test(f.name || ''))
    .slice(0, 8)
    .map(f => ({
      url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(f.name)}`,
      label: String(f.name).replace(/\.[a-z0-9]+$/i, ''),
    }));

  return {
    stream_url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(playable.name)}`,
    quality: String(playable.height ? `${playable.height}p` : playable.format || ''),
    subtitles,
    title: first(json?.metadata?.title),
  };
}

// ─── TMDB (optional — only when a key is configured) ───────────────────────

export function tmdbKeyConfigured() {
  return Boolean((process.env.TMDB_API_KEY || process.env.TMDB_ACCESS_TOKEN || '').trim());
}

function tmdbUrl(path, params = {}) {
  const key = (process.env.TMDB_API_KEY || process.env.TMDB_ACCESS_TOKEN || '').trim();
  const url = new URL(TMDB_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  // v4 tokens are JWTs and travel in the Authorization header instead.
  if (!key.startsWith('ey')) url.searchParams.set('api_key', key);
  return url.toString();
}

function tmdbHeaders() {
  const key = (process.env.TMDB_API_KEY || process.env.TMDB_ACCESS_TOKEN || '').trim();
  return key.startsWith('ey') ? { Authorization: `Bearer ${key}` } : {};
}

function tmdbGet(path, params) {
  return getJson(tmdbUrl(path, params), tmdbHeaders());
}

const TMDB_CATEGORY_PATHS = {
  trending: ['/trending/all/week', {}],
  movie: ['/movie/popular', {}],
  movies: ['/movie/popular', {}],
  hollywood: ['/discover/movie', { with_original_language: 'en', sort_by: 'popularity.desc' }],
  tv: ['/tv/popular', {}],
  serials: ['/discover/tv', { with_genres: '18', sort_by: 'popularity.desc' }],
  anime: ['/discover/tv', { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc' }],
  midnight: ['/discover/movie', { with_genres: '27', sort_by: 'popularity.desc' }],
  'short drama': ['/discover/tv', { with_genres: '18', sort_by: 'popularity.desc' }],
  drama: ['/discover/movie', { with_genres: '18', sort_by: 'popularity.desc' }],
  bollywood: ['/discover/movie', { with_original_language: 'hi', sort_by: 'popularity.desc' }],
  hindi: ['/discover/movie', { with_original_language: 'hi', sort_by: 'popularity.desc' }],
  south: ['/discover/movie', { with_original_language: 'ta', sort_by: 'popularity.desc' }],
  korean: ['/discover/movie', { with_original_language: 'ko', sort_by: 'popularity.desc' }],
  chinese: ['/discover/movie', { with_original_language: 'zh', sort_by: 'popularity.desc' }],
  web: ['/discover/tv', { sort_by: 'popularity.desc' }],
};

function tmdbItemToCard(item, forcedType = '') {
  const mediaType = forcedType || item.media_type || (item.first_air_date ? 'tv' : 'movie');
  if (mediaType !== 'movie' && mediaType !== 'tv') return null;
  const id = item.id;
  const title = item.title || item.name || '';
  if (!id || !title) return null;
  const date = item.release_date || item.first_air_date || '';
  return {
    id: `tmdb:${mediaType}:${id}`,
    title,
    year: (date.match(/\d{4}/) || [''])[0],
    lang: normalizeLang(item.original_language),
    rating: item.vote_average ? Number(item.vote_average).toFixed(1) : '',
    cover: item.poster_path
      ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
      : item.backdrop_path
        ? `https://image.tmdb.org/t/p/w500${item.backdrop_path}`
        : '',
    type: mediaType,
    cat: '',
    badge: '',
  };
}

/**
 * Query TMDB. Returns [] when no key is configured so callers can merge safely.
 * `query` may also be an IMDb id (`tt…`), resolved through /find.
 */
export async function tmdbFeed({ category = 'trending', query = '', rows = 20 } = {}) {
  if (!tmdbKeyConfigured()) return [];

  if (query) {
    if (/^tt\d{5,10}$/i.test(query.trim())) {
      const found = await tmdbGet(`/find/${query.trim()}`, { external_source: 'imdb_id' });
      const hits = [...(found.movie_results || []), ...(found.tv_results || [])];
      return hits.slice(0, rows).map(item => tmdbItemToCard(item)).filter(Boolean);
    }
    const search = await tmdbGet('/search/multi', { query, include_adult: 'false' });
    return (search.results || [])
      .map(item => tmdbItemToCard(item))
      .filter(Boolean)
      .slice(0, rows);
  }

  const [path, params] = TMDB_CATEGORY_PATHS[String(category).toLowerCase()] || TMDB_CATEGORY_PATHS.trending;
  const json = await tmdbGet(path, params);
  const forcedType = path.startsWith('/movie') ? 'movie' : path.startsWith('/tv') ? 'tv' : '';
  return (json.results || [])
    .map(item => tmdbItemToCard(item, forcedType))
    .filter(Boolean)
    .slice(0, rows);
}

// Default embed provider (matches EMBED_PROVIDERS[0] in streamResolver.js).
const EMBED_BASE = 'https://player.autoembed.co';

/**
 * Resolve a TMDB title to a full-movie embed URL.
 * Fetches the IMDb ID via /external_ids for maximum provider compatibility,
 * falls back to the TMDB ID if unavailable. TV shows default to S1E1.
 */
export async function tmdbStream(mediaType, id) {
  if (!tmdbKeyConfigured()) throw new Error('TMDB_API_KEY is not configured');
  const type = mediaType === 'tv' ? 'tv' : 'movie';

  // Try to get the IMDb ID — embed providers accept it most reliably.
  let embedId = id;
  try {
    const ext = await tmdbGet(`/${type}/${id}/external_ids`);
    if (ext.imdb_id) embedId = ext.imdb_id;
  } catch { /* fall back to TMDB id */ }

  const streamUrl = type === 'tv'
    ? `${EMBED_BASE}/embed/tv/${embedId}/1/1`
    : `${EMBED_BASE}/embed/movie/${embedId}`;

  return {
    stream_url: streamUrl,
    provider: 'embed',
    subtitles: [],
  };
}