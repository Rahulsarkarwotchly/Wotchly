// streamResolver.js — Wotchly Stream Engine  v4
// Anime: AniList GraphQL (search) + ani.zip (MAL→TMDB mapping) + multi-provider embed
// OTT:   Netflix / Prime / Hotstar / Disney+ → multi-provider embed
// Pure utility module — no side effects, no DOM access.

// ─────────────────────────────────────────────────────────────
// EMBED PROVIDERS  (ordered by reliability — update as needed)
// ─────────────────────────────────────────────────────────────

// Provider capability notes:
//   autoembed.co  — ?primaryLang=CODE  (audio dub)   ?secondaryLang=CODE  (subtitles)
//   vidlink.pro   — ?lang=CODE         (audio dub)   ?sub=1&subLang=CODE  (subtitles)
//   vidsrc.xyz    — uses ?dub=1 for dubbed audio; anime has dedicated /embed/anime/ path
//                   ignores ?primaryLang; handled separately in _applyEmbedParams
// Removed (no URL-param lang control): vidsrc.to, vidsrc.in, 2embed.cc, embed.su, multiembed.mov, vidsrc.me
export const EMBED_PROVIDERS = [
  { id: 'autoembed',   base: 'https://player.autoembed.co', name: 'AutoEmbed'  },
  { id: 'vidlink.pro', base: 'https://vidlink.pro',          name: 'VidLink'    },
  { id: 'vidsrc.xyz',  base: 'https://vidsrc.xyz',           name: 'VidSrc XYZ' },
];

export const DEFAULT_PROVIDER = EMBED_PROVIDERS[0];

// ─────────────────────────────────────────────────────────────
// ANIME  (AniList → ani.zip → embed)
// ─────────────────────────────────────────────────────────────

const ANILIST_URL = 'https://graphql.anilist.co';

const ANIME_SEARCH_QUERY = `
query($search: String) {
  Page(perPage: 8) {
    media(search: $search, type: ANIME, sort: POPULARITY_DESC) {
      id
      idMal
      title { romaji english }
      episodes
      coverImage { medium }
      status
      format
    }
  }
}`;

/**
 * Search for anime using AniList GraphQL.
 * Returns up to 8 results sorted by popularity.
 * @param {string} query
 * @returns {Promise<Array<{id,idMal,title,totalEpisodes,image,status}>>}
 */
export async function searchAnime(query) {
  const res = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: ANIME_SEARCH_QUERY, variables: { search: query } }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  return (json?.data?.Page?.media || []).map(m => ({
    id: m.id,
    idMal: m.idMal,
    title: m.title.english || m.title.romaji,
    totalEpisodes: m.episodes || null,
    image: m.coverImage?.medium || '',
    status: m.status,
    format: m.format || null,   // 'MOVIE' | 'TV' | 'OVA' | 'SPECIAL' | etc.
    isMovie: m.format === 'MOVIE',
  }));
}

/**
 * Fetch full ani.zip mapping for a MAL ID.
 * Returns an object with thetvdb_id, imdb_id, themoviedb_id (all may be null).
 * @param {number} malId
 * @returns {Promise<{thetvdb_id:number|null, imdb_id:string|null, themoviedb_id:string|null}>}
 */
export async function getAniZipMappings(malId) {
  const empty = { thetvdb_id: null, imdb_id: null, themoviedb_id: null };
  if (!malId) return empty;
  try {
    const res = await fetch(
      `https://api.ani.zip/mappings?mal_id=${malId}`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return empty;
    const data = await res.json();
    const m = data?.mappings || {};
    return {
      thetvdb_id:   m.thetvdb_id   || null,
      imdb_id:      m.imdb_id      || null,
      themoviedb_id: m.themoviedb_id ? String(m.themoviedb_id) : null,
    };
  } catch {
    return empty;
  }
}

/**
 * Resolve a MAL ID to a TMDB TV ID via ani.zip (all embed providers use TMDB, not TVDB).
 * Falls back to TVDB only if TMDB is unavailable.
 * @param {number} malId
 * @returns {Promise<string|number|null>}
 */
export async function getMalToTmdbId(malId) {
  const maps = await getAniZipMappings(malId);
  // Prefer TMDB — supported by every provider (autoembed, vidsrc.to, vidsrc.in, vidlink, 2embed)
  // TVDB fallback only: vidsrc.to accepts it but vidlink.pro returns 500 on TVDB IDs
  return maps.themoviedb_id || maps.thetvdb_id || null;
}

/**
 * Build an embed URL for an anime episode using the given provider base URL.
 * @param {number} tmdbOrTvdbId
 * @param {number} episode
 * @param {number} season
 * @param {string} providerBase
 * @returns {string}
 */
export function buildAnimeEpisodeUrl(tmdbOrTvdbId, episode, season = 1, providerBase = DEFAULT_PROVIDER.base) {
  const base = providerBase || DEFAULT_PROVIDER.base;
  if (base.includes('2embed.cc')) {
    return `${base}/embedtv/${tmdbOrTvdbId}&s=${season}&e=${episode}`;
  }
  if (base.includes('multiembed.mov')) {
    return `${base}/?video_id=${tmdbOrTvdbId}&tmdb=1&s=${season}&e=${episode}`;
  }
  if (base.includes('vidlink.pro')) {
    return `${base}/tv/${tmdbOrTvdbId}/${season}/${episode}`;
  }
  // vidsrc.xyz — has a dedicated /embed/anime/ path for better dub coverage
  if (base.includes('vidsrc.xyz')) {
    return `${base}/embed/anime/${tmdbOrTvdbId}/${season}/${episode}`;
  }
  // autoembed.co / vidsrc.to / embed.su / vidsrc.me
  return `${base}/embed/tv/${tmdbOrTvdbId}/${season}/${episode}`;
}

/**
 * Full pipeline: MAL ID → TMDB/TVDB ID → embed URL.
 * Falls back to a direct AniList ID lookup if mapping fails.
 * @param {number} malId
 * @param {number} anilistId
 * @param {number} episode
 * @param {number} season
 * @param {string} providerBase
 * @returns {Promise<{url: string, provider: string}|null>}
 */
export async function resolveAnimeEpisodeUrl(malId, anilistId, episode, season = 1, providerBase = DEFAULT_PROVIDER.base) {
  const tvId = await getMalToTmdbId(malId);
  if (tvId) {
    return {
      url: buildAnimeEpisodeUrl(tvId, episode, season, providerBase),
      provider: providerBase,
    };
  }
  // Fallback 1: try with MAL ID directly
  if (malId) {
    return {
      url: buildAnimeEpisodeUrl(malId, episode, season, providerBase),
      provider: providerBase,
    };
  }
  // Fallback 2: try with AniList ID
  if (anilistId) {
    return {
      url: buildAnimeEpisodeUrl(anilistId, episode, season, providerBase),
      provider: providerBase,
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// ANIME EPISODES  (AniList → episode list + embed URL)
// ─────────────────────────────────────────────────────────────

const ANILIST_MEDIA_QUERY = `
query($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    idMal
    episodes
    title { romaji english }
  }
}`;

/**
 * Fetch episode list for an anime by AniList ID.
 * @param {number} anilistId
 * @returns {Promise<Array<{id: string, number: number}>>}
 */
export async function getAnimeEpisodes(anilistId) {
  const res = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: ANILIST_MEDIA_QUERY, variables: { id: anilistId } }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  const media = json?.data?.Media;
  if (!media) throw new Error('Anime not found');

  const total = media.episodes || 24;
  const malId = media.idMal || 0;

  return Array.from({ length: total }, (_, i) => ({
    id: `${anilistId}|${malId}|${i + 1}`,
    number: i + 1,
  }));
}

/**
 * Resolve an episode id (from getAnimeEpisodes) to an embed URL.
 * episodeId format: "${anilistId}|${malId}|${episode}"
 * @param {string} episodeId
 * @param {string} providerBase
 * @returns {Promise<string|null>}
 */
export async function getAnimeStreamUrl(episodeId, providerBase = DEFAULT_PROVIDER.base) {
  const parts = String(episodeId).split('|');
  const anilistId = parseInt(parts[0], 10);
  const malId     = parseInt(parts[1], 10);
  const episode   = parseInt(parts[2], 10);

  if (!episode) return null;

  const result = await resolveAnimeEpisodeUrl(malId, anilistId, episode, 1, providerBase);
  return result?.url || null;
}

// ─────────────────────────────────────────────────────────────
// OTT EMBED  (Netflix / Prime Video / Hotstar / Disney+ → embed)
// ─────────────────────────────────────────────────────────────

/**
 * Build an embed URL for a given provider.
 * Supports: vidsrc.to, embed.su, vidlink.pro, 2embed.cc, multiembed.mov, vidsrc.me
 * @param {string} id            - IMDb ID, TMDB ID, or platform-specific ID
 * @param {'movie'|'tv'} contentType
 * @param {number|null} season
 * @param {number|null} episode
 * @param {string} providerBase
 * @returns {string}
 */
export function buildVidsrcEmbedUrl(id, contentType = 'movie', season = null, episode = null, providerBase = DEFAULT_PROVIDER.base) {
  const base = providerBase || DEFAULT_PROVIDER.base;

  if (base.includes('2embed.cc')) {
    if (contentType === 'tv' && season != null && episode != null) {
      return `${base}/embedtv/${id}&s=${season}&e=${episode}`;
    }
    return `${base}/embed/${id}`;
  }

  if (base.includes('multiembed.mov')) {
    if (contentType === 'tv' && season != null && episode != null) {
      return `${base}/?video_id=${id}&tmdb=1&s=${season}&e=${episode}`;
    }
    return `${base}/?video_id=${id}&tmdb=1`;
  }

  // vidlink.pro — no /embed/ prefix
  if (base.includes('vidlink.pro')) {
    if (contentType === 'tv' && season != null && episode != null) {
      return `${base}/tv/${id}/${season}/${episode}`;
    }
    return `${base}/movie/${id}`;
  }

  // vidsrc.to / embed.su / vidsrc.me / vidsrc.xyz — standard /embed/ format
  if (contentType === 'tv' && season != null && episode != null) {
    return `${base}/embed/tv/${id}/${season}/${episode}`;
  }
  return `${base}/embed/movie/${id}`;
}

/**
 * Async pipeline: MAL ID → ani.zip → IMDb/TMDB ID → movie embed URL.
 * Falls back to MAL ID directly only as last resort (usually fails on embed providers).
 * Returns null if the movie has no recognized ID yet (too new).
 * @param {number} malId
 * @param {number} anilistId
 * @param {string} providerBase
 * @returns {Promise<{url:string, idUsed:string, warn:string|null}|null>}
 */
export async function resolveAnimeMovieUrl(malId, anilistId, providerBase = DEFAULT_PROVIDER.base) {
  const base = providerBase || DEFAULT_PROVIDER.base;

  // 1. Try ani.zip for a real IMDb or TMDB ID
  const maps = await getAniZipMappings(malId);
  const resolvedId = maps.imdb_id || maps.themoviedb_id || null;

  if (resolvedId) {
    return {
      url: _buildMovieUrl(resolvedId, base),
      idUsed: resolvedId,
      warn: null,
    };
  }

  // 2. No IMDb/TMDB yet — movie too new or unmapped
  // Try MAL ID as a last resort (works on some anime-aware embed sites)
  const fallbackId = malId || anilistId;
  if (!fallbackId) return null;

  return {
    url: _buildMovieUrl(String(fallbackId), base),
    idUsed: String(fallbackId),
    warn: 'No IMDb/TMDB ID found — movie may be too new for embed providers.',
  };
}

function _buildMovieUrl(id, base) {
  if (base.includes('vidlink.pro'))    return `${base}/movie/${id}`;
  if (base.includes('2embed.cc'))      return `${base}/embed/${id}`;
  if (base.includes('multiembed.mov')) return `${base}/?video_id=${id}&tmdb=1`;
  // autoembed.co / vidsrc.to / vidsrc.in / vidsrc.me — standard /embed/movie/ format
  return `${base}/embed/movie/${id}`;
}

/**
 * @deprecated Use resolveAnimeMovieUrl (async) instead.
 */
export function buildAnimeMovieEmbedUrl(malId, anilistId, providerBase = DEFAULT_PROVIDER.base) {
  const id = malId || anilistId;
  return _buildMovieUrl(String(id), providerBase || DEFAULT_PROVIDER.base);
}

/**
 * Extract a human-readable title from an OTT platform URL slug.
 * e.g. "dhurandhar-the-revenge" → "Dhurandhar The Revenge"
 * @param {string} rawUrl
 * @returns {string|null}
 */
export function extractTitleFromOttUrl(rawUrl) {
  try {
    const u = new URL(rawUrl.trim());
    const parts = u.pathname.split('/').filter(Boolean);
    // Find the slug part — longest segment that looks like a title slug
    const slug = parts.find(p => /[a-z]+-[a-z]+/.test(p) && !/^\d+$/.test(p));
    if (!slug) return null;
    // Remove trailing numeric ID if slug ends with one (e.g. "title-1234567890")
    const clean = slug.replace(/-\d{6,}$/, '');
    return clean.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  } catch { return null; }
}

/**
 * Parse a Netflix, Prime Video, Hotstar, or Disney+ URL to extract a content identifier.
 * @param {string} rawUrl
 * @returns {{ platform: string, id: string } | null}
 */
export function parseOttUrl(rawUrl) {
  try {
    const u = new URL(rawUrl.trim());
    const h = u.hostname.toLowerCase();

    if (h.includes('netflix.com')) {
      const m = u.pathname.match(/\/(watch|title)\/(\d+)/);
      if (m) return { platform: 'netflix', id: m[2] };
      const jbv = u.searchParams.get('jbv');
      if (jbv) return { platform: 'netflix', id: jbv };
    }
    if (h.includes('primevideo.com') || (h.includes('amazon.com') && u.pathname.includes('video'))) {
      const m = u.pathname.match(/\/(?:detail|dp|gp\/video\/detail)\/([A-Z0-9]{10,})/i);
      if (m) return { platform: 'prime', id: m[1] };
    }
    if (h.includes('hotstar.com') || h.includes('jiohotstar.com')) {
      // Hotstar URL: /in/movies/title/1234567890 or /watch/1234567890
      const m = u.pathname.match(/\/(\d{7,})(?:\/|$)/) || u.pathname.match(/\/([a-z0-9-]+-(\d{7,}))(?:\/|$)/i);
      if (m) {
        const numId = m[2] || m[1];
        // Try to get IMDb-style ID if present in query
        const imdb = u.searchParams.get('imdb');
        if (imdb) return { platform: 'hotstar', id: imdb };
        return { platform: 'hotstar', id: numId };
      }
    }
    if (h.includes('disneyplus.com')) {
      const m = u.pathname.match(/\/video\/([a-f0-9-]{8,})/i) || u.pathname.match(/\/([a-f0-9-]{20,})/i);
      if (m) return { platform: 'disney+', id: m[1] };
    }
    if (h.includes('crunchyroll.com')) {
      return null; // DRM — handled separately in script.js
    }
  } catch { /* invalid URL */ }
  return null;
}

/**
 * Resolve any OTT input to an embed URL for the given provider.
 * Accepts: IMDb IDs (tt…), TMDB numeric IDs, Netflix/Prime/Hotstar/Disney+ URLs,
 *          or pre-built embed URLs (passed through unchanged).
 * @param {string} input
 * @param {'movie'|'tv'} contentType
 * @param {number|null} season
 * @param {number|null} episode
 * @param {string} providerBase
 */
export function resolveOttEmbed(input, contentType = 'movie', season = null, episode = null, providerBase = DEFAULT_PROVIDER.base) {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;

  const base = providerBase || DEFAULT_PROVIDER.base;

  // IMDb ID  — tt followed by 5-10 digits
  if (/^tt\d{5,10}$/i.test(trimmed)) {
    return {
      url: buildVidsrcEmbedUrl(trimmed, contentType, season, episode, base),
      provider: base,
      note: `IMDb embed (${trimmed})`,
    };
  }
  // TMDB numeric ID
  if (/^\d{4,8}$/.test(trimmed)) {
    return {
      url: buildVidsrcEmbedUrl(trimmed, contentType, season, episode, base),
      provider: base,
      note: `TMDB ID (${trimmed})`,
    };
  }
  // Full OTT platform URL
  const parsed = parseOttUrl(trimmed);
  if (parsed) {
    return {
      url: buildVidsrcEmbedUrl(parsed.id, contentType, season, episode, base),
      provider: base,
      note: `${parsed.platform} embed`,
      platform: parsed.platform,
    };
  }
  // Already an embed URL — pass through
  if (
    trimmed.includes('vidsrc.') ||
    trimmed.includes('/embed/') ||
    trimmed.includes('2embed.') ||
    trimmed.includes('multiembed.') ||
    trimmed.includes('vidlink.') ||
    trimmed.includes('embed.su')
  ) {
    return { url: trimmed, provider: 'passthrough', note: 'Direct embed URL' };
  }
  return null;
}
