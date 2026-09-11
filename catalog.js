// ============================================================
// Wotchly Cinema Catalog — built-in, fully legal content library.
// Public-domain classics and Creative Commons open movies, hosted
// on Internet Archive / Apple / Mux demo CDNs. No external API,
// no credentials, works offline of any third-party service.
// ============================================================

const IA = id => `https://archive.org/services/img/${id}`;

export const CATALOG_ITEMS = [
  // ── Blender Open Movies (CC-BY, animation) ──────────────────
  {
    id: 'sintel',
    title: 'Sintel',
    year: 2010,
    lang: 'English',
    rating: '8.2',
    type: 'movie',
    cat: 'anime',
    cover: IA('Sintel'),
    url: 'https://archive.org/download/Sintel/sintel-2048-stereo_512kb.mp4',
    desc: 'A lonely girl searches for a dragon she once befriended. Blender Foundation open movie.',
  },
  {
    id: 'tears-of-steel',
    title: 'Tears of Steel',
    year: 2012,
    lang: 'English',
    rating: '7.6',
    type: 'movie',
    cat: 'anime',
    cover: IA('tears-of-steel_202504'),
    url: 'https://archive.org/download/tears-of-steel_202504/Tears%20of%20Steel.mp4',
    desc: 'Sci-fi short film shot in Amsterdam, blended with visual effects. CC-BY.',
  },
  {
    id: 'elephants-dream',
    title: 'Elephants Dream',
    year: 2006,
    lang: 'English',
    rating: '7.2',
    type: 'movie',
    cat: 'anime',
    cover: IA('ElephantsDream'),
    url: 'https://archive.org/download/ElephantsDream/ed_hd_512kb.mp4',
    desc: 'The worlds first open movie — two strange characters explore a capricious machine.',
  },
  {
    id: 'sita-sings-the-blues',
    title: 'Sita Sings the Blues',
    year: 2008,
    lang: 'English',
    rating: '8.5',
    type: 'movie',
    cat: 'movie',
    cover: IA('sita-sings-the-blues'),
    url: 'https://archive.org/download/sita-sings-the-blues/sita-sings-the-blues.mp4',
    desc: 'An animated retelling of the Ramayana, told through Annette Hanshaw jazz vocals. CC0.',
  },
  // ── Public-domain classics ──────────────────────────────────
  {
    id: 'nosferatu-1922',
    title: 'Nosferatu (1922)',
    year: 1922,
    lang: 'Silent',
    rating: '7.9',
    type: 'movie',
    cat: 'movie',
    cover: IA('nosferatu_1922'),
    url: 'https://archive.org/download/nosferatu_1922/nosferatu_1922_512kb.mp4',
    desc: 'The original vampire film — F.W. Murnau silent horror masterpiece.',
  },
  {
    id: 'his-girl-friday',
    title: 'His Girl Friday (1940)',
    year: 1940,
    lang: 'English',
    rating: '7.8',
    type: 'movie',
    cat: 'movie',
    cover: IA('HisGirlFriday1940_201309'),
    url: 'https://archive.org/download/HisGirlFriday1940_201309/His%20Girl%20Friday%20-%201940.mp4',
    desc: 'Howard Hawks rapid-fire screwball comedy. Public domain.',
  },
  // ── HLS demo streams (multi-quality, multi-audio) ───────────
  {
    id: 'bipbop-hls',
    title: 'BipBop — Multi-Audio HLS Demo',
    year: 2024,
    lang: 'Multi',
    rating: '—',
    type: 'tv',
    cat: 'tv',
    cover: '',
    gradient: 'linear-gradient(160deg,#00101a 0%,#00304d 55%,#005c8c 100%)',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8',
    desc: 'Apple reference HLS stream — switch audio tracks & subtitles from the language button.',
  },
  {
    id: 'mux-hls',
    title: 'HLS Adaptive Stream Demo',
    year: 2024,
    lang: 'Multi',
    rating: '—',
    type: 'tv',
    cat: 'tv',
    cover: '',
    gradient: 'linear-gradient(160deg,#1a0533 0%,#3d0f6e 55%,#7c1fa3 100%)',
    url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    desc: 'Adaptive-bitrate HLS reference stream for testing sync quality.',
  },
];

const byId = new Map(CATALOG_ITEMS.map(item => [item.id, item]));

const CAT_FILTERS = {
  'trending': () => true,
  'featured': () => true,
  'all': () => true,
  'movie': i => i.cat === 'movie' || i.cat === 'anime',
  'movies': i => i.cat === 'movie' || i.cat === 'anime',
  'anime': i => i.cat === 'anime',
  'tv': i => i.cat === 'tv',
  'hollywood': i => i.cat === 'movie',
  'bollywood': () => true,
  'hindi': () => true,
  'drama': i => i.cat === 'movie',
  'midnight': i => i.id === 'nosferatu-1922',
};

function normalizeTitle(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Fetch catalog items for a category or search query.
 * Same return shape as the old feed fetcher: { items, errorType, status }.
 */
export async function fetchCatalogFeed(category = 'trending', query = '') {
  const q = normalizeTitle(query);
  if (q) {
    const terms = q.split(' ');
    const items = CATALOG_ITEMS.filter(item =>
      terms.every(t => normalizeTitle(`${item.title} ${item.desc} ${item.lang}`).includes(t))
    );
    return { items, errorType: null, status: 200 };
  }
  const filter = CAT_FILTERS[String(category).toLowerCase()] || (() => true);
  return { items: CATALOG_ITEMS.filter(filter), errorType: null, status: 200 };
}

/** Resolve a catalog item to its direct stream URL. Instant + local. */
export async function loadCatalogStream(movieId) {
  const item = byId.get(movieId);
  return item ? item.url : null;
}
