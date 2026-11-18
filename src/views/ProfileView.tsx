// ============================================================================
// PROFILE VIEW — Profilo utente, statistiche, impostazioni
// ============================================================================

import React, { useState } from 'react';
import { ArrowLeft, Star, Shield, Key, ShieldCheck, Globe, Copy, CheckCircle2, Send } from 'lucide-react';
import { CleanAdSlot } from '../components/CleanAdSlot';
import { UserProfile, Transaction } from '../types';
import { useTranslation } from '../lib/i18n';
import { EXTRA_UI_LOCALIZATION } from '../lib/providerLocalization';
import { countryLabel } from '../lib/entryProfile';
import { resolveCountryEconomicProfile } from '../lib/geoEconomics';

interface ProfileViewProps {
  user: UserProfile;
  transactions: Transaction[];
  onOpenTonkeeperGuide: () => void;
  onNavigateHome: () => void;
  cloudAccountEmail?: string | null;
  onSignInCloud?: () => Promise<void>;
  onSignOutCloud?: () => Promise<void>;
}

export const ProfileView: React.FC<ProfileViewProps> = ({
  user,
  transactions,
  onNavigateHome,
  cloudAccountEmail,
  onSignInCloud,
  onSignOutCloud,
}) => {
  const { t, lang } = useTranslation();
  const extra = EXTRA_UI_LOCALIZATION[lang] || EXTRA_UI_LOCALIZATION.en;
  const [, setCopied] = useState<string | null>(null);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const countryCode = user.marketCountry || 'OTHER';
  const countryProfile = resolveCountryEconomicProfile(countryCode);
  const economicZone = user.tierZone || countryProfile.tierZone;
  const pppCoef = user.pppCoefficient ?? countryProfile.pppCoefficient;
  const regionGrp = user.regionGroup || countryProfile.regionGroup;

  const withdrawablePts = user.withdrawablePoints ?? user.points;
  const pendingPts = user.pendingPoints ?? 0;
  const settledPts = user.settledPoints ?? 0;
  const reservedPts = user.reservedPoints ?? 0;

  const stats = [
    { label: t.ui.availablePointsLabel, value: `${withdrawablePts.toLocaleString()} PT`, icon: Star, color: 'text-emerald-400' },
    { label: 'In Attesa S2S', value: `${pendingPts.toLocaleString()} PT`, icon: CheckCircle2, color: 'text-amber-400' },
    { label: 'Liquidati', value: `${settledPts.toLocaleString()} PT`, icon: ShieldCheck, color: 'text-sky-400' },
    { label: 'Riservati', value: `${reservedPts.toLocaleString()} PT`, icon: Shield, color: 'text-purple-400' },
  ];

  return (
    <div className="w-full max-w-2xl mx-auto space-y-4 pb-14 animate-fade-in select-none">
      {/* CLEAN AD SLOT */}
      <CleanAdSlot page="profile" placement="PROFILE_TOP" telegramUserId={user?.telegramId} />

      {/* HEADER */}
      <div className="flex items-center justify-between gap-3 px-1 py-1">
        <button
          type="button"
          onClick={onNavigateHome}
          className="p-2.5 rounded-xl bg-[#0098EA] text-white hover:bg-cyan-400 hover:text-slate-950 border-0 cursor-pointer active:scale-95 transition-all flex items-center justify-center shrink-0 shadow-md"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 text-center">
          <h2 className="text-lg font-black text-white">{t.nav.profile}</h2>
          <p className="text-[11px] text-slate-400">ID: {user.telegramId}</p>
        </div>
        <div className="w-10" />
      </div>

      {/* PROFILO PRINCIPALE */}
      <div className="space-y-4">
        <div className="relative rounded-2xl bg-gradient-to-br from-[#0A1122] via-[#0E1830] to-[#0A1122] p-6 border-0 border-emerald-500/20 shadow-[0_0_24px_rgba(16,185,129,0.15)] overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-emerald-500/5 to-transparent pointer-events-none" />
          
          <div className="relative z-10 flex items-center gap-4">
            <div className="relative w-24 h-24 sm:w-28 sm:h-28 rounded-2xl overflow-hidden shadow-[0_0_24px_rgba(16,185,129,0.4)] border-2 border-emerald-500/40">
              <div className="w-full h-full bg-gradient-to-br from-emerald-500/30 to-emerald-900/30 flex items-center justify-center">
                <span className="text-4xl sm:text-5xl font-black gold-diamond-royal-text">A</span>
              </div>
              <div className="absolute -bottom-2 -right-2 w-8 h-8 rounded-full bg-emerald-500 border-2 border-[#05080f] flex items-center justify-center shadow-lg">
                <Star className="w-5 h-5 text-amber-300" />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-xl sm:text-2xl font-black text-white truncate">{user.firstName} {user.lastName || ''}</h2>
              <p className="text-sm text-slate-300">@{user.username || `user_${user.telegramId}`}</p>
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <span className="px-2.5 py-1 rounded-full text-xs font-mono font-black uppercase tracking-wider text-emerald-300 bg-emerald-500/20 border border-emerald-400/35 flex items-center gap-1">
                  <Globe className="w-3.5 h-3.5" />
                  <span>{countryLabel(countryCode, lang)} ({countryCode}) • {economicZone}</span>
                </span>
                <span className="px-2 py-1 rounded-full text-[11px] font-mono font-bold text-indigo-200 bg-indigo-500/15 border border-indigo-400/35">
                  PPP: x{pppCoef.toFixed(4)} • {regionGrp}
                </span>
                <span className="px-2 py-1 rounded-full text-[11px] font-mono font-bold text-sky-300 bg-sky-500/15 border border-sky-400/30">
                  100 PT = $1.00 USD (Prelievi invariati)
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* STATISTICHE POSTGRESQL (4 BUCKET) */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {stats.map((stat, idx) => {
            const IconComp = stat.icon;
            return (
              <div key={idx} className="rounded-2xl bg-[#0A1122] p-4 border border-sky-500/10 text-center">
                <div className="flex items-center justify-center gap-1.5 mb-1">
                  <span className={`${stat.color} text-xl`}>
                    <IconComp className="w-5 h-5" />
                  </span>
                  <span className="text-xs font-black uppercase tracking-wider text-slate-400">{stat.label}</span>
                </div>
                <div className="text-lg sm:text-xl font-black text-white tabular-nums">{stat.value}</div>
              </div>
            );
          })}
        </div>

        {/* IMPOSTAZIONI RAPIDE */}
        <div className="space-y-3">
          <h3 className="text-xs font-black uppercase tracking-wider text-sky-400 px-1">{t.ui.quickSettingsTitle}</h3>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => copyToClipboard(user.telegramId.toString(), 'ID Telegram')}
              className="flex items-center gap-3 p-3 rounded-xl bg-[#0A1122] border border-sky-500/20 text-left active:scale-95 cursor-pointer"
            >
              <Key className="w-6 h-6 text-sky-400" />
              <div className="flex-1">
                <div className="text-sm font-black text-white">{t.ui.copyTelegramId}</div>
                <div className="text-[11px] text-sky-300/80">{user.telegramId}</div>
              </div>
              <Copy className="w-5 h-5 text-sky-400" />
            </button>
            <button
              type="button"
              onClick={() => copyToClipboard(user.walletAddress || '', 'Wallet')}
              className="flex items-center gap-3 p-3 rounded-xl bg-[#0A1122] border border-amber-500/20 text-left active:scale-95 cursor-pointer"
            >
              <Key className="w-6 h-6 text-amber-400" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black text-white">{t.ui.walletAddressLabel}</div>
                <div className="text-[11px] text-amber-300/80 truncate">{user.walletAddress || t.ui.notSetLabel}</div>
              </div>
              <Copy className="w-5 h-5 text-amber-400" />
            </button>
          </div>

          {onSignInCloud && (
            <div className="rounded-2xl bg-[#0A1122] border border-sky-500/20 p-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-black text-white">Backup Account Google</div>
                <div className="text-[11px] text-slate-400 truncate">
                  {cloudAccountEmail || 'Salva il profilo sul tuo account Google (saldi sempre su PostgreSQL)'}
                </div>
              </div>
              {cloudAccountEmail ? (
                <button
                  type="button"
                  onClick={() => {
                    if (onSignOutCloud) void onSignOutCloud();
                  }}
                  className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-black uppercase cursor-pointer border-0 shrink-0"
                >
                  Disconnetti
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    void onSignInCloud();
                  }}
                  className="px-3 py-2 rounded-xl bg-gradient-to-r from-sky-500 to-cyan-400 text-slate-950 text-xs font-black uppercase cursor-pointer border-0 shrink-0"
                >
                  Collega Google
                </button>
              )}
            </div>
          )}
        </div>

        {/* STORICO TRANSAZIONI POSTGRESQL */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-black uppercase tracking-wider text-sky-400">{t.ui.recentTransactionsTitle}</h3>
          </div>
          {transactions.slice(0, 15).length > 0 ? (
            <div className="space-y-2">
              {transactions.slice(0, 15).map((tx) => {
                const isDebit =
                  tx.type === 'WITHDRAWAL' || tx.type === 'PENALTY' || tx.amountPoints < 0;
                const absPoints = Math.abs(tx.amountPoints);
                return (
                <div key={tx.id} className="flex items-center justify-between p-3 rounded-xl bg-[#0A1122] border border-sky-500/10">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-xs font-black shrink-0 ${
                      tx.type === 'TASK_CLAIM' ? 'bg-emerald-500/20 text-emerald-400' :
                      tx.type === 'WITHDRAWAL' ? 'bg-amber-500/20 text-amber-400' :
                      'bg-sky-500/20 text-sky-400'
                    }`}>
                      {tx.type === 'TASK_CLAIM' && <Star className="w-4 h-4" />}
                      {tx.type === 'WITHDRAWAL' && <Send className="w-4 h-4" />}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-black text-white truncate">{tx.details || tx.type}</div>
                      <div className="text-[11px] text-slate-400">
                        {new Date(tx.timestamp).toLocaleString()} • {tx.status}
                      </div>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`font-mono font-black ${isDebit ? 'text-amber-400' : 'text-emerald-400'}`}>
                      {isDebit ? `-${absPoints}` : `+${absPoints}`} PT
                    </div>
                    <div className="text-[10px] text-sky-300/80 font-mono">
                      ≈ ${(absPoints * 0.01).toFixed(2)}
                      {tx.amountTon > 0 ? ` (${tx.amountTon.toFixed(4)} ${tx.cryptoAsset || 'TON'})` : ''}
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8 text-slate-400 text-sm">
              {t.ui.noRecentTransactions}
            </div>
          )}
        </div>

        {/* PROTOCOLLO RIGIDO 3 STRIKE (UTENTI & FORNITORI) + ESONERO FISCALE */}
        <div className="rounded-2xl bg-[#060B14] border border-cyan-500/30 p-4 space-y-2.5 text-[11px] text-slate-300 leading-relaxed">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-cyan-300 font-black uppercase tracking-wider text-xs">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{extra.threeStrikeTitle}</span>
            </div>
            <span className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/40 text-[10px] font-mono font-black text-emerald-300">
              {extra.threeStrikeStatusRegular}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center pt-1">
            <div className="rounded-xl bg-emerald-500/15 border border-emerald-400/35 p-2">
              <div className="text-xs font-black text-emerald-300">1 = OK</div>
              <div className="text-[10px] text-slate-300">{extra.strike1Desc}</div>
            </div>
            <div className="rounded-xl bg-amber-500/15 border border-amber-400/35 p-2">
              <div className="text-xs font-black text-amber-300">{extra.strike2Label}</div>
              <div className="text-[10px] text-slate-300">{extra.strike2Desc}</div>
            </div>
            <div className="rounded-xl bg-rose-500/20 border border-rose-400/45 p-2">
              <div className="text-xs font-black text-rose-300">{extra.strike3Label}</div>
              <div className="text-[10px] text-slate-300">{extra.strike3Desc}</div>
            </div>
          </div>
          <p className="text-slate-300 pt-1">{extra.pointsRedeemSummary}</p>
          <p className="text-[10px] text-slate-400">{extra.internationalDisclaimerText}</p>
        </div>
      </div>
    </div>
  );
};

export default ProfileView;

