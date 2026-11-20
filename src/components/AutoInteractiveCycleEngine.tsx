// ============================================================================
// AUTO INTERACTIVE CYCLE ENGINE — Sessione Automatizzata Unica Prioritizzata
// ============================================================================
// Preserva integralmente l'esecuzione automatica delle attivita' (VIDEO, ADS,
// MUSIC, MICRO_DRAMA, GAME, SURVEY) registrando ogni interazione singolarmente
// su PostgreSQL (/api/auto-session/* e /api/interactions/register).
// Applica in tempo reale i 7 criteri di selezione fornitori (no-vincoli GEO,
// completamento veloce, postback rapido, ciclo pagamenti breve, completion rate,
// reputazione ACTIVE su DB, compatibilita GEO e convenienza economica). ZERO accrediti a tempo.
// ============================================================================

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Play,
  Pause,
  ShieldCheck,
  Layers,
  Sparkles,
  ExternalLink,
  RefreshCw,
  Globe,
  AlertTriangle,
} from 'lucide-react';
import {
  CycleStreamCategory,
  SupportedLang,
} from '../lib/entryProfile';
import {
  buildPrioritizedAutoCycleSteps,
  type CycleStepCandidate,
  type ProviderReputationSnapshot,
} from '../lib/providerPriority';
import {
  normalizeCountryCode,
  resolveCountryEconomicProfile,
} from '../lib/geoEconomics';
import { useTranslation } from '../lib/i18n';
import { EXTRA_UI_LOCALIZATION } from '../lib/providerLocalization';
import { openTrackedLink, resolveCanonicalProviderId } from '../lib/affiliate';
import { isSafeExternalHttpsUrl } from '../utils/navigation';
import { getTelegramInitData } from '../services/api';

export interface AutoInteractiveCycleEngineProps {
  autoStartTriggerKey?: number;
  selectedCategories?: string[];
  telegramUserId?: number;
  userCountry?: string;
  tierZone?: string;
  onExitFullScreen?: () => void;
  onBalanceUpdated?: () => void;
}

interface TrackedInteractionRow {
  interaction_id: string;
  click_id: string;
  provider_id: string;
  activity_category: string;
  task_id: string;
  status: string;
  user_pending_points: number;
  user_settled_points: number;
  clicked_at: string;
}

const CYCLE_CATEGORY_LABELS: Record<CycleStreamCategory, Record<SupportedLang, string>> = {
  HIGH_PAY_VIDEO: {
    it: 'Video CPM Diretto',
    en: 'Direct CPM Video',
    es: 'Video CPM Directo',
    fr: 'Vidéo CPM Directe',
    de: 'Direktes CPM-Video',
    pt: 'Vídeo CPM Direto',
    ru: 'Прямое CPM-видео',
    zh: '高单价直连视频',
    ja: 'ダイレクトCPM動画',
    ko: '직접 CPM 비디오',
    ar: 'فيديو CPM مباشر',
    hi: 'डायरेक्ट CPM वीडियो',
    tr: 'Doğrudan CPM Video',
    id: 'Video CPM Langsung',
  },
  SOAP_DRAMA: {
    it: 'Serie TV Breve',
    en: 'Short Drama Series',
    es: 'Serie Corta',
    fr: 'Mini-Série TV',
    de: 'Kurz-Dramaserie',
    pt: 'Minissérie',
    ru: 'Мини-сериал',
    zh: '精选短剧剧集',
    ja: 'ショートドラマ',
    ko: '숏폼 드라마 시리즈',
    ar: 'مسلسل قصير',
    hi: 'शॉर्ट ड्रामा सीरीज़',
    tr: 'Kısa Dizi Bölümü',
    id: 'Serial Drama Pendek',
  },
  TIKTOK_VIRAL: {
    it: 'Clip Breve Virale',
    en: 'Viral Short Clip',
    es: 'Clip Corto Viral',
    fr: 'Clip Court Viral',
    de: 'Viraler Kurzclip',
    pt: 'Clipe Curto Viral',
    ru: 'Короткий вирусный клип',
    zh: '热门短视频片段',
    ja: 'バイラルショート動画',
    ko: '바이럴 숏클립',
    ar: 'مقطع فيديو قصير',
    hi: 'वायरल शॉर्ट क्लिप',
    tr: 'Viral Kısa Klip',
    id: 'Klip Pendek Viral',
  },
  CINEMA_TRAILER: {
    it: 'Trailer Ufficiale',
    en: 'Official Trailer',
    es: 'Tráiler Oficial',
    fr: 'Bande-Annonce Officielle',
    de: 'Offizieller Trailer',
    pt: 'Trailer Oficial',
    ru: 'Официальный трейлер',
    zh: '官方影视预告片',
    ja: '公式映画トレーラー',
    ko: '공식 시네마 예고편',
    ar: 'إعلان تشويقي رسمي',
    hi: 'आधिकारिक सिनेमा ट्रेलर',
    tr: 'Resmi Sinema Fragmanı',
    id: 'Trailer Sinema Resmi',
  },
  MUSIC_HIT: {
    it: 'Ascolto Audio',
    en: 'Certified Audio Track',
    es: 'Pista de Audio',
    fr: 'Piste Audio Certifiée',
    de: 'Zertifizierter Audiotrack',
    pt: 'Faixa de Áudio',
    ru: 'Сертифицированный трек',
    zh: '认证音乐曲目',
    ja: '認証オーディオトラック',
    ko: '인증 오디오 트랙',
    ar: 'مقطع صوتي معتمد',
    hi: 'प्रमाणित ऑडियो ट्रैक',
    tr: 'Sertifikalı Ses Parçası',
    id: 'Trek Audio Tersertifikasi',
  },
  INTERACTIVE_ACTION: {
    it: 'Azione Interattiva S2S',
    en: 'Interactive S2S Action',
    es: 'Acción Interactiva S2S',
    fr: 'Action Interactive S2S',
    de: 'Interaktive S2S-Aktion',
    pt: 'Ação Interativa S2S',
    ru: 'Интерактивное S2S-задание',
    zh: 'S2S 互动验证任务',
    ja: 'S2Sインタラクティブタスク',
    ko: 'S2S 인터랙티브 액션',
    ar: 'نشاط تفاعلي S2S مباشر',
    hi: 'इंटरैक्टिव S2S टास्क',
    tr: 'Etkileşimli S2S Görevi',
    id: 'Aksi Interaktif S2S',
  },
};

const DEFAULT_CYCLE_STEPS: CycleStepCandidate[] = [
  {
    id: 'step_music_fountain',
    titles: {
      it: 'Ascolto Audio BTC Istantaneo',
      en: 'Instant Audio Listening (Lightning)',
      es: 'Escucha Audio BTC Instantánea',
      fr: 'Écoute Audio BTC Instantanée',
      de: 'Sofortiges Audio-Hören (Lightning)',
      pt: 'Áudio BTC Instantâneo',
      ru: 'Мгновенное аудио (Lightning)',
      zh: '即时音频收听 (Lightning)',
      ja: '即時オーディオ試聴 (Lightning)',
      ko: '즉시 오디오 청취 (Lightning)',
      ar: 'استماع صوتي فوري (Lightning)',
      hi: 'त्वरित ऑडियो सुनना (Lightning)',
      tr: 'Anında Ses Dinleme (Lightning)',
      id: 'Dengar Audio Instan (Lightning)',
    },
    category: 'MUSIC_HIT',
    activityCategory: 'MUSIC',
    providerId: 'fountain',
    providerLabel: 'Fountain.fm Direct',
    targetUrl: 'https://www.fountain.fm/',
    durationSec: 45,
    geoRegion: 'GLOBAL',
    actionDuration: '2 min',
    modalityBadge: 'Payout Istantaneo Lightning',
    payoutInfo: 'Istantaneo ($0 min) • Satoshi Diretti',
    currencies: 'BTC, USDT',
    userPoints: 30,
  },
  {
    id: 'step_vid_1',
    titles: {
      it: 'Spot Alto CPM Partner Diretto',
      en: 'High-CPM Direct Partner Video',
      es: 'Spot de Alto CPM de Socio Directo',
      fr: 'Spot Haut CPM Partenaire Direct',
      de: 'High-CPM Direktpartner-Spot',
      pt: 'Vídeo Alto CPM de Parceiro Direto',
      ru: 'Видео высокого CPM от прямого партнера',
      zh: '直连合作伙伴高单价视频',
      ja: 'ダイレクトパートナー高CPM動画',
      ko: '직접 파트너 고단가 CPM 비디오',
      ar: 'فيديو شريك مباشر عالي العائد CPM',
      hi: 'हाई-CPM डायरेक्ट पार्टनर वीडियो',
      tr: 'Yüksek CPM Doğrudan Ortak Videosu',
      id: 'Video Mitra Langsung CPM Tinggi',
    },
    category: 'HIGH_PAY_VIDEO',
    activityCategory: 'VIDEO',
    providerId: 'dramabox',
    providerLabel: 'DramaBox',
    targetUrl: 'https://www.dramabox.com/',
    durationSec: 45,
    geoRegion: 'GLOBAL',
    actionDuration: '2 min',
    modalityBadge: 'S2S Diretto',
    payoutInfo: 'Net-7 ($5) • $0.60-$2.50 CPA',
    currencies: 'USDT',
    userPoints: 30,
  },
  {
    id: 'step_viral_1',
    titles: {
      it: 'Clip Virale Sponsorizzata Diretta',
      en: 'Direct Sponsored Viral Clip',
      es: 'Clip Viral Patrocinado Directo',
      fr: 'Clip Viral Sponsorisé Direct',
      de: 'Direkt gesponserter viraler Clip',
      pt: 'Clipe Viral Patrocinado Direto',
      ru: 'Прямой спонсорский вирусный клип',
      zh: '官方赞助热门短视频',
      ja: 'ダイレクトスポンサー動画クリップ',
      ko: '직접 스폰서 바이럴 클립',
      ar: 'مقطع فيديو ترويجي مباشر',
      hi: 'डायरेक्ट स्पॉन्सर्ड वायरल क्लिप',
      tr: 'Doğrudan Sponsorlu Viral Klip',
      id: 'Klip Viral Sponsor Langsung',
    },
    category: 'TIKTOK_VIRAL',
    activityCategory: 'ADS',
    providerId: 'shorttv',
    providerLabel: 'ShortTV',
    targetUrl: 'https://www.shorttv.live/',
    durationSec: 45,
    geoRegion: 'GLOBAL',
    actionDuration: '2 min',
    modalityBadge: 'S2S Diretto',
    payoutInfo: 'Net-7 ($5) • Pagamento Diretto',
    currencies: 'USDT',
    userPoints: 30,
  },
  {
    id: 'step_cinema_1',
    titles: {
      it: 'Trailer Cinema Ufficiale',
      en: 'Official Cinema Trailer',
      es: 'Tráiler de Cine Oficial',
      fr: 'Bande-Annonce Cinéma Officielle',
      de: 'Offizieller Kino-Trailer',
      pt: 'Trailer de Cinema Oficial',
      ru: 'Официальный кинотрейлер',
      zh: '官方院线电影预告片',
      ja: '公式映画トレーラー',
      ko: '공식 시네마 예고편',
      ar: 'إعلان سينمائي رسمي',
      hi: 'आधिकारिक सिनेमा ट्रेलर',
      tr: 'Resmi Sinema Fragmanı',
      id: 'Trailer Sinema Resmi',
    },
    category: 'CINEMA_TRAILER',
    activityCategory: 'VIDEO',
    providerId: 'kalostv',
    providerLabel: 'Kalos TV',
    targetUrl: 'https://www.kalostv.com/',
    durationSec: 45,
    geoRegion: 'GLOBAL',
    actionDuration: '2 min',
    modalityBadge: 'S2S Diretto',
    payoutInfo: 'Net-7 ($10) • CPA Iniziale',
    currencies: 'USDT',
    userPoints: 30,
  },
  {
    id: 'step_soap_1',
    titles: {
      it: 'Micro-Drama Episodio Pilota',
      en: 'Micro-Drama Pilot Episode',
      es: 'Episodio Piloto de Micro-Drama',
      fr: 'Épisode Pilote de Micro-Drame',
      de: 'Mikro-Drama Pilotfolge',
      pt: 'Episódio Piloto de Micro-Drama',
      ru: 'Пилотный эпизод мини-драмы',
      zh: '精选微短剧首播剧集',
      ja: 'マイクロドラマ第1話エピソード',
      ko: '마이크로 드라마 파일럿 에피소드',
      ar: 'حلقة تجريبية من المسلسل القصير',
      hi: 'माइक्रो-ड्रामा पायलट एपिसोड',
      tr: 'Mikro-Drama Pilot Bölümü',
      id: 'Episode Pilot Mikro-Drama',
    },
    category: 'SOAP_DRAMA',
    activityCategory: 'MICRO_DRAMA',
    providerId: 'reelshort',
    providerLabel: 'ReelShort',
    targetUrl: 'https://www.reelshort.com/',
    durationSec: 45,
    geoRegion: 'GLOBAL',
    actionDuration: '3 min',
    modalityBadge: 'S2S Diretto',
    payoutInfo: 'Net-7 ($10) • $0.50-$2.00 CPA',
    currencies: 'USDT',
    userPoints: 30,
  },
  {
    id: 'step_music_1',
    titles: {
      it: 'Traccia Audio Certificata Web3',
      en: 'Certified Audio Track Review',
      es: 'Pista de Audio Certificada',
      fr: 'Écoute de Piste Audio Certifiée',
      de: 'Zertifizierter Audiotrack',
      pt: 'Faixa de Áudio Certificada',
      ru: 'Прослушивание сертифицированного трека',
      zh: '官方认证音频曲目试听',
      ja: '認証オーディオトラック試聴',
      ko: '인증 오디오 트랙 감상',
      ar: 'مقطع صوتي معتمد للاستماع',
      hi: 'प्रमाणित ऑडियो ट्रैक',
      tr: 'Sertifikalı Ses Parçası Dinleme',
      id: 'Trek Audio Tersertifikasi',
    },
    category: 'MUSIC_HIT',
    activityCategory: 'MUSIC',
    providerId: 'submithub',
    providerLabel: 'Audius / SubmitHub',
    targetUrl: 'https://audius.co/',
    durationSec: 45,
    geoRegion: 'GLOBAL',
    actionDuration: '3 min',
    modalityBadge: 'Web3 API Diretta',
    payoutInfo: 'Settimanale ($0 min) • $1-$5 Bonus',
    currencies: 'SOL, USDT, AUDIO',
    userPoints: 30,
  },
  {
    id: 'step_action_premise',
    titles: {
      it: 'Micro-Audit & Scontrini Diretti BTC',
      en: 'Direct Micro-Audit & Receipts BTC',
      es: 'Micro-Auditoría y Recibos BTC',
      fr: 'Micro-Audit & Reçus Directs BTC',
      de: 'Direkte Mikro-Audits & Belege BTC',
      pt: 'Micro-Auditoria e Recibos BTC',
      ru: 'Прямой микро-аудит и чеки BTC',
      zh: '直连微审计与小票任务 BTC',
      ja: 'ダイレクト・マイクロ監査 BTC',
      ko: '직접 마이크로 감사 및 영수증 BTC',
      ar: 'تدقيق مصغر وإيصالات مباشرة BTC',
      hi: 'डायरेक्ट माइक्रो-ऑडिट और रसीद BTC',
      tr: 'Doğrudan Mikro Denetim ve Fiş BTC',
      id: 'Mikro-Audit & Struk Langsung BTC',
    },
    category: 'INTERACTIVE_ACTION',
    activityCategory: 'RECEIPT',
    providerId: 'premise',
    providerLabel: 'Premise Data Direct (BTC)',
    targetUrl: 'https://www.premise.com/contributors/',
    durationSec: 45,
    geoRegion: 'GLOBAL',
    actionDuration: '2 min',
    modalityBadge: 'Payout Diretto BTC',
    payoutInfo: 'Istantaneo ($5 min) • Bitcoin (BTC)',
    currencies: 'BTC',
    userPoints: 30,
  },
  {
    id: 'step_action_1',
    titles: {
      it: 'Task Interattivo S2S Diretto',
      en: 'Direct S2S Interactive Task',
      es: 'Tarea Interactiva S2S Directa',
      fr: 'Tâche Interactive S2S Directe',
      de: 'Direkte interaktive S2S-Aufgabe',
      pt: 'Tarefa Interativa S2S Direta',
      ru: 'Прямое интерактивное S2S-задание',
      zh: 'S2S 直连互动任务',
      ja: 'ダイレクトS2Sインタラクティブタスク',
      ko: '직접 S2S 인터랙티브 과제',
      ar: 'مهمة تفاعلية S2S مباشرة',
      hi: 'डायरेक्ट S2S इंटरैक्टिव टास्क',
      tr: 'Doğrudan S2S Etkileşimli Görev',
      id: 'Tugas Interaktif S2S Langsung',
    },
    category: 'INTERACTIVE_ACTION',
    activityCategory: 'GAME',
    providerId: 'plarium',
    providerLabel: 'Plarium / Web3 Arcade',
    targetUrl: 'https://plarium.com/',
    durationSec: 45,
    geoRegion: 'GLOBAL',
    actionDuration: '5 min',
    modalityBadge: 'S2S Diretto',
    payoutInfo: 'Net-15 ($50) • $4-$18 CPA',
    currencies: 'USDT, BTC',
    userPoints: 30,
  },
];

export const AutoInteractiveCycleEngine: React.FC<AutoInteractiveCycleEngineProps> = ({
  autoStartTriggerKey = 1,
  selectedCategories = ['videos', 'games', 'interactions'],
  telegramUserId = 0,
  userCountry = 'IT',
  tierZone,
  onExitFullScreen,
  onBalanceUpdated,
}) => {
  const { t, lang } = useTranslation();
  const extra = EXTRA_UI_LOCALIZATION[lang] || EXTRA_UI_LOCALIZATION.en;

  const normalizedCountry = normalizeCountryCode(userCountry);
  const countryProfile = resolveCountryEconomicProfile(normalizedCountry);
  const resolvedZone = tierZone || countryProfile.tierZone;
  const pppCoef = countryProfile.pppCoefficient;

  const [stepIndex, setStepIndex] = useState(0);
  const [stepElapsed, setStepElapsed] = useState(0);
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<string>('IDLE');
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [interactions, setInteractions] = useState<TrackedInteractionRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [reputationMap, setReputationMap] = useState<Record<string, ProviderReputationSnapshot>>({});
  const [reputationSource, setReputationSource] = useState<'LOADING' | 'POSTGRES' | 'CATALOG'>('LOADING');
  const [authorizedProviderIds, setAuthorizedProviderIds] = useState<ReadonlySet<string> | null>(null);
  const [balances, setBalances] = useState({
    pending_points: 0,
    settled_points: 0,
    withdrawable_points: 0,
  });
  const autoStartedSessionRef = useRef<string | null>(null);

  // Carica mappa reputazione live e whitelist provider attivi (escludendo QUARANTINE / BANNED)
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/providers/prioritized?country=${encodeURIComponent(normalizedCountry)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.ok) {
          setReputationSource(data.reputationSource === 'POSTGRES' ? 'POSTGRES' : 'CATALOG');
          if (data.reputationMap && typeof data.reputationMap === 'object') {
            setReputationMap(data.reputationMap);
          }
          if (Array.isArray(data.providers)) {
            const authIds = new Set<string>();
            for (const p of data.providers) {
              const rawId = String(p?.id || '').trim().toLowerCase();
              if (!rawId) continue;
              authIds.add(rawId);
              authIds.add(resolveCanonicalProviderId(rawId));
            }
            setAuthorizedProviderIds(authIds);
          } else {
            setAuthorizedProviderIds(new Set());
          }
        } else {
          setReputationSource('POSTGRES');
          setAuthorizedProviderIds(new Set());
        }
      })
      .catch(() => {
        if (!cancelled) {
          setReputationSource('POSTGRES');
          setAuthorizedProviderIds(new Set());
        }
      });
    return () => {
      cancelled = true;
    };
  }, [normalizedCountry]);

  const activePlaylist = useMemo(() => {
    if (reputationSource === 'LOADING') return [];
    return buildPrioritizedAutoCycleSteps(
      DEFAULT_CYCLE_STEPS,
      selectedCategories,
      normalizedCountry,
      reputationMap,
      {
        requireRegisteredReputation: reputationSource === 'POSTGRES',
        authorizedProviderIds,
      }
    );
  }, [selectedCategories, normalizedCountry, reputationMap, reputationSource, authorizedProviderIds]);

  const currentStep =
    activePlaylist.length > 0 ? activePlaylist[stepIndex % activePlaylist.length] : undefined;

  const syncAutoSessionState = useCallback(async (sid?: string | null) => {
    const initData = getTelegramInitData();
    if (!initData) {
      setSessionActive(false);
      setRunning(false);
      return;
    }

    try {
      const qs = sid ? `?sessionId=${encodeURIComponent(sid)}` : '';
      const res = await fetch(`/api/auto-session/status${qs}`, {
        headers: { 'X-Telegram-Init-Data': initData },
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          setSessionActive(false);
          setRunning(false);
          setSessionStatus('REVOKED');
        }
        return;
      }
      const data = await res.json();
      if (data?.session?.session_id) {
        const nextStatus = String(data.session.status || 'UNKNOWN');
        const activeNow = nextStatus === 'ACTIVE';
        setSessionId(data.session.session_id);
        setSessionStatus(nextStatus);
        setSessionActive(activeNow);
        if (!activeNow) {
          setRunning(false);
          setSessionError(`SESSION_${nextStatus}`);
        }
      } else {
        setSessionActive(false);
        setRunning(false);
      }
      if (Array.isArray(data?.interactions)) {
        setInteractions(data.interactions);
      }
      if (data?.counts) {
        setCounts(data.counts);
      }
      if (data?.balances) {
        setBalances({
          pending_points: Number(data.balances.pending_points || 0),
          settled_points: Number(data.balances.settled_points || 0),
          withdrawable_points: Number(data.balances.withdrawable_points || 0),
        });
      }
      if (onBalanceUpdated) onBalanceUpdated();
    } catch {
      // Non-blocking polling
    }
  }, [onBalanceUpdated]);

  // Avvia la sessione automatizzata unica su PostgreSQL (nessuna scadenza 10/20/30m, 0 crediti da timer)
  useEffect(() => {
    let cancelled = false;
    const initData = getTelegramInitData();
    if (!initData) {
      setSessionActive(false);
      setRunning(false);
      setSessionStatus('AUTH_REQUIRED');
      setSessionError('TELEGRAM_INIT_DATA_REQUIRED');
      return;
    }

    fetch('/api/auto-session/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify({
        categories: selectedCategories,
        country: normalizedCountry,
        lang,
        initData,
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.ok && data?.session?.session_id) {
          const nextStatus = String(data.session.status || 'ACTIVE');
          const activeNow = nextStatus === 'ACTIVE';
          setSessionId(data.session.session_id);
          setSessionStatus(nextStatus);
          setSessionActive(activeNow);
          setSessionError(activeNow ? null : `SESSION_${nextStatus}`);
          if (Array.isArray(data.interactions)) setInteractions(data.interactions);
          if (data.counts) setCounts(data.counts);
          if (data.balances) {
            setBalances({
              pending_points: Number(data.balances.pending_points || 0),
              settled_points: Number(data.balances.settled_points || 0),
              withdrawable_points: Number(data.balances.withdrawable_points || 0),
            });
          }
        } else {
          setSessionActive(false);
          setRunning(false);
          setSessionStatus('BLOCKED');
          setSessionError(String(data?.error || 'AUTO_SESSION_UNAVAILABLE'));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSessionActive(false);
          setRunning(false);
          setSessionStatus('OFFLINE');
          setSessionError('AUTO_SESSION_NETWORK_ERROR');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [autoStartTriggerKey, selectedCategories, normalizedCountry, lang]);

  // Fail-closed: il motore ruota solo con sessione ACTIVE e almeno una campagna autorizzata
  useEffect(() => {
    if (
      sessionActive &&
      sessionId &&
      activePlaylist.length > 0 &&
      autoStartedSessionRef.current !== sessionId
    ) {
      autoStartedSessionRef.current = sessionId;
      setRunning(true);
    } else if (!sessionActive || activePlaylist.length === 0) {
      setRunning(false);
    }
  }, [sessionActive, sessionId, activePlaylist.length]);

  // Polling periodico stato postback partner reali da PostgreSQL
  useEffect(() => {
    if (!sessionId) return;
    const poll = setInterval(() => {
      void syncAutoSessionState(sessionId);
    }, 15000);
    return () => clearInterval(poll);
  }, [sessionId, syncAutoSessionState]);

  // Rotazione automatica visuale delle attivita' nella coda (solo UI stepper, ZERO crediti temporali)
  useEffect(() => {
    if (!running || !sessionActive || !currentStep || activePlaylist.length === 0) return;
    const timer = setInterval(() => {
      setStepElapsed((prev) => {
        if (prev + 1 >= currentStep.durationSec) {
          setStepIndex((idx) => (idx + 1) % Math.max(1, activePlaylist.length));
          return 0;
        }
        return prev + 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [running, sessionActive, currentStep, activePlaylist.length]);

  const handleLaunchInteraction = () => {
    if (!sessionActive || !sessionId || !currentStep) return;
    if (!isSafeExternalHttpsUrl(currentStep.targetUrl)) return;
    openTrackedLink(currentStep.targetUrl, {
      partnerId: currentStep.canonicalProviderId || currentStep.providerId,
      taskId: currentStep.id,
      activityCategory: currentStep.activityCategory,
      sessionId,
      telegramId: telegramUserId,
      kind: 'TASK',
    });
    setTimeout(() => {
      void syncAutoSessionState(sessionId);
    }, 1000);
  };

  const progressPct = currentStep
    ? Math.min(100, Math.round((stepElapsed / Math.max(1, currentStep.durationSec)) * 100))
    : 0;

  const localizedStepTitle =
    currentStep?.titles[lang] || currentStep?.titles.en || currentStep?.titles.it || '';
  const localizedCategoryLabel = currentStep
    ? CYCLE_CATEGORY_LABELS[currentStep.category]?.[lang] ||
      CYCLE_CATEGORY_LABELS[currentStep.category]?.en ||
      currentStep.category
    : '';

  return (
    <div className="glass-panel rounded-2xl p-4 space-y-3 border border-emerald-500/25">
      {/* Header Sessione Automatizzata Unica */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-emerald-400" />
          <span className="text-xs font-black uppercase tracking-wider text-emerald-300">
            Sessione Automatizzata Unica
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-sky-500/15 border border-sky-400/30 text-[10px] font-mono font-bold text-sky-200">
            <Globe className="w-3 h-3" /> {normalizedCountry} • {resolvedZone} • PPP x{pppCoef.toFixed(2)}
          </span>
          {sessionActive && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/20 text-[10px] font-mono font-bold text-emerald-300">
              <ShieldCheck className="w-3 h-3" /> {extra.s2sDirectBadge}
            </span>
          )}
          <button
            type="button"
            onClick={() => void syncAutoSessionState(sessionId)}
            className="p-1.5 rounded-lg bg-slate-800/80 border border-white/10 text-sky-300 hover:text-white cursor-pointer"
            title="Aggiorna da PostgreSQL"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Stati Reali PostgreSQL delle Interazioni & Saldi */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl bg-[#0B1324] border border-white/10 p-2 text-center">
          <div className="text-[9px] font-mono uppercase text-slate-400">Click Registrati</div>
          <div className="text-xs font-black font-mono text-sky-300">
            {(counts.CLICK_REGISTERED || 0) +
              (counts.POSTBACK_CONFIRMED_PENDING || 0) +
              (counts.SETTLED || 0)}
          </div>
        </div>
        <div className="rounded-xl bg-amber-950/40 border border-amber-400/35 p-2 text-center">
          <div className="text-[9px] font-mono uppercase text-amber-300">In Attesa (S2S)</div>
          <div className="text-xs font-black font-mono text-amber-300">
            {balances.pending_points + balances.settled_points} PT
          </div>
        </div>
        <div className="rounded-xl bg-emerald-950/45 border border-emerald-400/40 p-2 text-center">
          <div className="text-[9px] font-mono uppercase text-emerald-300">Prelevabili</div>
          <div className="text-xs font-black font-mono text-emerald-300">
            {balances.withdrawable_points} PT
          </div>
        </div>
      </div>

      {/* Attività Corrente del Ciclo Prioritizzato (Fail-Closed se non attiva o senza campagne) */}
      {(!sessionActive || activePlaylist.length === 0) ? (
        <div className="rounded-xl bg-amber-950/40 border border-amber-400/35 p-3 flex items-start gap-2 text-xs text-amber-200">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <div className="font-black uppercase tracking-wide text-[11px]">
              Motore in attesa di autorizzazione backend ({sessionStatus})
            </div>
            <div className="text-[11px] font-mono text-amber-200/80">
              {reputationSource === 'LOADING'
                ? 'Verifica reputazione fornitori e campagne attive in corso...'
                : activePlaylist.length === 0
                ? 'Nessuna campagna attiva/autorizzata compatibile trovata per il Paese o le categorie selezionate.'
                : sessionError || 'Sessione automatica non attiva o revocata su PostgreSQL.'}
            </div>
          </div>
        </div>
      ) : (
        currentStep && (
          <div className="rounded-xl bg-[#0A1326] border border-sky-400/20 p-2.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Layers className="w-4 h-4 text-sky-400 shrink-0" />
              <div className="min-w-0">
                <div className="text-xs font-black text-white truncate">{localizedStepTitle}</div>
                <div className="text-[10px] font-mono text-slate-400 truncate">
                  {currentStep.providerLabel} • {localizedCategoryLabel}
                </div>
                <div className="text-[9px] font-mono text-emerald-300/90 truncate">
                  {currentStep.noRestriction ? 'GLOBAL (No-Tier)' : currentStep.geoRegion} • ~{currentStep.estimatedMinutes} min
                  {typeof currentStep.completionRate === 'number'
                    ? ` • ${(currentStep.completionRate * 100).toFixed(0)}% OK`
                    : ''}{' '}
                  • {currentStep.payoutInfo || 'S2S Verificato'}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={handleLaunchInteraction}
              disabled={!sessionActive || !currentStep}
              className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-sky-500 to-cyan-400 text-slate-950 text-[10px] font-black uppercase cursor-pointer active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span>Esegui</span>
              <ExternalLink className="w-3 h-3" />
            </button>
          </div>
        )
      )}

      {/* Barra Rotazione Attivita' (solo visiva, zero crediti a tempo) */}
      <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-sky-400 to-cyan-400 transition-all"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Ultime Interazioni Registrate in PostgreSQL */}
      {interactions.length > 0 && (
        <div className="space-y-1 max-h-24 overflow-y-auto pr-1">
          {interactions.slice(0, 4).map((item) => (
            <div
              key={item.interaction_id}
              className="flex items-center justify-between text-[10px] font-mono bg-[#060d1c] border border-white/10 rounded-lg px-2 py-1"
            >
              <span className="text-slate-300 truncate max-w-[45%]">
                {item.provider_id} • {item.activity_category}
              </span>
              <span
                className={`font-black ${
                  item.status === 'SETTLED'
                    ? 'text-emerald-400'
                    : item.status === 'POSTBACK_CONFIRMED_PENDING'
                    ? 'text-amber-300'
                    : item.status === 'REVOKED'
                    ? 'text-red-400'
                    : 'text-sky-300'
                }`}
              >
                {item.status}
                {item.user_pending_points > 0 ? ` (+${item.user_pending_points} PT)` : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => {
            if (sessionActive && activePlaylist.length > 0) setRunning((r) => !r);
          }}
          disabled={!sessionActive || activePlaylist.length === 0}
          className="flex-1 py-2.5 px-3 rounded-xl bg-sky-500/20 border border-sky-400/30 text-xs font-black uppercase text-white flex items-center justify-center gap-1.5 cursor-pointer active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {running ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          <span>{running ? t.ui.pauseBtn : t.ui.resumeBtn}</span>
        </button>
        <button
          type="button"
          onClick={() => {
            if (!sessionActive || activePlaylist.length === 0) return;
            setStepIndex((idx) => (idx + 1) % Math.max(1, activePlaylist.length));
            setStepElapsed(0);
          }}
          disabled={!sessionActive || activePlaylist.length === 0}
          className="py-2.5 px-3 rounded-xl bg-slate-800/80 border border-white/10 text-xs font-black uppercase text-sky-300 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Prossima
        </button>
        {onExitFullScreen && (
          <button
            type="button"
            onClick={onExitFullScreen}
            className="py-2.5 px-4 rounded-xl bg-slate-800 text-xs font-black uppercase text-slate-300 cursor-pointer"
          >
            {t.ui.backBtn}
          </button>
        )}
      </div>
    </div>
  );
};

export default AutoInteractiveCycleEngine;
