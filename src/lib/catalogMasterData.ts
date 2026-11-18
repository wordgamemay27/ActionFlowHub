// ============================================================================
// CATALOG MASTER DATA — 35 Partner Ufficiali & Inventario Brand/Premi
// ============================================================================

export interface InventoryItem {
  id: string;
  name: string;
  category: string;
  points: string;
  logo: string;
  link: string;
  badge?: string;
  description?: string;
}

export const MASTER_INVENTORY_DATA: {
  brands: InventoryItem[];
  gamingPlaytime: InventoryItem[];
} = {
  brands: [
    {
      id: 'brand-amazon',
      name: 'Amazon Gift Card',
      category: 'Shopping & E-Commerce',
      points: '1000 PT',
      logo: 'https://cdn.simpleicons.org/amazon/FF9900',
      link: 'https://www.amazon.it/',
      badge: 'Tagli €10 - €500',
      description: 'Buoni spesa digitali Amazon spendibili globalmente.',
    },
    {
      id: 'brand-googleplay',
      name: 'Google Play Store',
      category: 'App & Giochi Android',
      points: '500 PT',
      logo: 'https://cdn.simpleicons.org/googleplay/00A0FF',
      link: 'https://play.google.com/',
      badge: 'Tagli €5 - €100',
      description: 'Credito ufficiale Google Play per app, giochi e abbonamenti.',
    },
    {
      id: 'brand-apple',
      name: 'Apple Store & iTunes',
      category: 'Tech & App iOS',
      points: '1500 PT',
      logo: 'https://cdn.simpleicons.org/apple/FFFFFF',
      link: 'https://www.apple.com/it/',
      badge: 'Tagli €15 - €200',
      description: 'Gift Card Apple per App Store, iCloud, Apple Music e dispositivi.',
    },
    {
      id: 'brand-nike',
      name: 'Nike Official Voucher',
      category: 'Sport & Fashion',
      points: '2500 PT',
      logo: 'https://cdn.simpleicons.org/nike/F97316',
      link: 'https://www.nike.com/it/',
      badge: 'Tagli €25 - €150',
      description: 'Gift Card ufficiale Nike Store e app SNKRS.',
    },
    {
      id: 'brand-zalando',
      name: 'Zalando Gift Voucher',
      category: 'Moda & Abbigliamento',
      points: '2500 PT',
      logo: 'https://cdn.simpleicons.org/zalando/FF6900',
      link: 'https://www.zalando.it/',
      badge: 'Tagli €25 - €150',
      description: 'Buoni regalo Zalando per abbigliamento, scarpe e accessori.',
    },
    {
      id: 'brand-starbucks',
      name: 'Starbucks Card',
      category: 'Food & Coffee',
      points: '1000 PT',
      logo: 'https://cdn.simpleicons.org/starbucks/00754A',
      link: 'https://www.starbucks.it/',
      badge: 'Tagli €10 - €50',
      description: 'Carta digitale Starbucks utilizzabile nei punti vendita.',
    },
    {
      id: 'brand-burgerking',
      name: 'Burger King Voucher',
      category: 'Food & Fast Food',
      points: '1000 PT',
      logo: 'https://cdn.simpleicons.org/burgerking/D6231F',
      link: 'https://www.burgerking.it/',
      badge: 'Tagli €10 - €50',
      description: 'Buono digitale Burger King riscattabile in app o cassa.',
    },
    {
      id: 'brand-mcdonalds',
      name: "McDonald's Gift Voucher",
      category: 'Food & Ristorazione',
      points: '1000 PT',
      logo: 'https://cdn.simpleicons.org/mcdonalds/FFC72C',
      link: 'https://www.mcdonalds.it/',
      badge: 'Tagli €10 - €50',
      description: "Voucher digitale per menu e ordini McDonald's.",
    },
    {
      id: 'brand-uber',
      name: 'Uber & Uber Eats',
      category: 'Mobilità & Delivery',
      points: '1500 PT',
      logo: 'https://cdn.simpleicons.org/uber/FFFFFF',
      link: 'https://www.uber.com/it/it/',
      badge: 'Tagli €15 - €100',
      description: 'Credito unico valido sia per corse Uber che consegne Uber Eats.',
    },
    {
      id: 'brand-vodafone',
      name: 'Vodafone Ricarica',
      category: 'Ricariche & Telco',
      points: '1000 PT',
      logo: 'https://cdn.simpleicons.org/vodafone/E60000',
      link: 'https://www.vodafone.it/',
      badge: 'Tagli €10 - €50',
      description: 'Ricarica telefonica immediata Vodafone.',
    },
    {
      id: 'brand-paypal',
      name: 'PayPal Cash Voucher',
      category: 'Pagamenti Digitali',
      points: '2000 PT',
      logo: 'https://cdn.simpleicons.org/paypal/003087',
      link: 'https://www.paypal.com/',
      badge: 'Tagli €20 - €250',
      description: 'Ricarica saldo digitale PayPal.',
    },
    {
      id: 'brand-visa',
      name: 'Visa Prepaid Virtual',
      category: 'Carte Prepagate',
      points: '2500 PT',
      logo: 'https://cdn.simpleicons.org/visa/1A1F71',
      link: 'https://www.redotpay.com/',
      badge: 'Tagli €25 - €500',
      description: 'Carta prepagata virtuale Visa per acquisti online.',
    },
    {
      id: 'brand-mastercard',
      name: 'Mastercard Virtual Card',
      category: 'Carte Prepagate',
      points: '2500 PT',
      logo: 'https://cdn.simpleicons.org/mastercard/EB001B',
      link: 'https://www.bybit.com/en/card',
      badge: 'Tagli €25 - €500',
      description: 'Carta virtuale Mastercard internazionale.',
    },
    {
      id: 'brand-eni',
      name: 'Eni Live Buono Carburante',
      category: 'Carburante & Mobilità',
      points: '2000 PT',
      logo: '',
      link: 'https://www.enilive.com/',
      badge: 'Tagli €20 - €100',
      description: 'Buono carburante digitale Eni Station.',
    },
    {
      id: 'brand-telecomitalia',
      name: 'TIM Ricarica Ufficiale',
      category: 'Ricariche & Telco',
      points: '1000 PT',
      logo: '',
      link: 'https://www.tim.it/',
      badge: 'Tagli €10 - €50',
      description: 'Ricarica immediata credito telefonico TIM.',
    },
  ],
  gamingPlaytime: [
    {
      id: 'brand-steam',
      name: 'Steam Wallet Code',
      category: 'Gaming PC',
      points: '1000 PT',
      logo: 'https://cdn.simpleicons.org/steam/66C0F4',
      link: 'https://store.steampowered.com/',
      badge: 'Tagli €10 - €100',
      description: 'Codice portafoglio Steam per giochi PC e DLC.',
    },
    {
      id: 'brand-playstation',
      name: 'PlayStation Network PSN',
      category: 'Console Gaming',
      points: '1000 PT',
      logo: 'https://cdn.simpleicons.org/playstation/003791',
      link: 'https://store.playstation.com/',
      badge: 'Tagli €10 - €100',
      description: 'Credito PS Store e abbonamento PlayStation Plus.',
    },
    {
      id: 'brand-roblox',
      name: 'Roblox Robux Gift Card',
      category: 'Metaverse & Gaming',
      points: '1000 PT',
      logo: 'https://cdn.simpleicons.org/roblox/E2231C',
      link: 'https://www.roblox.com/',
      badge: '800 - 10.000 Robux',
      description: 'Carta digitale Roblox per Robux ed elementi esclusivi.',
    },
    {
      id: 'brand-epicgames',
      name: 'Epic Games & V-Bucks',
      category: 'Gaming & Battle Royale',
      points: '1000 PT',
      logo: 'https://cdn.simpleicons.org/epicgames/FFFFFF',
      link: 'https://store.epicgames.com/',
      badge: 'Tagli €10 - €100',
      description: 'Saldo Epic Games Store e Fortnite V-Bucks.',
    },
    {
      id: 'brand-pokemon',
      name: 'Pokémon TCG & GO Pass',
      category: 'Gaming Mobile',
      points: '1000 PT',
      logo: 'https://upload.wikimedia.org/wikipedia/commons/9/98/International_Pok%C3%A9mon_logo.svg',
      link: 'https://www.pokemon.com/',
      badge: 'PokéCoins & Pass',
      description: 'Voucher per Pokémon GO e Pokémon TCG Live.',
    },
  ],
};

export const EXTENDED_INVENTORY_DATA: {
  mediaVideo: InventoryItem[];
  taskNetworks: InventoryItem[];
  aiWork: InventoryItem[];
  nftGifts: InventoryItem[];
  airdropEcosystem: InventoryItem[];
} = {
  mediaVideo: [
    {
      id: 'brand-netflix',
      name: 'Netflix Gift Card',
      category: 'Streaming Serie & Film',
      points: '1500 PT',
      logo: 'https://cdn.simpleicons.org/netflix/E50914',
      link: 'https://www.netflix.com/',
      badge: 'Tagli €15 - €100',
      description: 'Abbonamento Netflix senza carta di credito.',
    },
    {
      id: 'brand-spotify',
      name: 'Spotify Premium',
      category: 'Musica & Podcast',
      points: '1000 PT',
      logo: 'https://cdn.simpleicons.org/spotify/1ED760',
      link: 'https://www.spotify.com/',
      badge: '1 - 12 Mesi Premium',
      description: 'Codice prepagato Spotify Premium individuale.',
    },
    {
      id: 'brand-dazn',
      name: 'DAZN Sport Pass',
      category: 'Live Sport Streaming',
      points: '3000 PT',
      logo: 'https://cdn.simpleicons.org/dazn/F8F32B',
      link: 'https://www.dazn.com/',
      badge: 'Pass Mensile / Annuale',
      description: 'Accesso completo a Serie A, calcio e sport live su DAZN.',
    },
    {
      id: 'brand-youtube',
      name: 'YouTube Premium',
      category: 'Video & Music',
      points: '1200 PT',
      logo: 'https://cdn.simpleicons.org/youtube/FF0000',
      link: 'https://www.youtube.com/premium',
      badge: 'Zero Pubblicità',
      description: 'YouTube e YouTube Music senza interruzioni.',
    },
    {
      id: 'brand-tiktok',
      name: 'TikTok Coins Recharge',
      category: 'Social & Creator',
      points: '500 PT',
      logo: 'https://cdn.simpleicons.org/tiktok/69C9D0',
      link: 'https://www.tiktok.com/coin',
      badge: 'Monete Live',
      description: 'Ricarica monete TikTok per regali e creator.',
    },
  ],
  taskNetworks: [
    {
      id: 'brand-discord',
      name: 'Discord Nitro',
      category: 'Community & Gaming',
      points: '1000 PT',
      logo: 'https://cdn.simpleicons.org/discord/5865F2',
      link: 'https://discord.com/nitro',
      badge: 'Nitro / Server Boost',
      description: 'Abbonamento Discord Nitro con streaming HD ed emoji custom.',
    },
    {
      id: 'brand-x',
      name: 'X Premium Verified',
      category: 'Social Network',
      points: '800 PT',
      logo: 'https://cdn.simpleicons.org/x/FFFFFF',
      link: 'https://x.com/',
      badge: 'Badge Blu',
      description: 'Funzionalità X Premium e creator revenue sharing.',
    },
    {
      id: 'brand-instagram',
      name: 'Instagram Meta Verified',
      category: 'Social & Creator',
      points: '1200 PT',
      logo: 'https://cdn.simpleicons.org/instagram/E4405F',
      link: 'https://www.instagram.com/',
      badge: 'Creator Tools',
      description: 'Strumenti promozionali e badge per profili creator.',
    },
    {
      id: 'brand-facebook',
      name: 'Meta Ad & Gaming Credits',
      category: 'Social & Gaming',
      points: '1000 PT',
      logo: 'https://cdn.simpleicons.org/facebook/0866FF',
      link: 'https://www.facebook.com/',
      badge: 'Meta Credits',
      description: 'Crediti per app e giochi dell’ecosistema Meta.',
    },
  ],
  aiWork: [
    {
      id: 'brand-linkedin',
      name: 'LinkedIn Premium Career',
      category: 'Lavoro & AI Learning',
      points: '2500 PT',
      logo: 'https://upload.wikimedia.org/wikipedia/commons/8/81/LinkedIn_icon.svg',
      link: 'https://www.linkedin.com/premium',
      badge: 'LinkedIn Learning',
      description: 'Accesso a corsi AI certificati e strumenti LinkedIn Premium.',
    },
    {
      id: 'brand-vr',
      name: 'VR & Spatial Computing Pass',
      category: 'Realtà Virtuale',
      points: '2000 PT',
      logo: '',
      link: 'https://www.meta.com/quest/',
      badge: 'Esperienze 3D/VR',
      description: 'Crediti per app e contenuti immersivi VR.',
    },
  ],
  nftGifts: [
    {
      id: 'brand-telegram',
      name: 'Telegram Official Ecosystem',
      category: 'Telegram Ecosystem',
      points: '500 PT',
      logo: 'https://cdn.simpleicons.org/telegram/26A5E4',
      link: 'https://fragment.com/',
      badge: 'Telegram Official',
      description: 'Servizi e strumenti ufficiali dell’ecosistema Telegram.',
    },
    {
      id: 'brand-ledger',
      name: 'Ledger Hardware Voucher',
      category: 'Hardware Wallet',
      points: '5000 PT',
      logo: '',
      link: 'https://www.ledger.com/',
      badge: 'Sicurezza Self-Custody',
      description: 'Buono sconto e voucher per hardware wallet Ledger.',
    },
  ],
  airdropEcosystem: [
    {
      id: 'brand-ton',
      name: 'The Open Network (TON)',
      category: 'Blockchain Layer-1',
      points: '500 PT',
      logo: 'https://cdn.simpleicons.org/ton/0098EA',
      link: 'https://ton.org/',
      badge: 'Nativo TON',
      description: 'Token nativo TON prelevabile direttamente su Tonkeeper.',
    },
    {
      id: 'brand-binance',
      name: 'Binance Gift Card & Pay',
      category: 'Crypto Exchange',
      points: '1000 PT',
      logo: 'https://cdn.simpleicons.org/binance/F3BA2F',
      link: 'https://www.binance.com/',
      badge: 'Zero Fee USDT/BNB',
      description: 'Riscatta voucher crypto direttamente con Binance Pay.',
    },
    {
      id: 'brand-coinbase',
      name: 'Coinbase Crypto Voucher',
      category: 'Crypto Exchange',
      points: '1000 PT',
      logo: 'https://cdn.simpleicons.org/coinbase/0052FF',
      link: 'https://www.coinbase.com/',
      badge: 'USDC / Crypto Direct',
      description: 'Voucher e ricariche crypto verificati su ecosistema Coinbase.',
    },
    {
      id: 'brand-bitcoin',
      name: 'Bitcoin (BTC) Lightning Voucher',
      category: 'Crypto Asset',
      points: '2000 PT',
      logo: 'https://cdn.simpleicons.org/bitcoin/F7931A',
      link: 'https://zbd.gg/',
      badge: 'BTC / Lightning',
      description: 'Riscatto voucher e premi tramite rete Bitcoin Lightning.',
    },
    {
      id: 'brand-ethereum',
      name: 'Ethereum (ETH) Web3 Voucher',
      category: 'Crypto Asset',
      points: '2000 PT',
      logo: 'https://cdn.simpleicons.org/ethereum/627EEA',
      link: 'https://ethereum.org/',
      badge: 'ETH / ERC-20',
      description: 'Voucher digitali compatibili con ecosistema Ethereum.',
    },
  ],
};

export interface VideoProviderNode {
  id: string;
  name: string;
  domain: string;
  role: string;
  relayToken: string;
  directUrl: string;
  status: 'ACTIVE' | 'PAUSED';
}

export const VIDEO_INTRO_PROVIDER: VideoProviderNode = {
  id: 'provider-video-intro',
  name: 'ReelShort / Cheelee Direct Video',
  domain: 'reelshort.com',
  role: 'Fornitore video diretto iniziale',
  relayToken: 'node-video-intro',
  directUrl: 'https://www.reelshort.com/',
  status: 'ACTIVE',
};

export interface MailCompartmentNode {
  id: string;
  compartmentNumber: 1 | 2 | 3 | 4 | 5;
  domain: string;
  portalUrl: string;
  relayToken: string;
  scope: string;
  linkedProvidersRange: string;
}

export const MAIL_COMPARTMENTS_REGISTRY: MailCompartmentNode[] = [
  {
    id: 'mail-1',
    compartmentNumber: 1,
    domain: '@mail.com',
    portalUrl: 'https://www.mail.com/',
    relayToken: 'mail-portal-1',
    scope: 'Giochi Case Madri & Telegram TON (Catizen, PlayDeck, Plarium, Wargaming, Gaijin)',
    linkedProvidersRange: 'Giochi & Web3 (Comp. 1)',
  },
  {
    id: 'mail-2',
    compartmentNumber: 2,
    domain: '@gmx.com',
    portalUrl: 'https://www.gmx.com/',
    relayToken: 'mail-portal-2',
    scope: 'Giochi Bitcoin Lightning & Playtest (ZBD, THNDR, Sweat Economy, RollerCoin, Womplay)',
    linkedProvidersRange: 'Giochi Lightning (Comp. 2)',
  },
  {
    id: 'mail-3',
    compartmentNumber: 3,
    domain: '@zohomail.com',
    portalUrl: 'https://www.zoho.com/mail/',
    relayToken: 'mail-portal-3',
    scope: 'Carte Crypto Dirette & Scontrini GEO (Mt Pelerin, Tangem, Bybit Card, RedotPay, WeWard, Macadam)',
    linkedProvidersRange: 'Carte & Scontrini GEO (Comp. 3)',
  },
  {
    id: 'mail-4',
    compartmentNumber: 4,
    domain: '@outlook.com',
    portalUrl: 'https://outlook.live.com/',
    relayToken: 'mail-portal-4',
    scope: 'Lavoro AI Voce/Foto & Test UX/QA (PublicAI, Olas, Braintrust, Sahara AI, HackenProof)',
    linkedProvidersRange: 'AI & UX/QA (Comp. 4)',
  },
  {
    id: 'mail-5',
    compartmentNumber: 5,
    domain: '@proton.me',
    portalUrl: 'https://proton.me/mail',
    relayToken: 'mail-portal-5',
    scope: 'Serie Video, Musica & Nodi Rete DePIN (ReelShort, Cheelee, Audius, Mysterium, Meson, EarnApp)',
    linkedProvidersRange: 'Video, Musica & DePIN (Comp. 5)',
  },
];


