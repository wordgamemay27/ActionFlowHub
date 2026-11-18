// ============================================================================
// LINGUE SUPPORTATE - Condivise tra frontend, backend e test
// ============================================================================

export type SupportedLang =
  | 'it'
  | 'en'
  | 'es'
  | 'fr'
  | 'de'
  | 'pt'
  | 'ru'
  | 'ar'
  | 'tr'
  | 'hi'
  | 'zh'
  | 'ja'
  | 'ko'
  | 'id';

export const SUPPORTED_LANGS: SupportedLang[] = [
  'it',
  'en',
  'es',
  'fr',
  'de',
  'pt',
  'ru',
  'zh',
  'ja',
  'ko',
  'ar',
  'hi',
  'tr',
  'id',
];

export const LANG_META: Record<SupportedLang, { nativeName: string; flag: string }> = {
  it: { nativeName: 'Italiano', flag: '🇮🇹' },
  en: { nativeName: 'English', flag: '🇬🇧' },
  es: { nativeName: 'Español', flag: '🇪🇸' },
  fr: { nativeName: 'Français', flag: '🇫🇷' },
  de: { nativeName: 'Deutsch', flag: '🇩🇪' },
  pt: { nativeName: 'Português', flag: '🇵🇹' },
  ru: { nativeName: 'Русский', flag: '🇷🇺' },
  zh: { nativeName: '中文', flag: '🇨🇳' },
  ja: { nativeName: '日本語', flag: '🇯🇵' },
  ko: { nativeName: '한국어', flag: '🇰🇷' },
  ar: { nativeName: 'العربية', flag: '🇸🇦' },
  hi: { nativeName: 'हिन्दी', flag: '🇮🇳' },
  tr: { nativeName: 'Türkçe', flag: '🇹🇷' },
  id: { nativeName: 'Bahasa Indonesia', flag: '🇮🇩' },
};
