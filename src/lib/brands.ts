// ============================================================================
// MARCHE E TOKEN CERTIFICATI — LOGHI UFFICIALI
// ============================================================================
// Ogni logo e' quello UFFICIALE del brand:
//   - URL ufficiale  : simpleicons CDN o Wikimedia Commons (alta risoluzione)
//   - mirror locale  : /logos/<brand>.svg (copia scaricata dall'URL ufficiale,
//                      serve per le WebView senza accesso a Internet)
// Se un marchio non ha un logo ufficiale disponibile, l'interfaccia usa il
// contenitore segnaposto in vetro: nessuna immagine "quasi ufficiale" o
// inventata viene mostrata.
// ============================================================================

const SIMPLE = (slug: string, color?: string): string =>
  `https://cdn.simpleicons.org/${slug}${color ? `/${color}` : ''}`;

const WIKI = (path: string): string =>
  `https://upload.wikimedia.org/wikipedia/commons/${path}`;

export interface BrandLogoSpec {
  /** Chiave interna (uguale al nome del file mirror in /logos). */
  key: string;
  /** URL ufficiale del logo (SVG/png). */
  url: string;
  /** Nome breve mostrato nel placeholder se il logo non e' disponibile. */
  label: string;
  /** Colore ufficiale usato per il testo/alone quando l'immagine non c'e'. */
  tint: string;
}

type BrandSeed = [key: string, url: string, label: string, tint: string];

const SEEDS: BrandSeed[] = [
  ['amazon', WIKI('a/a9/Amazon_logo.svg'), 'Amazon', '#FF9900'],
  ['netflix', SIMPLE('netflix', 'E50914'), 'Netflix', '#E50914'],
  ['spotify', SIMPLE('spotify', '1ED760'), 'Spotify', '#1ED760'],
  ['ton', SIMPLE('ton', '0098EA'), 'TON', '#0098EA'],
  ['telegram', SIMPLE('telegram', '26A5E4'), 'Telegram', '#26A5E4'],
  ['discord', SIMPLE('discord', '5865F2'), 'Discord', '#5865F2'],
  ['x', SIMPLE('x', 'FFFFFF'), 'X', '#FFFFFF'],
  ['paypal', SIMPLE('paypal', '003087'), 'PayPal', '#003087'],
  ['visa', SIMPLE('visa', '1A1F71'), 'Visa', '#1A1F71'],
  ['mastercard', SIMPLE('mastercard', 'EB001B'), 'Mastercard', '#EB001B'],
  ['steam', SIMPLE('steam', '000000'), 'Steam', '#66C0F4'],
  ['playstation', SIMPLE('playstation', '003791'), 'PlayStation', '#003791'],
  ['nike', SIMPLE('nike', '111111'), 'Nike', '#F97316'],
  ['uber', SIMPLE('uber', '000000'), 'Uber', '#FFFFFF'],
  ['googleplay', SIMPLE('googleplay', '00A0FF'), 'Google Play', '#00A0FF'],
  ['apple', SIMPLE('apple', 'FFFFFF'), 'Apple', '#FFFFFF'],
  ['starbucks', SIMPLE('starbucks', '00754A'), 'Starbucks', '#00754A'],
  ['burgerking', SIMPLE('burgerking', 'D6231F'), 'Burger King', '#D6231F'],
  ['mcdonalds', SIMPLE('mcdonalds', 'FFC72C'), "McDonald's", '#FFC72C'],
  ['pokemon', WIKI('9/98/International_Pok%C3%A9mon_logo.svg'), 'Pokémon', '#EE1515'],
  ['epicgames', SIMPLE('epicgames', '313131'), 'Epic Games', '#313131'],
  ['dazn', SIMPLE('dazn', 'F8F32B'), 'DAZN', '#F8F32B'],
  ['roblox', SIMPLE('roblox', 'E2231C'), 'Roblox', '#E2231C'],
  ['bitcoin', SIMPLE('bitcoin', 'F7931A'), 'Bitcoin', '#F7931A'],
  ['ethereum', SIMPLE('ethereum', '627EEA'), 'Ethereum', '#627EEA'],
  ['tiktok', SIMPLE('tiktok', 'FFFFFF'), 'TikTok', '#69C9D0'],
  ['youtube', SIMPLE('youtube', 'FF0000'), 'YouTube', '#FF0000'],
  ['instagram', SIMPLE('instagram', 'E4405F'), 'Instagram', '#E4405F'],
  ['facebook', SIMPLE('facebook', '0866FF'), 'Facebook', '#0866FF'],
  ['binance', SIMPLE('binance', 'F3BA2F'), 'Binance', '#F3BA2F'],
  ['coinbase', SIMPLE('coinbase', '0052FF'), 'Coinbase', '#0052FF'],
  ['vodafone', SIMPLE('vodafone', 'E60000'), 'Vodafone', '#E60000'],
  ['zalando', SIMPLE('zalando', 'FF6900'), 'Zalando', '#FF6900'],
  ['linkedin', WIKI('8/81/LinkedIn_icon.svg'), 'LinkedIn', '#0A66C2'],
];

export const BRAND_LOGOS: Record<string, BrandLogoSpec> = SEEDS.reduce((acc, [key, url, label, tint]) => {
  acc[key] = { key, url, label, tint };
  return acc;
}, {} as Record<string, BrandLogoSpec>);

/** Marchi senza logo ufficiale disponibile: si usa il segnaposto in vetro. */
export const BRANDS_WITHOUT_OFFICIAL_LOGO = [
  'eni',
  'telecomitalia',
  'vr',
  'ledger',
  'giftcard',
  'metamask',
  'redotpay',
  'tangem',
  'esim',
  'fuel',
  'topup',
];

/** Risolve il logo ufficiale di un marchio (null se non esiste). */
export function resolveBrandLogo(brandKey: string): BrandLogoSpec | null {
  const key = String(brandKey || '').trim().toLowerCase();
  if (!key) return null;
  if (BRAND_LOGOS[key]) return BRAND_LOGOS[key];

  // gli id del catalogo hanno il prefisso "brand-" (es. brand-amazon)
  const stripped = key.replace(/^(brand|shop|giftcard|store)[-_]/, '');
  if (BRAND_LOGOS[stripped]) return BRAND_LOGOS[stripped];

  // prova le parole unite (es. "google-play" -> "googleplay")
  const joined = stripped.replace(/[-_\s]+/g, '');
  if (BRAND_LOGOS[joined]) return BRAND_LOGOS[joined];

  const parts = stripped.split(/[-_\s]+/).filter(Boolean);
  // prefissi via via (es. "brand-nike-zalando" -> "nike")
  for (let i = parts.length; i > 0; i--) {
    const candidate = parts.slice(0, i).join('-');
    if (BRAND_LOGOS[candidate]) return BRAND_LOGOS[candidate];
    const candidateJoined = parts.slice(0, i).join('');
    if (BRAND_LOGOS[candidateJoined]) return BRAND_LOGOS[candidateJoined];
  }
  // suffissi (es. "brand-kfc-starbucks" -> "starbucks")
  for (let i = 0; i < parts.length; i++) {
    const candidate = parts.slice(i).join('-');
    if (BRAND_LOGOS[candidate]) return BRAND_LOGOS[candidate];
    const candidateJoined = parts.slice(i).join('');
    if (BRAND_LOGOS[candidateJoined]) return BRAND_LOGOS[candidateJoined];
  }
  return null;
}
