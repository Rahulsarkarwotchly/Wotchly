// netlify/functions/get-stream.js
//
// Resolves a Discover card id to something the room can actually play.
//
//   ia:<archive-identifier>   → direct MP4 URL from archive.org. Plays in the
//                               app's own HTML5 player, so sync stays exact.
//   tmdb:<movie|tv>:<tmdb-id> → official YouTube trailer embed URL.
//
// The response keeps the historical `stream_url` contract. Archive items also
// return `subtitles` (WebVTT files hosted by archive.org).
import { archiveStream, tmdbStream } from './_sources.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

  const id = (event.queryStringParameters ?? {}).id;
  if (!id) {
    return json(400, { error: 'Missing required query parameter: id' });
  }

  try {
    if (id.startsWith('ia:')) {
      const resolved = await archiveStream(id.slice(3));
      return json(200, { ...resolved, provider: 'archive.org' });
    }

    if (id.startsWith('tmdb:')) {
      const [, mediaType, tmdbId] = id.split(':');
      const resolved = await tmdbStream(mediaType, tmdbId);
      return json(200, {
        stream_url: resolved.embed_url,
        provider: 'tmdb-trailer',
        title: resolved.title,
        subtitles: [],
      });
    }

    return json(400, { error: `Unrecognised media id: ${id}` });
  } catch (err) {
    console.error(`[get-stream] ${id} failed:`, err.message);
    return json(502, { error: err.message || 'Stream unavailable' });
  }
};