// ============================================================================
// ACTIONFLOW HUB — APP PRINCIPALE (Single Unified Auto Session + PostgreSQL Ledger)
// ============================================================================
// Flusso Completo:
// 1. EntryView Neon (#000000) con video intro.mp4 automatico non saltabile
// 2. EntryView (#000000) con selezione 14 lingue (nessuna durata 10/20/30 min)
// 3. ProductTypeView (#000000) con selezione genere e categorie di interesse
// 4. Avvio Sessione Automatizzata Unica (POST /api/auto-session/start)
// 5. Home con Sessione Unica, tracciamento singole interazioni S2S e saldi reali PostgreSQL
// ============================================================================

import React, { useState, useCallback, useEffect } from 'react';
import {
  UserProfile,
  Transaction,
} from './types';
import { Header } from './components/Header';
import { OfficialBanner } from './components/OfficialBanner';
import { CyberNav, CyberTab } from './components/CyberNav';
import { EntryVideoView } from './views/EntryVideoView';
import { EntryView } from './views/EntryView';
import { ProductTypeView } from './views/ProductTypeView';
import { HomeView } from './views/HomeView';
import { GamesView } from './views/GamesView';
import { MicroDramaView } from './views/MicroDramaView';
import { MusicAudioView } from './views/MusicAudioView';
import { AiWorkView } from './views/AiWorkView';
import { UxQaView } from './views/UxQaView';
import { ReceiptOcrView } from './views/ReceiptOcrView';
import { DepinNodesView } from './views/DepinNodesView';
import { ShoppingView } from './views/ShoppingView';
import { AirdropHubView } from './views/AirdropHubView';
import { WithdrawView, type WithdrawalResult } from './views/WithdrawView';
import { ProfileView } from './views/ProfileView';
import { AdminView } from './views/AdminView';
import { LanguageProvider, useTranslation, SupportedLang } from './lib/i18n';
import { EntryCategoryId } from './lib/entryProfile';
import {
  normalizeCountryCode,
  persistEntryCountry,
  readEntryCountry,
  resolveCountryEconomicProfile,
} from './lib/geoEconomics';
import {
  getTelegramUser,
  getTelegramInitData,
  initUserProfile,
  saveUserLocally,
  purgeLegacyAppMemory,
} from './services/api';
import { onAuthStateChanged, signInWithPopup, signOut, User as FirebaseUser } from 'firebase/auth';
import { auth, googleAuthProvider } from './lib/firebase';
import {
  fetchUserCloudData,
  upsertUserAccountInCloud,
} from './services/firestoreSync';

type OnboardingStep = 'video' | 'entry' | 'productType' | 'app';

const PRODUCT_TYPE_TO_CATEGORIES: Record<string, EntryCategoryId[]> = {
  games_mobile: ['games', 'interactions'],
  games_pc: ['games', 'interactions'],
  gaming: ['games', 'interactions'],
  soap: ['videos', 'interactions'],
  video_clips: ['videos', 'interactions'],
  drama: ['videos', 'interactions'],
  music: ['videos', 'interactions'],
  ai_voice: ['ai_tasks', 'interactions'],
  ai_photo: ['ai_tasks', 'interactions'],
  ai: ['ai_tasks', 'interactions'],
  ocr: ['receipts', 'interactions'],
  ux_sites: ['interactions'],
  ux_apps: ['games', 'interactions'],
  surveys: ['surveys', 'interactions'],
  audio: ['audio', 'videos'],
};

const ActionFlowInner: React.FC = () => {
  const { lang, setLang } = useTranslation();
  const [user, setUser] = useState<UserProfile>(() => {
    purgeLegacyAppMemory(false);
    const tg = getTelegramUser();
    return initUserProfile(
      tg || {
        id: 0,
        first_name: 'Utente Ospite / Test',
        last_name: '',
        username: 'guest_test_user',
        language_code: 'it',
        is_premium: false,
        photo_url: '',
      }
    );
  });

  const [currentTab, setCurrentTab] = useState<CyberTab>('home');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [adminToken, setAdminToken] = useState<string>('');

  const refreshAuthoritativeBalances = useCallback(async () => {
    const initData = getTelegramInitData();
    if (!initData) {
      setUser((prev) => ({
        ...prev,
        points: 0,
        pendingPoints: 0,
        settledPoints: 0,
        withdrawablePoints: 0,
        reservedPoints: 0,
      }));
      return;
    }

    try {
      const res = await fetch('/api/ledger/balance', {
        headers: { 'X-Telegram-Init-Data': initData },
      });
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      if (data?.ok && data?.dbConnected && data?.balances) {
        const withdrawable = Number(data.balances.withdrawable_points || 0);
        const pending = Number(data.balances.pending_points || 0);
        const settled = Number(data.balances.settled_points || 0);
        const reserved = Number(data.balances.reserved_points || 0);
        const interactionsArr = Array.isArray(data.interactions) ? data.interactions : [];
        const payoutsArr = Array.isArray(data.payouts) ? data.payouts : [];
        const serverCountry =
          typeof data.marketCountry === 'string' && data.marketCountry !== 'OTHER'
            ? normalizeCountryCode(data.marketCountry)
            : null;
        const resolvedServerProfile = resolveCountryEconomicProfile(
          serverCountry || data.marketCountry || 'OTHER'
        );
        const serverZone =
          data.tierZone === 'ZONE_A' || data.tierZone === 'ZONE_B' || data.tierZone === 'ZONE_C'
            ? data.tierZone
            : resolvedServerProfile.tierZone;
        const serverPppCoef =
          typeof data.pppCoefficient === 'number' && data.pppCoefficient > 0
            ? data.pppCoefficient
            : resolvedServerProfile.pppCoefficient;
        const serverRegionGroup =
          typeof data.regionGroup === 'string' && data.regionGroup
            ? data.regionGroup
            : resolvedServerProfile.regionGroup;

        if (serverCountry) {
          persistEntryCountry(serverCountry);
          setSelectedCountry(serverCountry);
        }
        if (data.countryLocked || serverCountry) {
          setCountryLockedInDb(true);
        }

        setUser((prev) => ({
          ...prev,
          points: withdrawable,
          pendingPoints: pending,
          settledPoints: settled,
          withdrawablePoints: withdrawable,
          reservedPoints: reserved,
          marketCountry: serverCountry || prev.marketCountry,
          tierZone: serverZone || prev.tierZone,
          pppCoefficient: serverPppCoef,
          regionGroup: serverRegionGroup,
          completedTasksCount: interactionsArr.filter(
            (i: any) => i.status === 'POSTBACK_CONFIRMED_PENDING' || i.status === 'SETTLED'
          ).length,
        }));

        const mappedPayouts: Transaction[] = payoutsArr.map((p: any) => ({
          id: String(p.request_id),
          userId: String(p.user_id),
          type: 'WITHDRAWAL',
          amountPoints: Number(p.points || 0),
          amountGram: 0,
          amountTon: Number(p.asset_amount || p.amount_ton || 0),
          recipientWallet: String(p.wallet_address || ''),
          timestamp: String(p.created_at || new Date().toISOString()),
          status:
            p.status === 'COMPLETED'
              ? 'COMPLETED'
              : p.status === 'APPROVED'
              ? 'APPROVED'
              : p.status === 'REJECTED'
              ? 'CANCELLED'
              : 'PENDING',
          hash: String(p.tx_hash || p.request_id || ''),
          details: `${p.crypto_asset} ($${Number(p.amount_usd || 0).toFixed(2)}) -> ${p.wallet_address}`,
          cryptoAsset: p.crypto_asset,
          cryptoAmount: Number(p.asset_amount || p.amount_ton || 0),
        }));

        const mappedInteractions: Transaction[] = interactionsArr.map((it: any) => ({
          id: String(it.interaction_id),
          userId: String(data.userId || user.telegramId),
          type: 'TASK_CLAIM',
          amountPoints: Number(it.user_settled_points || it.user_pending_points || 0),
          amountGram: 0,
          amountTon: 0,
          timestamp: String(it.clicked_at || new Date().toISOString()),
          status:
            it.status === 'SETTLED'
              ? 'COMPLETED'
              : it.status === 'REVOKED' || it.status === 'EXPIRED'
              ? 'CANCELLED'
              : 'PENDING',
          hash: String(it.click_id || ''),
          details: `${it.provider_id} • ${it.activity_category} (${it.status})`,
        }));

        const merged = [...mappedPayouts, ...mappedInteractions].sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
        setTransactions(merged);
      }
    } catch {
      // Non-blocking authoritative sync
    }
  }, [user.telegramId]);

  useEffect(() => {
    void refreshAuthoritativeBalances();
  }, [refreshAuthoritativeBalances]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser);
      if (fbUser && fbUser.emailVerified) {
        try {
          const cloud = await fetchUserCloudData(fbUser.uid);
          if (cloud.walletAddress || cloud.username || cloud.firstName) {
            setUser((prev) => {
              const merged: UserProfile = {
                ...prev,
                username: prev.username || cloud.username || '',
                firstName: prev.firstName || cloud.firstName || '',
                walletAddress: prev.walletAddress || cloud.walletAddress || '',
              };
              saveUserLocally(merged);
              return merged;
            });
          }
        } catch {
          // Non-blocking non-financial profile sync only
        }
      }
    });
    return () => unsubscribe();
  }, []);

  // Flusso in ingresso: 'video' -> 'entry' (14 lingue) -> 'productType' (categorie) -> 'app'
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>('video');
  const [autoSessionTriggerKey, setAutoSessionTriggerKey] = useState<number>(1);
  const [selectedCountry, setSelectedCountry] = useState<string>(() => readEntryCountry(undefined, 'IT'));
  const [countryLockedInDb, setCountryLockedInDb] = useState<boolean>(false);
  const [selectedCategories, setSelectedCategories] = useState<EntryCategoryId[]>(() => {
    try {
      const raw = localStorage.getItem('af_entry_categories');
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) && parsed.length > 0
        ? parsed
        : ['videos', 'games', 'interactions'];
    } catch {
      return ['videos', 'games', 'interactions'];
    }
  });

  // Step 1: Avvio da EntryView (senza durate 10/20/30m) -> ProductTypeView
  const handleStartFromEntryView = useCallback(
    (chosenLang: SupportedLang) => {
      setLang(chosenLang);
      setOnboardingStep('productType');

      try {
        localStorage.setItem('af_entry_lang', chosenLang);
      } catch {
        // ignore storage errors
      }
    },
    [setLang]
  );

  // Step 2: Selezione profilo, Paese e categorie -> HomeView + Sessione Automatizzata Unica su PostgreSQL
  const handleSelectProductType = useCallback(
    (productType: string, gender?: 'uomo' | 'donna', selectedIds?: string[], chosenCountry?: string) => {
      const ids =
        selectedIds && selectedIds.length > 0
          ? selectedIds
          : productType
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);

      const categorySet = new Set<EntryCategoryId>();
      ids.forEach((id) => {
        const mapped = PRODUCT_TYPE_TO_CATEGORIES[id];
        if (mapped) {
          mapped.forEach((c) => categorySet.add(c));
        }
      });

      const mappedCategories: EntryCategoryId[] =
        categorySet.size > 0
          ? Array.from(categorySet)
          : ['videos', 'games', 'interactions'];

      const effectiveCountry = countryLockedInDb
        ? selectedCountry
        : persistEntryCountry(chosenCountry || selectedCountry);
      const effectiveProfile = resolveCountryEconomicProfile(effectiveCountry);
      const effectiveZone = effectiveProfile.tierZone;

      setSelectedCountry(effectiveCountry);
      setSelectedCategories(mappedCategories);
      setOnboardingStep('app');
      setAutoSessionTriggerKey((k) => k + 1);
      setUser((prev) => {
        const next: UserProfile = {
          ...prev,
          marketCountry: effectiveCountry,
          tierZone: effectiveZone,
          pppCoefficient: effectiveProfile.pppCoefficient,
          regionGroup: effectiveProfile.regionGroup,
        };
        saveUserLocally(next);
        return next;
      });

      try {
        localStorage.setItem('af_product_type', productType);
        localStorage.setItem('af_product_types_multi', JSON.stringify(ids));
        if (gender) {
          localStorage.setItem('af_user_gender', gender);
        }
        localStorage.setItem('af_entry_categories', JSON.stringify(mappedCategories));
        localStorage.setItem('af_entry_completed', '1');
      } catch {
        // ignore storage errors
      }

      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const initData = getTelegramInitData();
      if (initData) {
        void fetch('/api/auto-session/start', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Init-Data': initData,
          },
          body: JSON.stringify({
            categories: mappedCategories,
            country: effectiveCountry,
            lang,
            timeZone: tz,
            initData,
          }),
        })
          .then((r) => r.json())
          .then((resp) => {
            if (resp?.countryLocked) {
              setCountryLockedInDb(true);
            }
            if (typeof resp?.marketCountry === 'string' && resp.marketCountry !== 'OTHER') {
              persistEntryCountry(resp.marketCountry);
              setSelectedCountry(resp.marketCountry);
            }
            if (typeof resp?.pppCoefficient === 'number' || typeof resp?.regionGroup === 'string') {
              setUser((prev) => {
                const updated: UserProfile = {
                  ...prev,
                  pppCoefficient:
                    typeof resp.pppCoefficient === 'number'
                      ? resp.pppCoefficient
                      : prev.pppCoefficient,
                  regionGroup:
                    typeof resp.regionGroup === 'string' ? resp.regionGroup : prev.regionGroup,
                };
                saveUserLocally(updated);
                return updated;
              });
            }
            return refreshAuthoritativeBalances();
          })
          .catch(() => {});
      }
    },
    [countryLockedInDb, selectedCountry, lang, refreshAuthoritativeBalances]
  );

  const handleRequestWithdrawal = useCallback(
    async (points: number, wallet: string, asset: string = 'TON'): Promise<WithdrawalResult> => {
      try {
        const initData = getTelegramInitData();
        const idempotencyKey = `wd_${user.telegramId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const res = await fetch('/api/payout/request', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(initData ? { 'X-Telegram-Init-Data': initData } : {}),
          },
          body: JSON.stringify({
            points,
            wallet_address: wallet,
            crypto_asset: asset,
            idempotencyKey,
            initData,
          }),
        });
        const responseData = await res.json().catch(() => ({}));
        if (!res.ok || !responseData?.ok) {
          return {
            ok: false,
            error: String(responseData?.error || `HTTP_${res.status}`),
            strikeRecord: responseData?.strikeRecord,
          };
        }
        await refreshAuthoritativeBalances();
        return { ok: true };
      } catch (e: any) {
        return {
          ok: false,
          error: e?.message || 'NETWORK_ERROR',
        };
      }
    },
    [user.telegramId, refreshAuthoritativeBalances]
  );

  const handleUpdateTransactionStatus = useCallback(
    async (
      txId: string,
      newStatus: 'APPROVED' | 'COMPLETED' | 'REJECTED',
      txHash?: string
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const res = await fetch('/api/payout/disburse', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(adminToken ? { 'X-Admin-Token': adminToken } : {}),
          },
          body: JSON.stringify({
            requestId: txId,
            status: newStatus,
            txHash,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
          const errMsg = String(data?.error || `HTTP_${res.status}`);
          return { ok: false, error: errMsg };
        }
      } catch (e: any) {
        return { ok: false, error: String(e?.message || 'NETWORK_ERROR') };
      }

      await refreshAuthoritativeBalances();
      return { ok: true };
    },
    [adminToken, refreshAuthoritativeBalances]
  );

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [currentTab]);

  // 1. PRIMA SCHERMATA: EntryVideoView (#000000)
  if (onboardingStep === 'video') {
    return (
      <EntryVideoView
        telegramUserId={user.telegramId}
        onComplete={() => setOnboardingStep('entry')}
      />
    );
  }

  // 2. SECONDA SCHERMATA: EntryView (#000000 neon, 14 lingue, avvio diretto)
  if (onboardingStep === 'entry') {
    return (
      <EntryView
        initialLang={lang}
        onStart={handleStartFromEntryView}
      />
    );
  }

  // 3. TERZA SCHERMATA: ProductTypeView (#000000 neon, Paese + Uomo/Donna + multi-scelta categorie)
  if (onboardingStep === 'productType') {
    return (
      <ProductTypeView
        initialCountry={selectedCountry}
        isCountryLocked={countryLockedInDb}
        onSelect={handleSelectProductType}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#05080f] text-white flex flex-col">
      <Header
        user={user}
        onOpenAdPlayer={() => setCurrentTab('wallet')}
        onOpenProfile={() => setCurrentTab('profile')}
        onSecretAdminUnlock={async () => {
          try {
            const initData = getTelegramInitData();
            const res = await fetch('/api/admin/verify', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(adminToken ? { 'X-Admin-Token': adminToken } : {}),
                ...(initData ? { 'X-Telegram-Init-Data': initData } : {}),
              },
              body: JSON.stringify({ initData }),
            });
            if (!res.ok) return;
            const data = await res.json().catch(() => ({}));
            if (!data?.isAdmin) return;
            setUser((prev) => ({ ...prev, role: 'admin' }));
            setCurrentTab('admin');
          } catch {
            // ignore
          }
        }}
      />

      <CyberNav
        current={currentTab}
        onSelect={(tab) => setCurrentTab(tab)}
        isAdmin={user.role === 'admin'}
      />

      <main className="flex-1 w-full max-w-2xl mx-auto px-2 pt-2 pb-8">
        <OfficialBanner />

        {currentTab === 'home' && (
          <HomeView
            user={user}
            userCountry={selectedCountry}
            onOpenAdPlayer={() => setCurrentTab('wallet')}
            onOpenPartnerModal={() => setOnboardingStep('productType')}
            onNavigateTab={(tab) => setCurrentTab(tab as CyberTab)}
            onOpenTonkeeperGuide={() => setCurrentTab('wallet')}
            onBalanceUpdated={() => void refreshAuthoritativeBalances()}
            autoSessionTriggerKey={autoSessionTriggerKey}
            selectedCategories={selectedCategories}
          />
        )}

        {currentTab === 'games_mobile' && (
          <GamesView
            user={user}
            userCountry={selectedCountry}
            lang={lang}
            subCategory="mobile"
            onBack={() => setCurrentTab('home')}
            onBalanceUpdated={() => void refreshAuthoritativeBalances()}
          />
        )}

        {currentTab === 'games_pc' && (
          <GamesView
            user={user}
            userCountry={selectedCountry}
            lang={lang}
            subCategory="pc"
            onBack={() => setCurrentTab('home')}
            onBalanceUpdated={() => void refreshAuthoritativeBalances()}
          />
        )}

        {currentTab === 'games' && (
          <GamesView
            user={user}
            userCountry={selectedCountry}
            lang={lang}
            subCategory="all"
            onBack={() => setCurrentTab('home')}
            onBalanceUpdated={() => void refreshAuthoritativeBalances()}
          />
        )}

        {currentTab === 'soap' && (
          <MicroDramaView
            user={user}
            userCountry={selectedCountry}
            subCategory="soap"
            onBack={() => setCurrentTab('home')}
            onBalanceUpdated={() => void refreshAuthoritativeBalances()}
          />
        )}

        {currentTab === 'video_clips' && (
          <MicroDramaView
            user={user}
            userCountry={selectedCountry}
            subCategory="video_clips"
            onBack={() => setCurrentTab('home')}
            onBalanceUpdated={() => void refreshAuthoritativeBalances()}
          />
        )}

        {currentTab === 'music' && (
          <MusicAudioView
            user={user}
            userCountry={selectedCountry}
            onBalanceUpdated={() => void refreshAuthoritativeBalances()}
            onBack={() => setCurrentTab('home')}
          />
        )}

        {currentTab === 'ai_voice' && (
          <AiWorkView
            user={user}
            userCountry={selectedCountry}
            lang={lang}
            subCategory="voice"
            onBack={() => setCurrentTab('home')}
            onBalanceUpdated={() => void refreshAuthoritativeBalances()}
          />
        )}

        {currentTab === 'ai_photo' && (
          <AiWorkView
            user={user}
            userCountry={selectedCountry}
            lang={lang}
            subCategory="photo"
            onBack={() => setCurrentTab('home')}
            onBalanceUpdated={() => void refreshAuthoritativeBalances()}
          />
        )}

        {currentTab === 'ai' && (
          <AiWorkView
            user={user}
            userCountry={selectedCountry}
            lang={lang}
            subCategory="all"
            onBack={() => setCurrentTab('home')}
            onBalanceUpdated={() => void refreshAuthoritativeBalances()}
          />
        )}

        {currentTab === 'ux_sites' && (
          <UxQaView
            user={user}
            userCountry={selectedCountry}
            subCategory="sites"
            onBalanceUpdated={() => void refreshAuthoritativeBalances()}
            onBack={() => setCurrentTab('home')}
          />
        )}

        {currentTab === 'ux_apps' && (
          <UxQaView
            user={user}
            userCountry={selectedCountry}
            subCategory="apps"
            onBalanceUpdated={() => void refreshAuthoritativeBalances()}
            onBack={() => setCurrentTab('home')}
          />
        )}

        {currentTab === 'surveys' && (
          <UxQaView
            user={user}
            userCountry={selectedCountry}
            subCategory="surveys"
            onBalanceUpdated={() => void refreshAuthoritativeBalances()}
            onBack={() => setCurrentTab('home')}
          />
        )}

        {currentTab === 'ux_qa' && (
          <UxQaView
            user={user}
            userCountry={selectedCountry}
            subCategory="all"
            onBalanceUpdated={() => void refreshAuthoritativeBalances()}
            onBack={() => setCurrentTab('home')}
          />
        )}

        {currentTab === 'ocr' && (
          <ReceiptOcrView
            user={user}
            userCountry={selectedCountry}
            onBalanceUpdated={() => void refreshAuthoritativeBalances()}
            onBack={() => setCurrentTab('home')}
          />
        )}

        {currentTab === 'depin' && (
          <DepinNodesView
            user={user}
            userCountry={selectedCountry}
            onBalanceUpdated={() => void refreshAuthoritativeBalances()}
            onBack={() => setCurrentTab('home')}
          />
        )}

        {currentTab === 'shopping' && <ShoppingView user={user} />}

        {currentTab === 'airdrop' && (
          <AirdropHubView
            user={user}
            userCountry={selectedCountry}
            onBack={() => setCurrentTab('home')}
          />
        )}

        {currentTab === 'wallet' && (
          <WithdrawView
            user={user}
            transactions={transactions}
            onRequestWithdrawal={handleRequestWithdrawal}
            onNavigateHome={() => setCurrentTab('home')}
          />
        )}

        {currentTab === 'profile' && (
          <ProfileView
            user={user}
            transactions={transactions}
            onOpenTonkeeperGuide={() => setCurrentTab('wallet')}
            onNavigateHome={() => setCurrentTab('home')}
            cloudAccountEmail={firebaseUser?.email || null}
            onSignInCloud={async () => {
              const cred = await signInWithPopup(auth, googleAuthProvider);
              if (cred.user?.uid && cred.user.emailVerified) {
                await upsertUserAccountInCloud(cred.user.uid, user);
              }
            }}
            onSignOutCloud={async () => {
              await signOut(auth);
            }}
          />
        )}

        {currentTab === 'admin' && user.role === 'admin' && (
          <AdminView
            transactions={transactions}
            adminToken={adminToken}
            onAdminTokenChange={setAdminToken}
            onNavigateHome={() => setCurrentTab('home')}
            onUpdateTransactionStatus={handleUpdateTransactionStatus}
          />
        )}
      </main>
    </div>
  );
};

export function App() {
  return (
    <LanguageProvider>
      <ActionFlowInner />
    </LanguageProvider>
  );
}

export default App;
