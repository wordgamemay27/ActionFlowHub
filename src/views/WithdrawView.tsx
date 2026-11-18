// ============================================================================
// WITHDRAW VIEW - Prelievo CASH (USD via Gateway) & CRYPTO (TON/SOL/PI/USDT/USDC)
// Saldi e tassi FX 100% autorevoli da PostgreSQL + /api/fx/rates live.
// ZERO tassi fissi statici su asset volatili, ZERO crediti client-side.
// ============================================================================
import React, { useState, useEffect, useCallback } from 'react';
import {
  ArrowLeft,
  Send,
  Loader2,
  ClipboardPaste as Paste,
  Banknote,
  Wallet,
  ExternalLink,
  ShieldCheck,
  CheckCircle2,
  RefreshCw,
} from 'lucide-react';
import { CleanAdSlot } from '../components/CleanAdSlot';
import { UserProfile, Transaction } from '../types';
import { calculateTonFromLiveRate } from '../services/api';
import { openTrackedLink } from '../lib/affiliate';
import { useTranslation } from '../lib/i18n';
import { EXTRA_UI_LOCALIZATION } from '../lib/providerLocalization';
import { resolveCountryEconomicProfile } from '../lib/geoEconomics';

export interface WithdrawalResult {
  ok: boolean;
  error?: string;
  strikeRecord?: {
    count?: number;
    is_blocked?: boolean;
    last_reason?: string;
  };
}

interface WithdrawViewProps {
  user: UserProfile;
  transactions: Transaction[];
  onRequestWithdrawal: (points: number, wallet: string, asset?: string) => Promise<WithdrawalResult>;
  onNavigateHome: () => void;
}

type PayoutMode = 'CASH_LOCAL' | 'CRYPTO_DIRECT';
type SupportedCryptoSymbol = 'TON' | 'SOL' | 'PI' | 'USDT' | 'USDC';

interface FxRatesState {
  loading: boolean;
  TON: number | null;
  SOL: number | null;
  PI: number | null;
  USDT: number | null;
  USDC: number | null;
  source: string | null;
  quotedAt: string | null;
  error: string | null;
}

const LOCAL_CASH_GATEWAYS = [
  {
    key: 'AIRTM' as const,
    tabLabel: 'Airtm (Cash 190+)',
    gatewayName: 'Airtm Global Cash-Out',
    signupUrl: 'https://app.airtm.com/signup',
    supportedLocalMethods:
      'WeChat Pay, Alipay • Vodafone Cash, InstaPay • CIH Bank, Cash Plus, Inwi Money • BaridiMob CCP • bKash, Nagad • Euro SEPA, Revolut, Postepay, Pix, MoneyGram',
    inputLabel: 'Airtm Email / Username',
    placeholder: 'email@example.com',
    hint: 'USDC/USD -> Local Currency (EUR, USD, CNY, MAD, DZD, EGP, BDT, BRL)',
    prefixTag: 'CASH-AIRTM:',
  },
  {
    key: 'PAYEER' as const,
    tabLabel: 'Payeer (USD / EUR)',
    gatewayName: 'Payeer Multi-Currency (USD / EUR)',
    signupUrl: 'https://payeer.com/en/auth/?register=yes',
    supportedLocalMethods:
      'Instant USD/EUR • Visa/Mastercard, Local Bank & Mobile Money',
    inputLabel: 'Payeer Account (P...)',
    placeholder: 'P108459201',
    hint: 'Direct USD/EUR credit to your Payeer account (P12345678).',
    prefixTag: 'CASH-PAYEER:',
  },
  {
    key: 'VOLET' as const,
    tabLabel: 'Volet / AdvCash',
    gatewayName: 'Volet.com (AdvCash) Global Cash',
    signupUrl: 'https://volet.com/',
    supportedLocalMethods:
      'Visa/Mastercard, Local Bank Transfer, Mobile Money',
    inputLabel: 'Volet Account Email',
    placeholder: 'user@example.com',
    hint: 'Direct USD/EUR cash balance on Volet.',
    prefixTag: 'CASH-VOLET:',
  },
];

const CRYPTO_NETWORKS = [
  {
    key: 'TON' as const,
    tabLabel: 'TON Network',
    walletAppName: 'Tonkeeper / Telegram Wallet',
    walletAppUrl: 'https://tonkeeper.com',
    addressPlaceholder: {
      it: 'Incolla il tuo indirizzo Tonkeeper (UQ... o EQ...)',
      en: 'Paste your Tonkeeper address (UQ... or EQ...)',
    },
    addressHint: {
      it: 'Indirizzo Tonkeeper (UQ... o EQ...) sulla Rete TON (48 caratteri base64url).',
      en: 'Tonkeeper address (UQ... or EQ...) on TON Network (48 chars base64url).',
    },
    network: 'TON' as const,
    nativeTokenSymbol: 'TON' as SupportedCryptoSymbol,
    nativeTokenDecimals: 9,
  },
  {
    key: 'SOLANA' as const,
    tabLabel: 'Solana (SOL)',
    walletAppName: 'Phantom / Trust Wallet',
    walletAppUrl: 'https://phantom.app',
    addressPlaceholder: {
      it: 'Incolla il tuo indirizzo Solana (Phantom / Solflare)',
      en: 'Paste your Solana address (Phantom / Solflare)',
    },
    addressHint: {
      it: 'Indirizzo Solana Base58 (32–44 caratteri).',
      en: 'Solana Base58 address (32–44 chars).',
    },
    network: 'SOLANA' as const,
    nativeTokenSymbol: 'SOL' as SupportedCryptoSymbol,
    nativeTokenDecimals: 9,
  },
  {
    key: 'PI_NETWORK' as const,
    tabLabel: 'Pi Network',
    walletAppName: 'Pi Wallet',
    walletAppUrl: 'https://minepi.com',
    addressPlaceholder: {
      it: 'Incolla il tuo indirizzo Pi Wallet pubblico (inizia con G...)',
      en: 'Paste your public Pi Wallet address (starts with G...)',
    },
    addressHint: {
      it: 'Indirizzo Pi Wallet Stellar pubblico (G... 56 caratteri).',
      en: 'Public Pi Wallet address (starts with G..., 56 chars).',
    },
    network: 'PI_NETWORK' as const,
    nativeTokenSymbol: 'PI' as SupportedCryptoSymbol,
    nativeTokenDecimals: 6,
  },
  {
    key: 'USDT' as const,
    tabLabel: 'USDT (TON / SOL)',
    walletAppName: 'Tonkeeper / Phantom (USDT)',
    walletAppUrl: 'https://tonkeeper.com',
    addressPlaceholder: {
      it: 'Incolla indirizzo TON (UQ.../EQ...) o Solana Base58',
      en: 'Paste TON (UQ.../EQ...) or Solana Base58 address',
    },
    addressHint: {
      it: 'Stablecoin 1:1 USD su rete TON (UQ.../EQ...) o Solana Base58.',
      en: '1:1 USD stablecoin on TON (UQ.../EQ...) or Solana Base58.',
    },
    network: 'USDT' as const,
    nativeTokenSymbol: 'USDT' as SupportedCryptoSymbol,
    nativeTokenDecimals: 6,
  },
  {
    key: 'USDC' as const,
    tabLabel: 'USDC (SOL / TON)',
    walletAppName: 'Phantom / Tonkeeper (USDC)',
    walletAppUrl: 'https://phantom.app',
    addressPlaceholder: {
      it: 'Incolla indirizzo Solana Base58 o TON (UQ.../EQ...)',
      en: 'Paste Solana Base58 or TON (UQ.../EQ...) address',
    },
    addressHint: {
      it: 'Stablecoin 1:1 USD su rete Solana Base58 o TON (UQ.../EQ...).',
      en: '1:1 USD stablecoin on Solana Base58 or TON (UQ.../EQ...).',
    },
    network: 'USDC' as const,
    nativeTokenSymbol: 'USDC' as SupportedCryptoSymbol,
    nativeTokenDecimals: 6,
  },
];

export const WithdrawView: React.FC<WithdrawViewProps> = ({
  user,
  transactions,
  onRequestWithdrawal,
  onNavigateHome,
}) => {
  const { t, lang } = useTranslation();
  const extra = EXTRA_UI_LOCALIZATION[lang] || EXTRA_UI_LOCALIZATION.en;
  const [payoutMode, setPayoutMode] = useState<PayoutMode>('CASH_LOCAL');
  const [activeCashGateway, setActiveCashGateway] = useState<0 | 1 | 2>(0);
  const [activeNetwork, setActiveNetwork] = useState<number>(0);
  const [walletAddress, setWalletAddress] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [acceptedLegalDisclaimer, setAcceptedLegalDisclaimer] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [fxRates, setFxRates] = useState<FxRatesState>({
    loading: true,
    TON: null,
    SOL: null,
    PI: null,
    USDT: 1.0,
    USDC: 1.0,
    source: null,
    quotedAt: null,
    error: null,
  });

  const network = CRYPTO_NETWORKS[activeNetwork] || CRYPTO_NETWORKS[0];
  const cashGateway = LOCAL_CASH_GATEWAYS[activeCashGateway] || LOCAL_CASH_GATEWAYS[0];

  const userProfile = resolveCountryEconomicProfile(user.marketCountry || 'OTHER');
  const pppCoef = user.pppCoefficient ?? userProfile.pppCoefficient;
  const withdrawablePoints = user.withdrawablePoints ?? user.points;
  const pendingPoints = user.pendingPoints ?? 0;
  const settledPoints = user.settledPoints ?? 0;
  const reservedPoints = user.reservedPoints ?? 0;

  // Scala unica nel Wallet: 100 PT = $1.00 USD (Minimo prelievo: 500 PT = $5.00)
  const usdEquivalent = (pts: number) => (pts * 0.01).toFixed(2);

  const loadLiveFxRates = useCallback(async () => {
    setFxRates((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await fetch('/api/fx/rates');
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok || !data?.rates) {
        setFxRates({
          loading: false,
          TON: null,
          SOL: null,
          PI: null,
          USDT: typeof data?.rates?.USDT === 'number' && data.rates.USDT > 0 ? data.rates.USDT : 1.0,
          USDC: typeof data?.rates?.USDC === 'number' && data.rates.USDC > 0 ? data.rates.USDC : 1.0,
          source: null,
          quotedAt: null,
          error: data?.error || `FX_UNAVAILABLE (${res.status})`,
        });
        return;
      }
      setFxRates({
        loading: false,
        TON: typeof data.rates.TON === 'number' && data.rates.TON > 0 ? data.rates.TON : null,
        SOL: typeof data.rates.SOL === 'number' && data.rates.SOL > 0 ? data.rates.SOL : null,
        PI: typeof data.rates.PI === 'number' && data.rates.PI > 0 ? data.rates.PI : null,
        USDT: typeof data.rates.USDT === 'number' && data.rates.USDT > 0 ? data.rates.USDT : 1.0,
        USDC: typeof data.rates.USDC === 'number' && data.rates.USDC > 0 ? data.rates.USDC : 1.0,
        source: data.source || null,
        quotedAt: data.quotedAt || null,
        error: null,
      });
    } catch {
      setFxRates((prev) => ({
        ...prev,
        loading: false,
        TON: null,
        SOL: null,
        PI: null,
        USDT: 1.0,
        USDC: 1.0,
        error: 'FX_NETWORK_ERROR',
      }));
    }
  }, []);

  useEffect(() => {
    void loadLiveFxRates();
  }, [loadLiveFxRates]);

  const computeLiveCryptoEstimate = (pts: number, symbol: SupportedCryptoSymbol): number | null => {
    if (symbol === 'TON') return calculateTonFromLiveRate(pts, fxRates.TON);
    const rate =
      symbol === 'SOL'
        ? fxRates.SOL
        : symbol === 'PI'
        ? fxRates.PI
        : symbol === 'USDT'
        ? fxRates.USDT ?? 1.0
        : fxRates.USDC ?? 1.0;
    if (!rate || !Number.isFinite(rate) || rate <= 0) return null;
    return Number(((Math.max(0, pts) * 0.01) / rate).toFixed(4));
  };

  const selectedSymbol = network.nativeTokenSymbol;
  const currentLiveAssetRate =
    selectedSymbol === 'TON'
      ? fxRates.TON
      : selectedSymbol === 'SOL'
      ? fxRates.SOL
      : selectedSymbol === 'PI'
      ? fxRates.PI
      : selectedSymbol === 'USDT'
      ? fxRates.USDT ?? 1.0
      : fxRates.USDC ?? 1.0;

  const isStableAsset = selectedSymbol === 'USDT' || selectedSymbol === 'USDC';

  const handlePayout = async () => {
    const cleanTarget = walletAddress.trim();
    if (!cleanTarget) {
      setError(
        payoutMode === 'CASH_LOCAL'
          ? `${cashGateway.gatewayName}: ${cashGateway.inputLabel}`
          : 'Wallet address required'
      );
      return;
    }

    if (!acceptedLegalDisclaimer) {
      setError('Conferma la policy 3-Strike & Tax Autonomy prima di inviare.');
      return;
    }

    if (payoutMode === 'CRYPTO_DIRECT') {
      const isValidTonAddr = /^(UQ|EQ)[A-Za-z0-9_-]{46}$/.test(cleanTarget);
      const isValidSolAddr = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cleanTarget);
      const isValidPiAddr = /^G[A-Z2-7]{55}$/.test(cleanTarget);

      if (selectedSymbol === 'TON' && !isValidTonAddr) {
        setError('Indirizzo TON non valido (deve iniziare con UQ... o EQ..., 48 caratteri).');
        return;
      }
      if (selectedSymbol === 'SOL' && !isValidSolAddr) {
        setError('Indirizzo Solana Base58 non valido (32–44 caratteri).');
        return;
      }
      if (selectedSymbol === 'PI' && !isValidPiAddr) {
        setError('Indirizzo Pi Wallet pubblico non valido (G... 56 caratteri).');
        return;
      }
      if (isStableAsset && !isValidTonAddr && !isValidSolAddr) {
        setError(
          `Indirizzo ${selectedSymbol} non valido: usa un indirizzo TON (UQ.../EQ...) o Solana Base58.`
        );
        return;
      }
      if (!isStableAsset && !currentLiveAssetRate) {
        setError(
          `Quotazione FX live per ${selectedSymbol} non disponibile: usa CASH Locale, USDT/USDC o aggiorna i tassi.`
        );
        return;
      }
    } else {
      if (cashGateway.key === 'PAYEER' && !/^P\d{6,15}$/i.test(cleanTarget)) {
        setError('ID Payeer non valido (es. P108459201)');
        return;
      }
      if (cashGateway.key === 'AIRTM' || cashGateway.key === 'VOLET') {
        const emailLike = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(cleanTarget);
        const usernameLike = /^[a-z0-9._-]{3,32}$/i.test(cleanTarget);
        if (!emailLike && !usernameLike) {
          setError(`Account ${cashGateway.gatewayName} non valido (email o username)`);
          return;
        }
      }
    }

    const points = withdrawAmount.trim() === '' ? 500 : Math.floor(Number(withdrawAmount));
    if (!Number.isFinite(points) || points < 500) {
      setError(`${t.ui.minWithdrawLabel} (500 PT = $5.00 USD)`);
      return;
    }
    if (points > withdrawablePoints) {
      setError(
        `Saldo prelevabile insufficiente (${withdrawablePoints.toLocaleString()} PT disponibili su PostgreSQL).`
      );
      return;
    }

    setIsLoading(true);
    setError(null);

    const formattedRecipient =
      payoutMode === 'CASH_LOCAL'
        ? `${cashGateway.prefixTag}${cleanTarget}`
        : cleanTarget;

    const chosenAsset =
      payoutMode === 'CASH_LOCAL'
        ? `CASH_${cashGateway.key}`
        : network.nativeTokenSymbol;

    try {
      const result = await onRequestWithdrawal(points, formattedRecipient, chosenAsset);
      if (result.ok) {
        const liveEst = computeLiveCryptoEstimate(points, selectedSymbol);
        setSuccess(
          payoutMode === 'CASH_LOCAL'
            ? `$${usdEquivalent(points)} (${points} PT) -> ${cashGateway.gatewayName}`
            : `${points} PT ($${usdEquivalent(points)} ≈ ${liveEst !== null ? liveEst : '?'} ${selectedSymbol})`
        );
        setWalletAddress('');
        setWithdrawAmount('');
        setTimeout(() => setSuccess(null), 5000);
      } else {
        setError(result.error || 'Richiesta rifiutata dal server PostgreSQL.');
      }
    } catch (e: any) {
      setError(e?.message || 'Errore di rete durante la richiesta di prelievo.');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePaste = () => {
    navigator.clipboard
      .readText()
      .then((text) => {
        setWalletAddress(text.trim());
        setError(null);
      })
      .catch(() => {});
  };

  const formatAddress = (address: string): string => {
    const clean = address.trim();
    if (clean.startsWith('CASH-')) {
      return clean.replace('CASH-', '💵 ');
    }
    if (clean.length > 14) {
      return `${clean.slice(0, 6)}...${clean.slice(-6)}`;
    }
    return clean;
  };

  const previewPts = Math.max(0, Math.floor(Number(withdrawAmount) || 500));
  const previewCryptoAmt = computeLiveCryptoEstimate(previewPts, selectedSymbol);
  const walletTonEst = calculateTonFromLiveRate(withdrawablePoints, fxRates.TON);

  return (
    <div className="w-full max-w-2xl mx-auto space-y-3.5 pb-14 animate-fade-in select-none">
      <CleanAdSlot page="wallet" placement="WALLET_TOP" telegramUserId={user?.telegramId} />

      <div className="flex items-center justify-between gap-3 px-1 py-1">
        <button
          type="button"
          onClick={onNavigateHome}
          className="p-2.5 rounded-xl bg-[#0098EA] text-white hover:bg-cyan-400 hover:text-slate-950 border-0 cursor-pointer active:scale-95 transition-all flex items-center justify-center shrink-0 shadow-md"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-black text-white">{t.ui.withdrawTitle}</h2>
          <div className="text-xs text-emerald-300 font-bold flex flex-wrap items-center gap-1.5">
            <span>{t.ui.withdrawSubtitle}</span>
            <span className="px-1.5 py-0.5 rounded bg-sky-500/20 border border-sky-400/35 text-[10px] font-mono text-sky-200">
              {user.marketCountry || 'OTHER'} • {user.tierZone || userProfile.tierZone} • PPP x{pppCoef.toFixed(4)}
            </span>
          </div>
        </div>
        <span
          className="px-2.5 py-1.5 rounded-xl bg-emerald-500/20 border border-emerald-400/40 font-mono text-[11px] font-black text-emerald-300 shrink-0"
          title="Conversione prelievi 100 PT = $1.00 USD invariata rispetto al PPP"
        >
          100 PT = $1.00
        </span>
      </div>

      {/* 4 STATI REALI POSTGRESQL DEL SALDO */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="rounded-2xl bg-gradient-to-r from-emerald-500/20 to-teal-500/20 p-3 border border-emerald-500/35 text-center">
          <div className="text-[10px] font-mono text-emerald-300/90 uppercase tracking-wider">
            {t.ui.availablePointsLabel}
          </div>
          <div className="text-lg sm:text-xl font-black text-amber-400 tabular-nums">
            {withdrawablePoints.toLocaleString()} PT
          </div>
          <div className="text-[10px] font-bold text-emerald-300">
            ≈ ${usdEquivalent(withdrawablePoints)}
          </div>
        </div>

        <div className="rounded-2xl bg-[#0B1426] p-3 border border-amber-400/30 text-center">
          <div className="text-[10px] font-mono text-amber-300/80 uppercase tracking-wider">
            In Attesa S2S
          </div>
          <div className="text-lg sm:text-xl font-black text-amber-300 tabular-nums">
            {pendingPoints.toLocaleString()} PT
          </div>
          <div className="text-[10px] text-slate-400">Conferma Partner</div>
        </div>

        <div className="rounded-2xl bg-[#0B1426] p-3 border border-sky-400/30 text-center">
          <div className="text-[10px] font-mono text-sky-300/80 uppercase tracking-wider">
            Liquidati
          </div>
          <div className="text-lg sm:text-xl font-black text-sky-300 tabular-nums">
            {settledPoints.toLocaleString()} PT
          </div>
          <div className="text-[10px] text-slate-400">Rilascio Cassa</div>
        </div>

        <div className="rounded-2xl bg-[#0B1426] p-3 border border-purple-400/30 text-center">
          <div className="text-[10px] font-mono text-purple-300/80 uppercase tracking-wider">
            Riservati / FX TON
          </div>
          <div className="text-lg sm:text-xl font-black text-white tabular-nums">
            {reservedPoints.toLocaleString()} PT
          </div>
          <div className="text-[10px] text-amber-300/90 flex items-center justify-center gap-1">
            <span>
              {fxRates.loading
                ? 'FX Live...'
                : walletTonEst !== null
                ? `${walletTonEst.toFixed(4)} TON ($${fxRates.TON?.toFixed(2)})`
                : 'FX TON N/D'}
            </span>
            <button
              type="button"
              onClick={() => void loadLiveFxRates()}
              className="text-sky-300 hover:text-white cursor-pointer"
              title="Aggiorna tassi FX live"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      {/* SELETTORE PRINCIPALE: 1. CONTANTI VALUTA LOCALE (CASH) vs 2. CRYPTO DIRETTA */}
      <div className="grid grid-cols-2 gap-2.5 p-1.5 rounded-2xl bg-[#0A1220] border border-sky-500/20">
        <button
          type="button"
          onClick={() => {
            setPayoutMode('CASH_LOCAL');
            setWalletAddress('');
            setError(null);
          }}
          className={`py-3 px-3 rounded-xl flex flex-col items-center justify-center gap-1 transition-all cursor-pointer border-0 ${
            payoutMode === 'CASH_LOCAL'
              ? 'bg-gradient-to-r from-emerald-400 via-green-400 to-teal-400 text-slate-950 shadow-[0_0_20px_rgba(16,185,129,0.4)]'
              : 'bg-[#131F3A]/80 text-slate-300 hover:bg-[#192848]'
          }`}
        >
          <div className="flex items-center gap-1.5 font-black text-xs sm:text-sm uppercase">
            <Banknote className="w-4 h-4 shrink-0" />
            <span>{t.ui.cashLocalTab}</span>
          </div>
          <span className={`text-[10px] font-bold ${payoutMode === 'CASH_LOCAL' ? 'text-slate-900' : 'text-emerald-300/80'}`}>
            Gateway USD (Airtm / Payeer / Volet)
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            setPayoutMode('CRYPTO_DIRECT');
            setWalletAddress('');
            setError(null);
          }}
          className={`py-3 px-3 rounded-xl flex flex-col items-center justify-center gap-1 transition-all cursor-pointer border-0 ${
            payoutMode === 'CRYPTO_DIRECT'
              ? 'bg-gradient-to-r from-sky-400 via-cyan-300 to-blue-400 text-slate-950 shadow-[0_0_20px_rgba(56,189,248,0.4)]'
              : 'bg-[#131F3A]/80 text-slate-300 hover:bg-[#192848]'
          }`}
        >
          <div className="flex items-center gap-1.5 font-black text-xs sm:text-sm uppercase">
            <Wallet className="w-4 h-4 shrink-0" />
            <span>{t.ui.cryptoWalletTab}</span>
          </div>
          <span className={`text-[10px] font-bold ${payoutMode === 'CRYPTO_DIRECT' ? 'text-slate-900' : 'text-sky-300/80'}`}>
            TON, SOL, PI, USDT, USDC
          </span>
        </button>
      </div>

      {/* MODALITÀ 1: CONTANTI IN VALUTA LOCALE (190+ PAESI) */}
      {payoutMode === 'CASH_LOCAL' && (
        <div className="rounded-2xl bg-[#0A1220] border border-emerald-500/30 p-3.5 space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {LOCAL_CASH_GATEWAYS.map((gw, idx) => (
              <button
                key={gw.key}
                type="button"
                onClick={() => {
                  setActiveCashGateway(idx as 0 | 1 | 2);
                  setWalletAddress('');
                  setError(null);
                }}
                className={`py-2 px-2 rounded-xl text-xs font-black uppercase tracking-wider border cursor-pointer transition-all ${
                  activeCashGateway === idx
                    ? 'bg-emerald-500/25 border-emerald-400 text-emerald-200 shadow-md'
                    : 'bg-[#131F3A]/80 border-sky-500/15 text-slate-300 hover:bg-[#192848]'
                }`}
              >
                {gw.tabLabel}
              </button>
            ))}
          </div>

          <div className="rounded-xl bg-[#0E1A2F] border border-emerald-500/20 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-black text-white">{cashGateway.gatewayName}</span>
              <button
                type="button"
                onClick={() =>
                  openTrackedLink(cashGateway.signupUrl, {
                    partnerId: `withdraw_cash_${cashGateway.key.toLowerCase()}`,
                    taskId: `signup_${cashGateway.key.toLowerCase()}`,
                    activityCategory: 'ADS',
                    telegramId: user.telegramId,
                    kind: 'SIGNUP',
                  })
                }
                className="px-2.5 py-1 rounded-lg bg-gradient-to-r from-emerald-400 to-teal-400 text-slate-950 font-black text-[11px] uppercase flex items-center gap-1 cursor-pointer border-0 active:scale-95"
              >
                <span>{t.ui.openFreeCashAccountBtn}</span>
                <ExternalLink className="w-3 h-3" />
              </button>
            </div>
            <div className="text-[11px] text-emerald-300/90 leading-relaxed">
              <strong>{t.ui.whereToCashOutLabel}</strong> {cashGateway.supportedLocalMethods}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-bold uppercase tracking-wider text-emerald-300">
              {cashGateway.inputLabel}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={walletAddress}
                onChange={(e) => {
                  setWalletAddress(e.target.value);
                  setError(null);
                }}
                placeholder={cashGateway.placeholder}
                className="flex-1 px-3 py-2.5 rounded-xl bg-[#060B14] border border-emerald-400/30 text-white text-sm font-mono placeholder-slate-500 focus:outline-none focus:border-emerald-400"
              />
              <button
                type="button"
                onClick={handlePaste}
                className="px-3 py-2.5 rounded-xl bg-gradient-to-r from-emerald-400 to-teal-400 text-slate-950 font-mono text-xs font-black uppercase cursor-pointer active:scale-95 border-0 shadow-lg flex items-center"
              >
                <Paste className="w-4 h-4 mr-1" />
                <span>{t.ui.pasteBtn}</span>
              </button>
            </div>
            <p className="text-[10px] text-slate-400 leading-snug">{cashGateway.hint}</p>
          </div>
        </div>
      )}

      {/* MODALITÀ 2: CRYPTO DIRETTA (TON, SOLANA, PI, USDT, USDC) */}
      {payoutMode === 'CRYPTO_DIRECT' && (
        <div className="rounded-2xl bg-[#0A1220] border border-sky-500/30 p-3.5 space-y-3">
          <div className="flex justify-between items-center gap-2 flex-wrap">
            <div className="flex gap-2 overflow-x-auto no-scrollbar">
              {CRYPTO_NETWORKS.map((net, idx) => (
                <button
                  key={net.key}
                  type="button"
                  onClick={() => {
                    setActiveNetwork(idx);
                    setWalletAddress('');
                    setError(null);
                  }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-black uppercase tracking-wider shrink-0 border-0 cursor-pointer ${
                    activeNetwork === idx
                      ? 'bg-gradient-to-r from-sky-400 via-cyan-300 to-blue-400 text-slate-950 shadow-lg'
                      : 'bg-[#131F3A]/90 text-slate-300 hover:bg-[#192848]'
                  }`}
                >
                  {net.tabLabel}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() =>
                  openTrackedLink('https://www.bybit.com/invite', {
                    partnerId: `withdraw_exchange_${network.key.toLowerCase()}`,
                    taskId: `signup_exchange_${network.key.toLowerCase()}`,
                    activityCategory: 'ADS',
                    telegramId: user.telegramId,
                    kind: 'SIGNUP',
                  })
                }
                className="px-2.5 py-1.5 rounded-xl bg-emerald-500/20 border border-emerald-400/40 text-emerald-300 font-black text-[10px] uppercase shrink-0 flex items-center gap-1 cursor-pointer active:scale-95"
              >
                <span>1. Bybit / Exchange</span>
                <ExternalLink className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() =>
                  openTrackedLink(network.walletAppUrl, {
                    partnerId: `withdraw_wallet_${network.key.toLowerCase()}`,
                    taskId: `signup_wallet_${network.key.toLowerCase()}`,
                    activityCategory: 'ADS',
                    telegramId: user.telegramId,
                    kind: 'SIGNUP',
                  })
                }
                className="px-2.5 py-1.5 rounded-xl bg-sky-500/20 border border-sky-400/30 text-sky-300 font-black text-[10px] uppercase shrink-0 flex items-center gap-1 cursor-pointer active:scale-95"
              >
                <span>Wallet {network.walletAppName.split(' ')[0]}</span>
                <ExternalLink className="w-3 h-3" />
              </button>
            </div>
          </div>

          <div className="rounded-xl bg-[#071022] border border-sky-400/20 px-3 py-2 flex items-center justify-between text-[11px] font-mono">
            <span className="text-sky-300">
              FX {selectedSymbol}/USD:{' '}
              <strong className="text-white">
                {currentLiveAssetRate
                  ? `$${currentLiveAssetRate.toFixed(4)}`
                  : 'N/D — Quote live non disponibile'}
              </strong>
            </span>
            <span className="text-slate-400">
              {isStableAsset
                ? fxRates.source || 'USD_PARITY'
                : fxRates.source
                ? `${fxRates.source}`
                : fxRates.error || 'Offline'}
            </span>
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-bold uppercase tracking-wider text-sky-300/80">
              {t.ui.walletAddressLabel} ({network.nativeTokenSymbol})
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={walletAddress}
                onChange={(e) => {
                  setWalletAddress(e.target.value);
                  setError(null);
                }}
                placeholder={lang === 'it' ? network.addressPlaceholder.it : network.addressPlaceholder.en}
                className="flex-1 px-3 py-2.5 rounded-xl bg-[#060B14] border border-sky-400/20 text-white text-sm font-mono placeholder-slate-500 focus:outline-none focus:border-sky-400"
              />
              <button
                type="button"
                onClick={handlePaste}
                className="px-3 py-2.5 rounded-xl bg-gradient-to-r from-sky-500 to-cyan-500 text-slate-950 font-mono text-xs font-black uppercase cursor-pointer active:scale-95 border-0 shadow-lg flex items-center"
              >
                <Paste className="w-4 h-4 mr-1" />
                <span>{t.ui.pasteBtn}</span>
              </button>
            </div>
            {network.addressHint && (
              <p className="text-[10px] text-slate-400 leading-snug">
                {lang === 'it' ? network.addressHint.it : network.addressHint.en}
              </p>
            )}
          </div>
        </div>
      )}

      {/* SELEZIONE IMPORTO PUNTI */}
      <div className="space-y-2 rounded-2xl bg-[#0A1220] border border-sky-500/15 p-3.5">
        <div className="flex items-center justify-between text-sm">
          <span className="font-black text-white">{t.ui.amountToCashOutLabel}</span>
          <span className="text-xs font-black text-amber-400">
            {t.ui.availableLabel}: {withdrawablePoints.toLocaleString()} PT
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={500}
            max={withdrawablePoints}
            value={withdrawAmount}
            placeholder="500"
            onChange={(e) => {
              setWithdrawAmount(e.target.value);
              setError(null);
            }}
            className="flex-1 px-3 py-2 bg-[#171b20] border border-sky-400/20 rounded-xl text-sm font-black text-white focus:outline-none focus:border-sky-400"
          />
          <span className="text-xs font-mono font-bold text-emerald-300">
            ≈ ${usdEquivalent(previewPts)}{' '}
            {payoutMode === 'CASH_LOCAL'
              ? 'CASH'
              : previewCryptoAmt !== null
              ? `(${previewCryptoAmt.toFixed(4)} ${selectedSymbol})`
              : `(${selectedSymbol} FX N/D)`}
          </span>
        </div>

        <div className="grid grid-cols-4 gap-2 pt-1">
          {['500', '1000', '2500', '5000'].map((amt) => (
            <button
              key={amt}
              type="button"
              onClick={() => {
                setWithdrawAmount(amt);
                setError(null);
              }}
              className="py-2 px-3 rounded-xl bg-[#131F3A]/90 hover:bg-[#192848] text-white text-xs sm:text-sm font-black border border-sky-400/20 active:scale-95 cursor-pointer"
            >
              {amt} PT
            </button>
          ))}
        </div>
      </div>

      {/* REGOLA RIGIDA 3 STRIKE */}
      <div className="rounded-2xl bg-[#091224] border border-cyan-400/35 p-3.5 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-mono font-black uppercase tracking-wider text-cyan-300">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>3-STRIKE PROTOCOL (1 = OK • 2 = WARN • 3 = BLOCK)</span>
          </div>
          <span className="px-2 py-0.5 rounded bg-rose-500/20 border border-rose-400/40 text-[10px] font-mono font-black text-rose-300">
            POSTGRES GUARD
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-emerald-500/15 border border-emerald-400/40 p-2">
            <div className="text-xs font-black text-emerald-300 uppercase">1 = OK</div>
          </div>
          <div className="rounded-xl bg-amber-500/15 border border-amber-400/40 p-2">
            <div className="text-xs font-black text-amber-300 uppercase">2 = WARN</div>
          </div>
          <div className="rounded-xl bg-rose-500/20 border border-rose-400/50 p-2">
            <div className="text-xs font-black text-rose-300 uppercase">3 = BLOCK</div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl bg-[#08101E] border border-amber-500/25 p-3 space-y-2">
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={acceptedLegalDisclaimer}
            onChange={(e) => setAcceptedLegalDisclaimer(e.target.checked)}
            className="mt-1 w-4 h-4 accent-emerald-400 rounded cursor-pointer shrink-0"
          />
          <span className="text-[11px] text-slate-300 leading-snug">
            <strong className="text-amber-300">3-Strike &amp; Tax Autonomy:</strong> 1 = OK • 2 = WARN • 3 = BLOCK ({payoutMode === 'CASH_LOCAL' ? cashGateway.gatewayName : network.walletAppName}).
          </span>
        </label>
      </div>

      {error && (
        <div className="text-sm text-red-400 p-3 rounded-xl bg-[#0A1122] border border-red-500/30 font-bold">
          {error}
        </div>
      )}

      {isLoading && (
        <div className="rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-sm p-4 shadow-md flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="font-black text-sm">Registrazione su PostgreSQL...</span>
        </div>
      )}

      {success && (
        <div className="rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 p-4 text-white">
          <div className="flex items-center gap-1.5 text-sm font-black">
            <CheckCircle2 className="w-4 h-4" />
            <span>OK</span>
          </div>
          <div className="text-xs text-white/95 mt-0.5">{success}</div>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onNavigateHome}
          className="flex items-center justify-center py-2.5 px-4 rounded-xl bg-[#131F3A] text-white font-mono text-xs font-black uppercase cursor-pointer active:scale-95 border border-sky-500/20"
        >
          {t.ui.backBtn}
        </button>
        <button
          type="button"
          onClick={handlePayout}
          disabled={isLoading || !acceptedLegalDisclaimer}
          className="flex-1 py-3.5 px-4 rounded-xl bg-gradient-to-r from-emerald-400 via-green-400 to-teal-400 text-slate-950 font-mono text-sm sm:text-base font-black uppercase cursor-pointer active:scale-95 border-0 shadow-lg flex items-center justify-center gap-2 disabled:opacity-50"
        >
          <Send className="w-4 h-4" />
          <span>
            {payoutMode === 'CASH_LOCAL'
              ? `${t.ui.cashOutOnBtn} ${cashGateway.key}`
              : `${t.ui.cashOutCryptoBtn} (${network.nativeTokenSymbol})`}
          </span>
        </button>
      </div>

      {/* CRONOLOGIA PRELIEVI */}
      <div className="space-y-3 pt-3 border-t border-sky-500/10">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-black text-white">{t.ui.withdrawHistoryTitle}</h3>
        </div>
        {transactions
          .filter((txItem) => txItem.type === 'WITHDRAWAL')
          .slice(0, 10)
          .map((tx) => (
            <div
              key={tx.id}
              className="rounded-xl bg-[#0A1220] p-3 border border-sky-500/10 flex items-center justify-between"
            >
              <div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-black text-white">{tx.amountPoints.toLocaleString()} PT</span>
                  <span className="text-[11px] font-mono text-emerald-300">
                    ≈ ${usdEquivalent(tx.amountPoints)}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-black ${
                      tx.status === 'COMPLETED'
                        ? 'text-slate-950 bg-gradient-to-r from-emerald-400 to-teal-400'
                        : tx.status === 'CANCELLED' || tx.status === 'FAILED'
                        ? 'text-rose-300 bg-rose-500/20 border border-rose-400/35'
                        : 'text-amber-300 bg-amber-500/20 border border-amber-400/35'
                    }`}
                  >
                    {tx.status === 'COMPLETED'
                      ? t.ui.completedBadge
                      : tx.status === 'CANCELLED' || tx.status === 'FAILED'
                      ? 'RIMBORSATO'
                      : tx.status === 'APPROVED'
                      ? 'APPROVATO'
                      : 'IN ELABORAZIONE'}
                  </span>
                </div>
                <div className="text-[10px] text-slate-400 truncate max-w-[230px]">
                  {formatAddress(tx.recipientWallet || tx.details || '')}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-slate-400">
                  {new Date(tx.timestamp).toLocaleDateString()}
                </div>
                <div className="text-[10px] text-slate-400">
                  {new Date(tx.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              </div>
            </div>
          ))}
        {transactions.filter((txItem) => txItem.type === 'WITHDRAWAL').length === 0 && (
          <div className="text-center py-5 text-slate-400 text-sm">{t.ui.noWithdrawalsYet}</div>
        )}
      </div>

      <div className="rounded-2xl bg-[#060B14] border border-slate-800 p-3.5 space-y-1.5 text-[10px] text-slate-400 leading-relaxed">
        <div className="flex items-center gap-1.5 text-slate-300 font-black uppercase tracking-wider text-[10px]">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span>{extra.legalTitle}</span>
        </div>
        <p>{extra.legalPoint1}</p>
        <p>{extra.legalPoint2}</p>
        <p>{extra.legalPoint3}</p>
      </div>
    </div>
  );
};

export default WithdrawView;
