// netlify/functions/get-feed.js
//
// Discover feed + search for the watch-together room.
//
// Replaces the defunct MovieBox backend with two real sources:
//   • Internet Archive — full-length public-domain films, TV, animation, noir,
//     serials. These stream in the app's own player, so room sync stays exact.
//   • TMDB (optional, needs TMDB_API_KEY) — worldwide titles with posters and
//     ratings; a TMDB pick plays its official trailer.
//
// Returns a flat JSON array of cards:
//   { id, title, year, lang, rating, cover, type, cat, badge? }
import { archiveFeed, tmdbFeed, tmdbKeyConfigured } from './_sources.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

function json(statusCode, body) {
  return { statusCode, headers: corsHeaders, body: JSON.stringify(body) };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  const params = event.queryStringParameters ?? {};
  const category = String(params.category || 'trending');
  const query = String(params.q || '').trim();

  const failures = [];

  // TMDB first everywhere: modern worldwide movies/shows with rich posters.
  // Internet Archive supplements with full public-domain classics.
  const order = ['tmdb', 'ia'];
  let items = [];

  for (const source of order) {
    try {
      const part = source === 'tmdb'
        ? await tmdbFeed({ category, query, rows: query ? 12 : 12 })
        : await archiveFeed({ category, query, rows: query ? 24 : 36 });
      items = items.concat(part);
    } catch (err) {
      console.error(`[get-feed] ${source} failed:`, err.message);
      failures.push(source);
    }
  }

  if (!items.length && failures.length) {
    return json(502, { error: 'All media sources are unreachable right now' });
  }

  return json(200, {
    items,
    sources: { tmdb: tmdbKeyConfigured() && !failures.includes('tmdb'), archive: !failures.includes('ia') },
  });
};