// ============================================================================
// PROVIDER EXECUTION MODAL & PHOTO CARD — Visual, Compact & Interactive
// ============================================================================

import React, { useState } from 'react';
import {
  X,
  ExternalLink,
  CheckCircle2,
  ShieldCheck,
  Clock,
  Globe,
  Mail,
  Copy,
  Check,
  Sparkles,
  Wallet,
  Lock,
} from 'lucide-react';
import { BrandLogo } from './GlassMedia';
import { buildGlassPlaceholderDataUri } from '../lib/glassPlaceholder';
import { openTrackedLink } from '../lib/affiliate';
import { useTranslation } from '../lib/i18n';
import { localizeProviderItem } from '../lib/providerLocalization';
import { isSafeExternalHttpsUrl } from '../utils/navigation';

export type GeoRegion = 'GLOBAL' | 'IT_EU' | 'US_UK_CA';
export type AirdropSubKind = 'WALLET_EXCHANGE' | 'TELEGRAM_TON_AIRDROP' | 'WEB3_ESCROW_AIRDROP';

export interface VerifiedProviderItem {
  id: string;
  name: string;
  brandKey: string;
  categoryLabel: string;
  modalityBadge: string;
  actionDuration: string;
  payoutInfo: string;
  currencies: string;
  userPoints: number;
  isServiceOnly?: boolean;
  isLocked?: boolean;
  lockReason?: string;
  geoRegion?: GeoRegion;
  safeJurisdiction?: string;
  integrationFlexMode?: string;
  airdropKind?: AirdropSubKind;
  walletRequiredName?: string;
  walletSignupUrl?: string;
  compartmentEmail?: string;
  compartmentPortalUrl?: string;
  accentColor?: string;
  photoTitle?: string;
  photoSubtitle?: string;
  directUrl: string;
  shortDescription: string;
  executionSteps: string[];
  executionRuleNote: string;
}

export function resolvePayoutServiceSignup(
  provider: VerifiedProviderItem
): { name: string; shortLabel: string; url: string } | null {
  if (provider.isLocked) return null;
  if (provider.isServiceOnly) return null;

  if (provider.walletRequiredName && provider.walletSignupUrl) {
    return {
      name: provider.walletRequiredName,
      shortLabel: provider.walletRequiredName.replace(/^Conto\s+/i, ''),
      url: provider.walletSignupUrl,
    };
  }

  const haystack = `${provider.id} ${provider.currencies} ${provider.payoutInfo}`.toLowerCase();

  if (haystack.includes('airtm')) {
    return { name: 'Wallet Airtm', shortLabel: 'Wallet Airtm', url: 'https://app.airtm.com/signup' };
  }
  if (haystack.includes('payeer')) {
    return { name: 'Wallet Payeer', shortLabel: 'Wallet Payeer', url: 'https://payeer.com/en/auth/?register=yes' };
  }
  if (haystack.includes('volet') || haystack.includes('advcash')) {
    return { name: 'Wallet Volet', shortLabel: 'Wallet Volet', url: 'https://volet.com/' };
  }
  if (
    haystack.includes('lightning') ||
    haystack.includes('sats') ||
    haystack.includes('satoshi') ||
    haystack.includes('alby') ||
    haystack.includes('blink')
  ) {
    if (provider.id.includes('zbd')) {
      return { name: 'Wallet Bybit', shortLabel: 'Wallet Bybit', url: 'https://www.bybit.com/invite' };
    }
    return { name: 'Wallet ZBD', shortLabel: 'Wallet ZBD', url: 'https://zbd.gg/' };
  }
  if (haystack.includes('ton') || haystack.includes('cati') || haystack.includes('telegram')) {
    return { name: 'Wallet TON / Bybit', shortLabel: 'Wallet TON', url: 'https://www.bybit.com/invite' };
  }
  if (haystack.includes('usdc') || haystack.includes('coinbase')) {
    return { name: 'Wallet Coinbase', shortLabel: 'Coinbase', url: 'https://www.coinbase.com/join' };
  }
  return { name: 'Wallet Bybit / Crypto', shortLabel: 'Wallet Crypto', url: 'https://www.bybit.com/invite' };
}

interface ProviderExecutionModalProps {
  provider: VerifiedProviderItem | null;
  onClose: () => void;
  onExecute: (provider: VerifiedProviderItem) => void;
  onOpenWalletSignup?: (provider: VerifiedProviderItem) => void;
}

export const ProviderExecutionModal: React.FC<ProviderExecutionModalProps> = ({
  provider: rawProvider,
  onClose,
  onExecute,
  onOpenWalletSignup,
}) => {
  const { t, lang } = useTranslation();
  const [copiedMail, setCopiedMail] = useState(false);

  if (!rawProvider) return null;
  const provider = localizeProviderItem(rawProvider, lang, t);

  const payoutSignup = resolvePayoutServiceSignup(provider);
  const triggerPayoutSignup = () => {
    if (!payoutSignup) return;
    if (onOpenWalletSignup && provider.walletSignupUrl) {
      onOpenWalletSignup(provider);
      return;
    }
    openTrackedLink(payoutSignup.url, {
      partnerId: provider.id,
      taskId: `wallet_signup_${provider.id}`,
      kind: 'SIGNUP',
    });
  };

  const photoUri = buildGlassPlaceholderDataUri(
    provider.photoTitle || provider.name.toUpperCase(),
    provider.accentColor || '#0098EA',
    provider.photoSubtitle || provider.modalityBadge.toUpperCase()
  );

  const handleCopyCompartment = () => {
    if (!provider.compartmentEmail) return;
    navigator.clipboard?.writeText(provider.compartmentEmail).catch(() => {});
    setCopiedMail(true);
    setTimeout(() => setCopiedMail(false), 1800);
  };

  const geoLabel =
    provider.geoRegion === 'US_UK_CA'
      ? 'GEO: USA / UK / CA'
      : provider.geoRegion === 'IT_EU'
      ? 'GEO: EU'
      : 'GEO: GLOBAL';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-3 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md rounded-2xl border border-sky-400/40 bg-[#07101e] text-white shadow-2xl overflow-hidden max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* TOP VISUAL BANNER */}
        <div className="relative h-36 w-full bg-[#040914] overflow-hidden shrink-0">
          <img
            src={photoUri}
            alt={provider.name}
            className="w-full h-full object-cover opacity-90"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#07101e] via-[#07101e]/40 to-transparent" />

          <button
            type="button"
            onClick={onClose}
            className="absolute top-2.5 right-2.5 w-8 h-8 rounded-xl bg-black/75 border border-white/20 flex items-center justify-center text-white hover:bg-red-500/80 transition-all cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="absolute top-2.5 left-2.5 flex flex-wrap items-center gap-1.5">
            {provider.isLocked ? (
              <span className="px-2 py-0.5 rounded-lg bg-amber-500 text-slate-950 font-mono text-[10px] font-black uppercase flex items-center gap-1">
                <Lock className="w-3 h-3" />
                <span>{t.ui.lockedBadge}</span>
              </span>
            ) : (
              <span className="px-2 py-0.5 rounded-lg bg-sky-500 text-slate-950 font-mono text-[10px] font-black uppercase">
                {provider.modalityBadge}
              </span>
            )}
            <span className="px-2 py-0.5 rounded-lg bg-black/75 border border-white/15 text-amber-300 font-mono text-[10px] font-bold uppercase flex items-center gap-1">
              <Globe className="w-3 h-3" />
              {geoLabel}
            </span>
          </div>

          <div className="absolute bottom-2.5 left-3 right-3 flex items-center gap-2.5">
            <div className="w-11 h-11 rounded-xl bg-[#0a1628] border border-sky-400/40 flex items-center justify-center p-1.5 shrink-0">
              <BrandLogo brand={provider.brandKey} size={32} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-mono font-bold uppercase text-sky-300 truncate">
                {provider.categoryLabel}
              </div>
              <h3 className="text-base font-black text-white truncate">{provider.name}</h3>
            </div>
          </div>
        </div>

        {/* COMPACT INTERACTIVE BODY */}
        <div className="p-3.5 space-y-2.5 overflow-y-auto">
          {/* 3 VISUAL METRIC PILLS */}
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-[#0b172a] border border-sky-400/20 p-2 text-center">
              <div className="flex items-center justify-center gap-1 text-[9px] font-mono text-slate-400 uppercase">
                <Clock className="w-3 h-3 text-sky-400" />
                <span>{t.ui.durationLabel}</span>
              </div>
              <div className="text-xs font-black text-white mt-0.5 truncate">
                {provider.actionDuration}
              </div>
            </div>
            <div className="rounded-xl bg-[#0b172a] border border-sky-400/20 p-2 text-center">
              <div className="flex items-center justify-center gap-1 text-[9px] font-mono text-slate-400 uppercase">
                <ShieldCheck className="w-3 h-3 text-emerald-400" />
                <span>{t.ui.payoutLabel}</span>
              </div>
              <div className="text-xs font-black text-emerald-300 mt-0.5 truncate">
                {provider.payoutInfo}
              </div>
            </div>
            <div className="rounded-xl bg-[#0b172a] border border-sky-400/20 p-2 text-center">
              <div className="flex items-center justify-center gap-1 text-[9px] font-mono text-slate-400 uppercase">
                <Wallet className="w-3 h-3 text-amber-400" />
                <span>{t.ui.currencyLabel}</span>
              </div>
              <div className="text-xs font-black text-amber-300 mt-0.5 truncate">
                {provider.currencies}
              </div>
            </div>
          </div>

          {/* 1-CLICK MAIL COMPARTMENT BAR */}
          {provider.compartmentEmail && (
            <div className="rounded-xl bg-indigo-950/60 border border-indigo-400/35 px-3 py-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Mail className="w-4 h-4 text-indigo-400 shrink-0" />
                <span className="text-xs font-bold text-white truncate">
                  {provider.compartmentEmail}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={handleCopyCompartment}
                  className="px-2.5 py-1 rounded-lg bg-indigo-500/25 border border-indigo-400/40 text-[11px] font-bold text-indigo-200 flex items-center gap-1 cursor-pointer"
                >
                  {copiedMail ? (
                    <Check className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  <span>{copiedMail ? t.ui.copiedBtn : t.ui.copyBtn}</span>
                </button>
                {provider.compartmentPortalUrl && isSafeExternalHttpsUrl(provider.compartmentPortalUrl) && (
                  <a
                    href={provider.compartmentPortalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                    className="px-2.5 py-1 rounded-lg bg-sky-500/20 border border-sky-400/40 text-[11px] font-bold text-sky-200"
                  >
                    {t.ui.openBtn}
                  </a>
                )}
              </div>
            </div>
          )}

          {/* COMPACT NUMBERED STEPS */}
          <div className="rounded-xl bg-[#0a1426] border border-sky-400/20 p-3 space-y-1.5">
            <div className="flex items-center gap-1.5 text-[10px] font-mono font-black uppercase text-sky-300">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span>{t.ui.quickStepsTitle}</span>
            </div>
            <ol className="space-y-1.5">
              {provider.executionSteps.map((step, index) => (
                <li
                  key={index}
                  className="flex items-start gap-2 text-xs text-slate-200 leading-snug"
                >
                  <span className="w-4 h-4 rounded-full bg-sky-500/25 border border-sky-400/50 text-sky-300 font-mono text-[10px] font-black flex items-center justify-center shrink-0 mt-0.5">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>

        {/* INTERACTIVE DUAL-BUTTON FOOTER */}
        <div className="p-3 bg-[#050b16] border-t border-sky-400/20 flex items-center justify-between gap-2 shrink-0">
          {provider.isLocked ? (
            <button
              type="button"
              onClick={onClose}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-amber-500/20 border border-amber-400/50 px-4 py-2.5 text-xs font-black uppercase text-amber-200 cursor-pointer"
            >
              <Lock className="w-4 h-4" />
              <span>{t.ui.lockedBtn}</span>
            </button>
          ) : (
            <>
              {payoutSignup ? (
                <button
                  type="button"
                  onClick={triggerPayoutSignup}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500/20 border border-emerald-400/50 px-3 py-2.5 text-xs font-black uppercase text-emerald-200 hover:bg-emerald-500/35 cursor-pointer"
                >
                  <Wallet className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">1. {payoutSignup.name}</span>
                </button>
              ) : (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-400/35 text-[11px] font-mono font-black text-amber-300">
                  {t.ui.directServiceBadge}
                </span>
              )}

              <button
                type="button"
                onClick={() => {
                  const normalizedPts =
                    !provider.isServiceOnly && provider.userPoints > 0
                      ? provider.userPoints
                      : 0;
                  onExecute({ ...provider, userPoints: normalizedPts });
                  onClose();
                }}
                className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-sky-500 to-cyan-400 px-3 py-2.5 text-xs font-black uppercase text-slate-950 shadow-lg active:scale-95 transition-all cursor-pointer"
              >
                <span className="truncate">
                  {!provider.isServiceOnly && provider.userPoints > 0
                    ? `2. ${t.ui.startActionBtn} (S2S +${provider.userPoints} PT max)`
                    : payoutSignup
                    ? t.ui.signupStep2Btn
                    : t.ui.openPortalBtn}
                </span>
                <ExternalLink className="w-3.5 h-3.5 shrink-0" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

interface ProviderCardWithPhotoProps {
  provider: VerifiedProviderItem;
  onOpenInstructions: (provider: VerifiedProviderItem) => void;
  onExecuteDirect: (provider: VerifiedProviderItem) => void;
  onOpenWalletSignup?: (provider: VerifiedProviderItem) => void;
}

export const ProviderCardWithPhoto: React.FC<ProviderCardWithPhotoProps> = ({
  provider: rawProvider,
  onOpenInstructions,
  onExecuteDirect,
}) => {
  const { t, lang } = useTranslation();
  const provider = localizeProviderItem(rawProvider, lang, t);
  const photoUri = buildGlassPlaceholderDataUri(
    provider.photoTitle || provider.name.toUpperCase(),
    provider.accentColor || '#0098EA',
    provider.photoSubtitle || provider.modalityBadge.toUpperCase()
  );

  const effectivePoints =
    !provider.isLocked && !provider.isServiceOnly && provider.userPoints > 0
      ? provider.userPoints
      : 0;

  return (
    <div
      className={`rounded-2xl border overflow-hidden shadow-lg transition-all flex flex-col ${
        provider.isLocked
          ? 'border-amber-500/35 bg-[#091324]/75 opacity-85'
          : 'border-sky-400/25 bg-[#091324]/95 hover:border-sky-400/60'
      }`}
    >
      {/* FOTO INTERATTIVA CLICCABILE */}
      <button
        type="button"
        onClick={() => onOpenInstructions({ ...provider, userPoints: effectivePoints })}
        className="relative h-32 w-full bg-[#050a14] overflow-hidden text-left group cursor-pointer border-0 p-0"
      >
        <img
          src={photoUri}
          alt={provider.name}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#091324] via-black/25 to-transparent" />

        <div className="absolute top-2 left-2 right-2 flex items-center justify-between gap-1.5">
          {provider.isLocked ? (
            <span className="px-2 py-0.5 rounded-md bg-amber-500 text-slate-950 font-mono text-[10px] font-black uppercase truncate flex items-center gap-1 shadow">
              <Lock className="w-3 h-3 shrink-0" />
              <span>{t.ui.lockedBadge} • {provider.currencies}</span>
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded-md bg-black/80 border border-sky-400/40 font-mono text-[10px] font-black text-sky-300 uppercase truncate">
              {provider.actionDuration}
            </span>
          )}
          {effectivePoints > 0 && (
            <span className="px-2 py-0.5 rounded-md bg-emerald-500 text-slate-950 font-mono text-[10px] font-black uppercase shrink-0 flex items-center gap-0.5">
              <CheckCircle2 className="w-3 h-3" />+{effectivePoints} PT
            </span>
          )}
        </div>

        <div className="absolute bottom-2 left-2.5 right-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-[#07101f] border border-sky-400/40 flex items-center justify-center p-1 shrink-0">
              <BrandLogo brand={provider.brandKey} size={24} />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-black text-white truncate">{provider.name}</h3>
              <p className="text-[10px] font-mono text-amber-300 truncate">{provider.categoryLabel}</p>
            </div>
          </div>
          <span className="shrink-0 px-2 py-1 rounded-lg bg-sky-500/90 text-slate-950 font-mono text-[10px] font-black uppercase shadow">
            {t.ui.infoBadge}
          </span>
        </div>
      </button>

      {/* UNICO PULSANTE DIRETTO PULITO SOTTO LA FOTO */}
      <div className="p-2.5 bg-[#07101e]">
        {provider.isLocked ? (
          <button
            type="button"
            onClick={() => onOpenInstructions(provider)}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-black uppercase bg-amber-500/15 border border-amber-400/45 text-amber-200 cursor-pointer"
          >
            <Lock className="w-3.5 h-3.5" />
            <span>{t.ui.lockedBtn}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onExecuteDirect({ ...provider, userPoints: effectivePoints })}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-black uppercase bg-gradient-to-r from-sky-500 to-cyan-400 text-slate-950 shadow active:scale-95 transition-all cursor-pointer"
          >
            <span>
              {provider.isServiceOnly
                ? t.ui.openBrandPortalBtn
                : effectivePoints > 0
                  ? `${t.ui.startActionBtn} (+${effectivePoints} PT)`
                  : t.ui.startNowBtn}
            </span>
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
};
