// ============================================================================
// TIPI CENTRALI - ActionFlow Hub
// ============================================================================

// ----------------------------------------------------------
// Profilo Utente
// ----------------------------------------------------------
export interface UserProfile {
  id: string;
  telegramId: number;
  username: string;
  firstName: string;
  lastName?: string;
  points: number;                    // Saldo prelevabile autorevole (withdrawable_points da PostgreSQL)
  pendingPoints?: number;            // Punti in attesa di settlement reale (USER_*:PENDING)
  settledPoints?: number;            // Punti liquidati non ancora rilasciati (USER_*:SETTLED)
  withdrawablePoints?: number;       // Punti prelevabili subito (USER_*:WITHDRAWABLE)
  reservedPoints?: number;           // Punti riservati per prelievi in corso (USER_*:RESERVED)
  walletAddress: string;             // Indirizzo wallet (TON/Solana/Pi o gateway)
  marketCountry?: string;            // Paese di riferimento (es. IT, DE, US, BR, NG)
  tierZone?: 'ZONE_A' | 'ZONE_B' | 'ZONE_C'; // Fascia economica associata su PostgreSQL
  pppCoefficient?: number;           // Coefficiente PPP Banca Mondiale [0.01..1.0]
  regionGroup?: string;              // Area economica (US, EUROPE, AFRICA, CHINA, INDIA, LATAM, ...)
  payoutSharePercent: number;        // Quota base massima utente (30%)
  completedTasksCount: number;       // Task completati su PostgreSQL
  role?: 'user' | 'admin';           // Ruolo (opzionale)
  referralCode?: string;             // Codice referral (opzionale)
  referredBy?: string;               // Chi ha referenziato (opzionale)
}

// ----------------------------------------------------------
// Transazioni
// ----------------------------------------------------------
export interface Transaction {
  id: string;
  userId: string;
  type: 'TASK_CLAIM' | 'WITHDRAWAL' | 'DEPOSIT' | 'REFERRAL' | 'BONUS' | 'PENALTY' | 'AIRDROP_CLAIM' | 'STARS_PURCHASE' | 'TURBO_ACTIVATION';
  amountPoints: number;
  amountGram: number;
  amountTon: number;
  timestamp: string;
  status: 'PENDING' | 'APPROVED' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'PROCESSING';
  hash: string;
  details?: string;
  recipientWallet?: string;
  requestId?: string;
  cryptoAsset?: 'TON' | 'SOL' | 'PI' | 'USDT' | 'USDC' | 'CASH_PAYEER' | 'CASH_AIRTM' | 'CASH_VOLET';
  cryptoAmount?: number;
}
// ----------------------------------------------------------
// Airdrop / Campagne
// ----------------------------------------------------------
export interface AirdropCampaign {
  id: string;
  title: string;
  description: string;
  officialLogoUrl: string;
  masterRefLink: string;
  monetizationType: 'DIRECT_LISTING' | 'CPA_S2S' | 'REF_SHARE' | 'AD_GATED';
  s2sPostbackUrl: string;
  isCertified: boolean;
  rewardKind: 'AIRDROP' | 'TOKEN' | 'MINING';
  rewardTokenSymbol: string;
  rewardAmount?: number;
  rewardNetwork: string;
  status: 'ACTIVE' | 'PAUSED' | 'ENDED';
  startDate: string;
  endDate?: string;
  maxParticipants?: number;
  currentParticipants: number;
  createdAt: string;
  updatedAt: string;
}

// ----------------------------------------------------------
// Notifiche / Toast
// ----------------------------------------------------------
export interface Toast {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message?: string;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

// ----------------------------------------------------------
// Configurazione Rete Crypto
// ----------------------------------------------------------
export type NetworkKey = 'TON' | 'SOLANA' | 'PI_NETWORK' | 'USDT_TON';

export interface NetworkConfig {
  key: NetworkKey;
  tabLabel: Record<string, string>;
  walletAppName: string;
  walletAppUrl: string;
  addressPlaceholder: Record<string, string>;
  addressHint: Record<string, string>;
  nativeTokenSymbol: string;
  nativeTokenDecimals: number;
  supportedTokens: Array<{
    symbol: string;
    name: string;
    decimals: number;
    contractAddress?: string;
    logoUrl: string;
  }>;
  rpcUrl: string;
  explorerUrl: string;
  chainId?: string;
}

// ----------------------------------------------------------
// Stato Globale App (per context/state management)
// ----------------------------------------------------------
export interface AppState {
  user: UserProfile | null;
  transactions: Transaction[];
  airdrops: AirdropCampaign[];
  isLoading: boolean;
  error: string | null;
  toasts: Toast[];
  currentTab: string;
  sidebarOpen: boolean;
}

export const NETWORK_CONFIGS: Record<NetworkKey, NetworkConfig> = {
  TON: {
    key: 'TON',
    tabLabel: { it: 'Rete TON', en: 'TON Network', es: 'Red TON', fr: 'Réseau TON', de: 'TON-Netzwerk', pt: 'Rede TON' },
    walletAppName: 'Tonkeeper / Telegram Wallet',
    walletAppUrl: 'https://tonkeeper.com',
    addressPlaceholder: { it: 'Incolla il tuo indirizzo Tonkeeper (UQ... o EQ...)', en: 'Paste your Tonkeeper address (UQ... or EQ...)' },
    addressHint: { it: 'Indirizzo Tonkeeper (UQ... o EQ...) sulla Rete TON per ricevere TON o USDT.', en: 'Tonkeeper address (UQ... or EQ...) on TON Network to receive TON or USDT.' },
    nativeTokenSymbol: 'TON',
    nativeTokenDecimals: 9,
    supportedTokens: [
      { symbol: 'TON', name: 'Toncoin', decimals: 9, logoUrl: 'https://cdn.simpleicons.org/ton/0098EA' },
      { symbol: 'USDT', name: 'Tether USD', decimals: 6, contractAddress: 'EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGo24iuB', logoUrl: 'https://cdn.simpleicons.org/tether/26A17B' },
      { symbol: 'GRAM', name: 'Gram', decimals: 9, contractAddress: 'EQD0vdSA_Nedpn9uBGU3lQ4z5841YZT6UJgZfQ6J81KBM', logoUrl: 'https://cdn.simpleicons.org/telegram/26A5E4' },
      { symbol: 'NOT', name: 'Notcoin', decimals: 9, contractAddress: 'EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT', logoUrl: 'https://cdn.simpleicons.org/notcoin/FFD700' },
      { symbol: 'DOGS', name: 'Dogs', decimals: 9, contractAddress: 'EQB2_Jn4kBVCpb9zZI4fJgK6r8X9q8X9q8X9q8X9q8X9q8X9', logoUrl: 'https://cdn.simpleicons.org/dogs/8A2BE2' },
    ],
    rpcUrl: 'https://toncenter.com/api/v2/jsonRPC',
    explorerUrl: 'https://tonscan.org',
    chainId: 'ton',
  },
  SOLANA: {
    key: 'SOLANA',
    tabLabel: { it: 'Rete Solana', en: 'Solana Network' },
    walletAppName: 'Phantom / Solflare',
    walletAppUrl: 'https://phantom.app',
    addressPlaceholder: { it: 'Incolla il tuo indirizzo Solana', en: 'Paste your Solana address' },
    addressHint: { it: 'Indirizzo Solana (Base58) per ricevere SOL, USDC, USDT o BONK.', en: 'Solana address (Base58) to receive SOL, USDC, USDT or BONK.' },
    nativeTokenSymbol: 'SOL',
    nativeTokenDecimals: 9,
    supportedTokens: [
      { symbol: 'SOL', name: 'Solana', decimals: 9, logoUrl: 'https://cdn.simpleicons.org/solana/9945FF' },
      { symbol: 'USDC', name: 'USD Coin', decimals: 6, contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', logoUrl: 'https://cdn.simpleicons.org/usdc/2775CA' },
      { symbol: 'USDT', name: 'Tether USD', decimals: 6, contractAddress: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', logoUrl: 'https://cdn.simpleicons.org/tether/26A17B' },
      { symbol: 'BONK', name: 'Bonk', decimals: 5, contractAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xrnBR75Y6Si33L4', logoUrl: 'https://cdn.simpleicons.org/bonk/8A2BE2' },
    ],
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    explorerUrl: 'https://solscan.io',
    chainId: 'solana',
  },
  PI_NETWORK: {
    key: 'PI_NETWORK',
    tabLabel: { it: 'Pi Network', en: 'Pi Network' },
    walletAppName: 'Pi Wallet',
    walletAppUrl: 'https://minepi.com',
    addressPlaceholder: { it: 'Incolla il tuo indirizzo Pi Wallet pubblico (inizia con G...)', en: 'Paste your public Pi Wallet address (starts with G...)' },
    addressHint: { it: 'Indirizzo Pi Wallet pubblico (inizia con G...) per ricevere Pi Coin (PI).', en: 'Public Pi Wallet address (starts with G...) to receive Pi Coin (PI).' },
    nativeTokenSymbol: 'PI',
    nativeTokenDecimals: 6,
    supportedTokens: [
      { symbol: 'PI', name: 'Pi Coin', decimals: 6, logoUrl: 'https://cdn.simpleicons.org/pinetwork/00C851' },
    ],
    rpcUrl: 'https://api.minepi.com/v2',
    explorerUrl: 'https://explorer.pi.network',
    chainId: 'pi',
  },
  USDT_TON: {
    key: 'USDT_TON',
    tabLabel: { it: 'USDT su TON', en: 'USDT on TON' },
    walletAppName: 'Tonkeeper / Telegram Wallet',
    walletAppUrl: 'https://tonkeeper.com',
    addressPlaceholder: { it: 'Incolla il tuo indirizzo Tonkeeper (UQ... o EQ...)', en: 'Paste your Tonkeeper address (UQ... or EQ...)' },
    addressHint: { it: 'Indirizzo Tonkeeper (UQ... o EQ...) sulla Rete TON per ricevere USDT.', en: 'Tonkeeper address (UQ... or EQ...) on TON Network to receive USDT.' },
    nativeTokenSymbol: 'USDT',
    nativeTokenDecimals: 6,
    supportedTokens: [
      { symbol: 'USDT', name: 'Tether USD', decimals: 6, contractAddress: 'EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGo24iuB', logoUrl: 'https://cdn.simpleicons.org/tether/26A17B' },
    ],
    rpcUrl: 'https://toncenter.com/api/v2/jsonRPC',
    explorerUrl: 'https://tonscan.org',
    chainId: 'ton',
  },
};

export function isValidTonAddress(address: string): boolean {
  if (!address || typeof address !== 'string') return false;
  const trimmed = address.trim();
  return /^(UQ|EQ)[A-Za-z0-9_-]{46}$/.test(trimmed);
}

export function normalizeTonAddress(address: string): string {
  if (!address) return '';
  return address.trim().toUpperCase();
}

export const USER_PAYOUT_SHARE_PERCENT = 30;
export const PLATFORM_RETENTION_PERCENT = 70;
export const POINTS_PER_USDT = 100;
export const USER_POINTS_PER_ONE_USDT_TASK = 30;

export function calculateUserRewardFromGrossUsdt(
  grossUsdt: number,
  pppCoefficient = 1.0
): {
  grossUsdt: number;
  userUsdt: number;
  userPoints: number;
  platformUsdt: number;
} {
  const safeGross = Math.max(0, Number(grossUsdt) || 0);
  const safeCoef = Math.min(1.0, Math.max(0.01, Number(pppCoefficient) || 1.0));
  const userPoints = Math.floor(safeGross * 0.3 * POINTS_PER_USDT * safeCoef);
  const userUsdt = Number((userPoints / POINTS_PER_USDT).toFixed(2));
  const platformUsdt = Number((safeGross - userUsdt).toFixed(2));
  return { grossUsdt: safeGross, userUsdt, userPoints, platformUsdt };
}

export function calculateTonFromLiveRate(
  points: number,
  tonUsdPrice: number | null | undefined
): number | null {
  if (!tonUsdPrice || !Number.isFinite(tonUsdPrice) || tonUsdPrice <= 0) {
    return null;
  }
  const usd = Math.max(0, Number(points) || 0) * 0.01;
  return Number((usd / tonUsdPrice).toFixed(4));
}

export function calculateUsdtEquivalent(points: number): number {
  return Number((points * 0.01).toFixed(2));
}

