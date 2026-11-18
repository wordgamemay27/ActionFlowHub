// ============================================================================
// TIPI CATALOGO FORNITORI - Tipi condivisi per catalogo e pagine
// ============================================================================

export type DurationBucket = 'FAST' | 'MEDIUM' | 'LONG';

export interface ProjectCardData {
  id: string;
  pageId: RobotTargetCategory;
  durationBucket: DurationBucket;
  mailToUse: string;
  photoUrl: string;
  executionType: TaskExecutionType;
  unlocksHalfStep?: boolean;
  providerName?: string;
  directProviderUrl?: string;
  executionTime?: string;
  confirmationTime?: string;
  title: Record<BaseLang, string>;
  shortBrief: Record<BaseLang, string>;
  actions: ProjectActionItem[];
}

export interface ProjectActionItem {
  label: Record<BaseLang, string>;
  points: number;
  actionPhotoUrl?: string;
}

export type TaskExecutionType =
  | 'IN_APP_CAMERA_VIDEO'
  | 'IN_APP_VOICE_MIC'
  | 'IN_APP_RECEIPT_PHOTO'
  | 'DIRECT_GAME_PARTNER'
  | 'DIRECT_SAAS_PARTNER'
  | 'DIRECT_TELEGRAM_PARTNER'
  | 'DIRECT_VIP18_PARTNER'
  | 'DIRECT_PRO_MID_PARTNER'
  | 'DIRECT_PRO_HIGH_PARTNER';

export type RobotTargetCategory =
  | 'page_games_ladder'
  | 'page_playtime'
  | 'page_ai_work'
  | 'page_software_saas'
  | 'page_bots_youtuber'
  | 'page_vip_18'
  | 'pro_mid_pay'
  | 'pro_high_pay'
  | 'media_audio_vr';

export type BaseLang = 'it' | 'en' | 'es' | 'fr' | 'de' | 'pt';
export type SupportedLang = BaseLang | 'ru' | 'ar' | 'tr' | 'hi' | 'zh' | 'ja' | 'ko' | 'id';

export interface VerifiedProviderItem {
  id: string;
  name: string;
  directUrl: string;
  executionTimeLabel: string;
  confirmationTimeLabel: string;
  points1xRangeLabel: string;
  cryptoPayoutInfo: string;
}

export interface LocationSectionMeta {
  id: RobotTargetCategory;
  mailDomain: string;
  mailUrl: string;
  coverPhoto: string;
  pointsRangeLabel: string;
  verifiedProviders?: VerifiedProviderItem[];
  title: Record<BaseLang, string>;
  shortDescription: Record<BaseLang, string>;
}

export interface DailyThresholdTaskSlot {
  slotId: string;
  cleanTitle: string;
  project: ProjectCardData;
  action: ProjectActionItem;
  actionIdx: number;
  basePoints1x: number;
}

export interface AirdropCampaignItem {
  id: string;
  title: string;
  officialLogoUrl: string;
  masterRefLink: string;
  monetizationType: 'DIRECT_LISTING' | 'CPA_S2S' | 'REF_SHARE' | 'AD_GATED';
  s2sPostbackUrl: string;
  isCertified: boolean;
  description?: string;
}
