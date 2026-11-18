// ============================================================================
// REAL PHOTOGRAPHIC COVERS & VISUAL ARTWORK
// Sempre immagini fotografiche reali ad alta definizione (mai blocchi solo testo)
// ============================================================================

const REAL_PHOTO_BY_KEYWORD: Array<{ keywords: string[]; url: string }> = [
  {
    keywords: ['redotpay', 'bybit', 'bitget', 'tangem', 'mtpelerin', 'visa', 'mastercard', 'carta', 'card'],
    url: 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?auto=format&fit=crop&w=900&q=80',
  },
  {
    keywords: ['amazon', 'zalando', 'shopping', 'voucher', 'gift', 'carrefour', 'ikea'],
    url: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?auto=format&fit=crop&w=900&q=80',
  },
  {
    keywords: ['steam', 'playstation', 'xbox', 'nintendo', 'roblox', 'epic', 'catizen', 'playdeck', 'zbd', 'game', 'giochi'],
    url: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=900&q=80',
  },
  {
    keywords: ['netflix', 'reelshort', 'dramabox', 'shorttv', 'flextv', 'kalos', 'netshort', 'drama', 'serie', 'cinema', 'youtube', 'tiktok'],
    url: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=900&q=80',
  },
  {
    keywords: ['spotify', 'audius', 'music', 'audio', 'apple', 'slicethepie', 'playlist'],
    url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=900&q=80',
  },
  {
    keywords: ['ston', 'dedust', 'storm', 'evaa', 'ton', 'taskon', 'layer3', 'galxe', 'intract', 'zealy', 'questn', 'jupiter', 'airdrop', 'binance', 'coinbase', 'bitcoin', 'ethereum'],
    url: 'https://images.unsplash.com/photo-1639762681485-074b7f938ba0?auto=format&fit=crop&w=900&q=80',
  },
  {
    keywords: ['pawns', 'honeygain', 'earnapp', 'traff', 'packet', 'repocket', 'theta', 'nodo', 'node', 'depin'],
    url: 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=900&q=80',
  },
  {
    keywords: ['scontrin', 'receipt', 'coinout', 'fetch', 'ibotta', 'roamler', 'bemyeye'],
    url: 'https://images.unsplash.com/photo-1554224155-6726b3ff858f?auto=format&fit=crop&w=900&q=80',
  },
  {
    keywords: ['ai', 'publicai', 'sahara', 'clickworker', 'oneforma', 'appen', 'prolific', 'usertesting', 'userfeel', 'testbirds'],
    url: 'https://images.unsplash.com/photo-1677442136019-21780ecad995?auto=format&fit=crop&w=900&q=80',
  },
  {
    keywords: ['uber', 'mcdonald', 'burger', 'starbucks', 'q8', 'vodafone', 'dazn', 'nike'],
    url: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?auto=format&fit=crop&w=900&q=80',
  },
];

const DEFAULT_FALLBACK_PHOTOS = [
  'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1639762681485-074b7f938ba0?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=900&q=80',
];

export function buildGlassPlaceholderDataUri(
  label = 'ACTIONFLOW',
  _accent = '#0098EA',
  subtitle = ''
): string {
  const combined = `${label} ${subtitle}`.toLowerCase();
  for (const entry of REAL_PHOTO_BY_KEYWORD) {
    if (entry.keywords.some((k) => combined.includes(k))) {
      return entry.url;
    }
  }
  const hash = combined.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return DEFAULT_FALLBACK_PHOTOS[hash % DEFAULT_FALLBACK_PHOTOS.length];
}

export const GLASS_COVER_FAST = '/assets/covers/fast.jpg';
export const GLASS_COVER_MEDIUM = '/assets/covers/medium.jpg';
export const GLASS_COVER_LONG = '/assets/covers/long.jpg';

export const GLASS_STAR_X2 =
  'https://images.unsplash.com/photo-1639762681485-074b7f938ba0?auto=format&fit=crop&w=900&q=80';
export const GLASS_STAR_X3 =
  'https://images.unsplash.com/photo-1621761191319-c6fb62004040?auto=format&fit=crop&w=900&q=80';
export const GLASS_STAR_X4 =
  'https://images.unsplash.com/photo-1518546305927-5a555bb7020d?auto=format&fit=crop&w=900&q=80';

export const DRAMA_POSTER_REELSHORT =
  'https://images.unsplash.com/photo-1536440136628-849c177e76a1?auto=format&fit=crop&w=900&q=80';
export const DRAMA_POSTER_DRAMABOX =
  'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=900&q=80';
export const DRAMA_POSTER_SHORTTV =
  'https://images.unsplash.com/photo-1517604931442-7e0c8ed2963c?auto=format&fit=crop&w=900&q=80';
export const DRAMA_POSTER_FLEXTV =
  'https://images.unsplash.com/photo-1478720568477-152d9b164e26?auto=format&fit=crop&w=900&q=80';
export const DRAMA_POSTER_KALOSTV =
  'https://images.unsplash.com/photo-1574375927938-d5a98e8ffe85?auto=format&fit=crop&w=900&q=80';
export const DRAMA_POSTER_NETSHORT =
  'https://images.unsplash.com/photo-1524985069026-dd778a71c7b4?auto=format&fit=crop&w=900&q=80';
