// ============================================================================
// ENTRY PROFILE — Lingua, Preferenze, Durata, Ricompense, Reset giornaliero.
// ============================================================================
// Modulo PURO (nessun import di React, nessun accesso al DOM all'import):
// puo' essere usato dal frontend, dal server Express, dai worker e dai test.
//
// Regole di prodotto:
//  - Modalità operativa unica: sessione automatizzata continua UNIFIED_AUTO
//    (nessun timer 10/20/30m e nessun premio a tempo).
//  - Scala contabile unica: 100 PT = $1.00 USD (0.01 USD/PT); quota utente 30% /
//    piattaforma 70% contabilizzata su PostgreSQL solo dopo postback verificato.
//  - Il reset giornaliero segue il fuso orario IANA dell'utente su PostgreSQL.
// ============================================================================

import { SUPPORTED_LANGS, type SupportedLang } from './langs';

export type { SupportedLang };
export { SUPPORTED_LANGS };

/* ========================================================================== *
 * 1. CATEGORIE DI INGRESSO -> CATEGORIE DEL CICLO AUTOMATICO
 * ========================================================================== */

export type EntryCategoryId =
  | 'videos'
  | 'games'
  | 'interactions'
  | 'surveys'
  | 'shopping'
  | 'ai_tasks'
  | 'audio'
  | 'receipts'
  | 'telegram'
  | 'airdrops';

/** Categorie usate dal ciclo automatico (AutoInteractiveCycleEngine). */
export type CycleStreamCategory =
  | 'HIGH_PAY_VIDEO'
  | 'SOAP_DRAMA'
  | 'TIKTOK_VIRAL'
  | 'CINEMA_TRAILER'
  | 'MUSIC_HIT'
  | 'INTERACTIVE_ACTION';

export interface EntryCategoryDef {
  id: EntryCategoryId;
  icon: string;
}

export const ENTRY_CATEGORIES: EntryCategoryDef[] = [
  { id: 'videos', icon: '🎬' },
  { id: 'games', icon: '🎮' },
  { id: 'interactions', icon: '🤝' },
  { id: 'surveys', icon: '📝' },
  { id: 'shopping', icon: '🛍️' },
  { id: 'ai_tasks', icon: '🤖' },
  { id: 'audio', icon: '🎧' },
  { id: 'receipts', icon: '🧾' },
  { id: 'telegram', icon: '✈️' },
  { id: 'airdrops', icon: '🪂' },
];

export const ENTRY_CATEGORY_IDS: EntryCategoryId[] = ENTRY_CATEGORIES.map((c) => c.id);

/**
 * Ogni categoria proposta all'utente mappa su almeno una categoria del ciclo:
 * la scelta fatta in onboarding filtra davvero i contenuti proposti.
 */
export const CATEGORY_STREAM_MAP: Record<EntryCategoryId, CycleStreamCategory[]> = {
  videos: ['HIGH_PAY_VIDEO', 'TIKTOK_VIRAL', 'SOAP_DRAMA', 'CINEMA_TRAILER'],
  games: ['INTERACTIVE_ACTION'],
  interactions: ['INTERACTIVE_ACTION'],
  surveys: ['INTERACTIVE_ACTION'],
  shopping: ['HIGH_PAY_VIDEO', 'TIKTOK_VIRAL'],
  ai_tasks: ['INTERACTIVE_ACTION'],
  audio: ['MUSIC_HIT'],
  receipts: ['INTERACTIVE_ACTION'],
  telegram: ['INTERACTIVE_ACTION'],
  airdrops: ['TIKTOK_VIRAL', 'CINEMA_TRAILER'],
};

/**
 * Filtra la playlist del ciclo automatico sulle categorie scelte dall'utente.
 * Se le preferenze non corrispondono a nessun contenuto (o sono vuote) la
 * playlist resta completa: il ciclo automatico non deve mai restare vuoto.
 */
export function filterStepsByCategories<T extends { category: CycleStreamCategory }>(
  steps: T[],
  selected: string[] | null | undefined
): T[] {
  const valid = (selected || []).filter(
    (id): id is EntryCategoryId => ENTRY_CATEGORY_IDS.indexOf(id as EntryCategoryId) !== -1
  );
  if (valid.length === 0) return steps;

  const allowed = new Set<CycleStreamCategory>();
  valid.forEach((id) => (CATEGORY_STREAM_MAP[id] || []).forEach((c) => allowed.add(c)));
  if (allowed.size === 0) return steps;

  const filtered = steps.filter((s) => allowed.has(s.category));
  return filtered.length > 0 ? filtered : steps;
}

/* ========================================================================== *
 * 2. SESSIONE AUTOMATIZZATA UNICA (NESSUNA DURATA FISSA 10/20/30m)
 * ========================================================================== */

export const UNIFIED_SESSION_MODE = 'UNIFIED_AUTO' as const;

/* ========================================================================== *
 * 3. REGOLA INTERNA QUOTA 30% SU CONFERMA FORNITORE
 *    Scala punti contabile: 100 PT = 1,00 $ USD (nessun accredito automatico)
 * ========================================================================== */

export const USER_ACTION_SHARE_PERCENT = 30;
export const PLATFORM_ACTION_SHARE_PERCENT = 70;
export const POINTS_PER_USDT_UNIT = 100;

/** Calcola la stima utente (fino al 30% * coefficiente PPP Banca Mondiale); il credito reale nasce solo su PostgreSQL da postback verificato. */
export function computeVerifiedUserSharePoints(grossUsdt: number, pppCoefficient = 1.0): number {
  const safeGross = Math.max(0, Number(grossUsdt) || 0);
  const safeCoef = Math.min(1.0, Math.max(0.01, Number(pppCoefficient) || 1.0));
  return Math.floor(safeGross * 0.30 * POINTS_PER_USDT_UNIT * safeCoef);
}

/* ========================================================================== *
 * 4. FUSO ORARIO, GIORNO LOCALE E RESET GIORNALIERO
 * ========================================================================== */

const SUPPORTED_TIMEZONES: Set<string> = (() => {
  try {
    const list =
      typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    return new Set<string>([...(list as string[]), 'UTC']);
  } catch {
    return new Set<string>(['UTC']);
  }
})();

/** Verifica che il fuso orario sia una zona reale (evita injection e crash lato DB). */
export function isValidTimeZone(timeZone: unknown): boolean {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  if (SUPPORTED_TIMEZONES.size > 1) return SUPPORTED_TIMEZONES.has(timeZone);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Fuso orario valido oppure 'UTC'. */
export function normalizeTimeZone(timeZone: unknown): string {
  return isValidTimeZone(timeZone) ? (timeZone as string) : 'UTC';
}

/**
 * Data locale (YYYY-MM-DD) dell'istante indicato, nel fuso dell'utente.
 * E' la base del reset giornaliero: lo stesso istante ha date diverse a Tokyo
 * e a Los Angeles, quindi il bonus si azzera al mezzanotte locale dell'utente.
 */
export function localDateKey(nowMs: number, timeZone: unknown): string {
  const tz = normalizeTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(Number(nowMs) || 0));
  const get = (type: string) => (parts.find((p) => p.type === type) || { value: '' }).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Il giorno locale e' avanzato rispetto all'ultimo reset? */
export function shouldResetDaily(lastResetDate: string | null | undefined, todayKey: string): boolean {
  if (!lastResetDate) return true;
  return String(todayKey) > String(lastResetDate);
}

/* ========================================================================== *
 * 5. LINGUA: PERSISTENZA E TESTI DEL FLUSSO D'INGRESSO
 * ========================================================================== */

export const ENTRY_LANG_STORAGE_KEY = 'gf_user_lang_manual';
export const ENTRY_LANG_ACTIVE_KEY = 'gf_user_lang';

export interface EntryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): EntryStorage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Salva la lingua scelta. Le lingue non supportate vengono scartate. */
export function persistEntryLanguage(lang: SupportedLang, storage: EntryStorage | null = defaultStorage()): void {
  if (!storage) return;
  if (SUPPORTED_LANGS.indexOf(lang) === -1) return;
  storage.setItem(ENTRY_LANG_STORAGE_KEY, lang);
  storage.setItem(ENTRY_LANG_ACTIVE_KEY, lang);
}

/** Rilegge la lingua salvata (default 'it'). */
export function readEntryLanguage(storage: EntryStorage | null = defaultStorage()): SupportedLang {
  const raw = storage ? storage.getItem(ENTRY_LANG_STORAGE_KEY) : null;
  return SUPPORTED_LANGS.indexOf(raw as SupportedLang) !== -1 ? (raw as SupportedLang) : 'it';
}

/** Nome localizzato del Paese (Intl.DisplayNames), con fallback sul codice. */
export function countryLabel(code: string, lang: SupportedLang): string {
  if (!code || code === 'OTHER') {
    return ENTRY_FLOW_TEXT[lang]?.otherCountryLabel || 'Other';
  }
  try {
    const dn = new Intl.DisplayNames([lang], { type: 'region' });
    return dn.of(code) || code;
  } catch {
    return code;
  }
}

/* --- Testi del flusso d'ingresso ----------------------------------------- */

export interface EntryFlowText {
  langTitle: string;
  marketTitle: string;
  marketDesc: string;
  marketBack: string;
  prefsTitle: string;
  prefsDesc: string;
  prefsBack: string;
  durationLabel: string;
  continueBtn: string;
  otherCountryLabel: string;
  categoryLabels: Record<EntryCategoryId, string>;
}

type MultiLang = Record<SupportedLang, string>;

const L = (
  it: string,
  en: string,
  es: string,
  fr: string,
  de: string,
  pt: string,
  ru: string,
  ar: string,
  tr: string,
  hi: string,
  zh: string,
  id: string,
  ja: string = en,
  ko: string = en
): MultiLang => ({ it, en, es, fr, de, pt, ru, ar, tr, hi, zh, id, ja, ko });

const TEXTS = {
  langTitle: L(
    '🌍 Scegli la Lingua',
    '🌍 Select Language',
    '🌍 Elige el idioma',
    '🌍 Choisir la langue',
    '🌍 Sprache wählen',
    '🌍 Escolha o idioma',
    '🌍 Выберите язык',
    '🌍 اختر اللغة',
    '🌍 Dil seçin',
    '🌍 भाषा चुनें',
    '🌍 选择语言',
    '🌍 Pilih Bahasa'
  ),
  marketTitle: L(
    'Paese di riferimento',
    'Reference country',
    'País de referencia',
    'Pays de référence',
    'Referenzland',
    'País de referência',
    'Страна для расчёта',
    'بلد المرجع',
    'Referans ülkes',
    'संदर्भ देश',
    '参考国家',
    'Negara acuan'
  ),
  marketDesc: L(
    'La lingua serve a leggere l\'app. Per applicare il profilo economico corretto scegli il Paese di riferimento, anche se ti trovi temporaneamente all\'estero. Questa scelta non verifica nazionalità o identità: eventuali verifiche documentali sono separate.',
    'The language is for reading the app. To apply the correct economic profile, choose your reference country, even if you are temporarily abroad. This choice does not verify nationality or identity: any document checks are separate.',
    'El idioma sirve para leer la app. Para aplicar el perfil económico correcto, elige tu país de referencia, aunque estés temporalmente en el extranjero. Esta elección no verifica nacionalidad ni identidad: las verificaciones documentales son separadas.',
    'La langue sert à lire l\'application. Pour appliquer le profil économique correct, choisissez votre pays de référence, même si vous êtes temporairement à l\'étranger. Ce choix ne vérifie ni la nationalité ni l\'identité : les vérifications documentaires sont séparées.',
    'Die Sprache dient zum Lesen der App. Um das passende wirtschaftliche Profil anzuwenden, wähle dein Referenzland, auch wenn du vorübergehend im Ausland bist. Diese Auswahl überprüft weder Staatsangehörigkeit noch Identität: Dokumenteprüfungen erfolgen separat.',
    'O idioma serve para ler o app. Para aplicar o perfil económico correto, escolha o seu país de referência, mesmo que esteja temporariamente fora. Esta escolha não verifica nacionalidade nem identidade: as verificações documentais são separadas.',
    'Язык нужен для чтения приложения. Чтобы применить правильный экономический профиль, выберите страну для расчёта, даже если вы временно за границей. Этот выбор не проверяет гражданство или личность: проверка документов выполняется отдельно.',
    'اللغة تُستخدم لقراءة التطبيق. لتطبيق الملف الاقتصادي الصحيح، اختر بلدك المرجعي حتى لو كنت في الخارج مؤقتًا. هذا الاختيار لا يتحقق من الجنسية أو الهوية: فحوصات المستندات منفصلة.',
    'Dil, uygulamayı okumak içindir. Doğru ekonomik profili uygulamak için geçici olarak yurt dışında olsanız bile referans ülkenizi seçin. Bu seçim uyruk veya kimlik doğrulamaz: belge kontrolleri ayrıdır.',
    'भाषा ऐप पढ़ने के लिए है। सही आर्थिक प्रोफ़ाइल लागू करने के लिए अपना संदर्भ देश चुनें, भले ही आप अस्थायी रूप से विदेश में हों। यह चयन राष्ट्रीयता या पहचान सत्यापित नहीं करता: दस्तावेज़ जाँच अलग होती है।',
    '语言用于阅读应用。为套用正确的经济档案，请选择参考国家，即使您暂时身在国外。此选择不验证国籍或身份：证件核验另行进行。',
    'Bahasa digunakan untuk membaca aplikasi. Untuk menerapkan profil ekonomi yang benar, pilih negara acuan Anda, bahkan jika Anda sedang berada di luar negeri sementara. Pilihan ini tidak memverifikasi kewarganegaraan atau identitas: pemeriksaan dokumen dilakukan terpisah.'
  ),
  marketBack: L(
    '← Lingua',
    '← Language',
    '← Idioma',
    '← Langue',
    '← Sprache',
    '← Idioma',
    '← Язык',
    '← اللغة',
    '← Dil',
    '← भाषा',
    '← 语言',
    '← Bahasa'
  ),
  prefsTitle: L(
    'Scegli cosa vuoi ricevere',
    'Choose what you want to receive',
    'Elige qué quieres recibir',
    'Choisissez ce que vous voulez recevoir',
    'Wähle, was du erhalten möchtest',
    'Escolha o que deseja receber',
    'Выберите, что хотите получать',
    'اختر ما تريد استلامه',
    'Ne almak istediğinizi seçin',
    'चुनें कि आप क्या प्राप्त करना चाहते हैं',
    '选择您想收到的内容',
    'Pilih apa yang ingin Anda terima'
  ),
  prefsDesc: L(
    'Seleziona una o più categorie. Il ciclo automatico userà queste preferenze per organizzare le attività disponibili.',
    'Select one or more categories. The automatic cycle will use these preferences to organize the available activities.',
    'Selecciona una o más categorías. El ciclo automático usará estas preferencias para organizar las actividades disponibles.',
    'Sélectionnez une ou plusieurs catégories. Le cycle automatique utilisera ces préférences pour organiser les activités disponibles.',
    'Wähle eine oder mehrere Kategorien. Der automatische Zyklus nutzt diese Einstellungen, um die verfügbaren Aktivitäten zu organisieren.',
    'Selecione uma ou mais categorias. O ciclo automático usará estas preferências para organizar as atividades disponíveis.',
    'Выберите одну или несколько категорий. Автоматический цикл использует эти предпочтения для подбора доступных активностей.',
    'اختر فئة واحدة أو أكثر. ستستخدم الدورة التلقائية هذه التفضيلات لتنظيم الأنشطة المتاحة.',
    'Bir veya daha fazla kategori seçin. Otomatik döngü, mevcut etkinlikleri düzenlemek için bu tercihleri kullanır.',
    'एक या अधिक श्रेणियाँ चुनें। स्वचालित चक्र उपलब्ध गतिविधियों को व्यवस्थित करने के लिए इन प्राथमिकताओं का उपयोग करेगा।',
    '选择一个或多个分类。自动循环将根据这些偏好安排可用活动。',
    'Pilih satu atau beberapa kategori. Siklus otomatis akan menggunakan preferensi ini untuk mengatur aktivitas yang tersedia.'
  ),
  prefsBack: L(
    '← Indietro',
    '← Back',
    '← Atrás',
    '← Retour',
    '← Zurück',
    '← Voltar',
    '← Назад',
    '→ رجوع',
    '← Geri',
    '← वापस',
    '← 返回',
    '← Kembali'
  ),
  durationLabel: L(
    'Quanto tempo vuoi dedicare?',
    'How much time do you want to dedicate?',
    '¿Cuánto tiempo quieres dedicar?',
    'Combien de temps veux-tu consacrer ?',
    'Wie viel Zeit möchtest du investieren?',
    'Quanto tempo deseja dedicar?',
    'Сколько времени вы хотите уделить?',
    'كم تريد أن تخصص من الوقت؟',
    'Ne kadar süre ayırmak istiyorsun?',
    'आप कितना समय देना चाहते हैं?',
    '您愿意投入多少时间？',
    'Berapa lama yang ingin Anda luangkan?'
  ),
  continueBtn: L(
    'CONTINUA →',
    'CONTINUE →',
    'CONTINUAR →',
    'CONTINUER →',
    'WEITER →',
    'CONTINUAR →',
    'ПРОДОЛЖИТЬ →',
    'متابعة →',
    'DEVAM ET →',
    'जारी रखें →',
    '继续 →',
    'LANJUT →'
  ),
  otherCountryLabel: L(
    'Altro / da definire',
    'Other / to be defined',
    'Otro / por definir',
    'Autre / à définir',
    'Sonstige / noch zu bestimmen',
    'Outro / a definir',
    'Другое / уточнить',
    'أخرى / يتم تحديدها',
    'Diğer / belirlenecek',
    'अन्य / निर्धारित किया जाएगा',
    '其他 / 待定',
    'Lainnya / belum ditentukan'
  ),
  categoryLabels: {
    videos: L(
      'Video e mini-serie',
      'Videos & mini-series',
      'Vídeos y miniseries',
      'Vidéos et mini-séries',
      'Videos & Miniserien',
      'Vídeos e minisséries',
      'Видео и мини-сериалы',
      'مقاطع الفيديو والمسلسلات القصيرة',
      'Videolar ve mini diziler',
      'वीडियो और मिनी-सीरीज़',
      '视频与迷你剧',
      'Video & mini-seri'
    ),
    games: L(
      'Giochi e playtest',
      'Games & playtesting',
      'Juegos y playtest',
      'Jeux et playtests',
      'Spiele & Playtests',
      'Jogos e playtest',
      'Игры и плейтесты',
      'الألعاب واختبار التشغيل',
      'Oyunlar ve oynama testleri',
      'गेम और प्लेटेस्ट',
      '游戏与试玩',
      'Game & playtest'
    ),
    interactions: L(
      'App e interazioni',
      'Apps & interactions',
      'Apps e interacciones',
      'Apps et interactions',
      'Apps & Interaktionen',
      'Apps e interações',
      'Приложения и взаимодействия',
      'التطبيقات والتفاعلات',
      'Uygulamalar ve etkileşimler',
      'ऐप और इंटरैक्शन',
      '应用与互动',
      'Aplikasi & interaksi'
    ),
    surveys: L(
      'Sondaggi seri & ricerche dirette',
      'Direct research & verified surveys',
      'Encuestas serias e investigación directa',
      'Sondages sérieux et études directes',
      'Seriöse Direktstudien & Forschung',
      'Pesquisas sérias e estudos diretos',
      'Прямые исследования и опросы',
      'أبحاث واستطلاعات مباشرة موثقة',
      'Doğrudan araştırmalar ve ciddi anketler',
      'प्रत्यक्ष अनुसंधान और सत्यापित सर्वेक्षण',
      '直接研究与认证调查',
      'Riset langsung & survei terverifikasi'
    ),
    shopping: L(
      'Shopping e prodotti',
      'Shopping & products',
      'Compras y productos',
      'Shopping et produits',
      'Shopping & Produkte',
      'Compras e produtos',
      'Покупки и товары',
      'التسوق والمنتجات',
      'Alışveriş ve ürünler',
      'शॉपिंग और उत्पाद',
      '购物与产品',
      'Belanja & produk'
    ),
    ai_tasks: L(
      'Attività AI e dati',
      'AI & data tasks',
      'Tareas de IA y datos',
      'Tâches IA et données',
      'KI- und Daten-Aufgaben',
      'Tarefas de IA e dados',
      'Задачи ИИ и данные',
      'مهام الذكاء الاصطناعي والبيانات',
      'Yapay zekâ ve veri görevleri',
      'AI और डेटा कार्य',
      'AI 与数据任务',
      'Tugas AI & data'
    ),
    audio: L(
      'Audio e voce',
      'Audio & voice',
      'Audio y voz',
      'Audio et voix',
      'Audio & Stimme',
      'Áudio e voz',
      'Аудио и голос',
      'الصوت',
      'Ses ve konuşma',
      'ऑडियो और आवाज़',
      '音频与语音',
      'Audio & suara'
    ),
    receipts: L(
      'Scontrini e spesa',
      'Receipts & shopping',
      'Recibos y compras',
      'Reçus et achats',
      'Belege & Einkäufe',
      'Recibos e compras',
      'Чеки и покупки',
      'الإيصالات والتسوق',
      'Fişler ve alışveriş',
      'रसीदें और खरीदारी',
      '收据与购物',
      'Struk & belanja'
    ),
    telegram: L(
      'Bot e community Telegram',
      'Telegram bots & communities',
      'Bots y comunidades de Telegram',
      'Bots et communautés Telegram',
      'Telegram-Bots & Communities',
      'Bots e comunidades do Telegram',
      'Боты и сообщества Telegram',
      'بوتات ومجتمعات تيليجرام',
      'Telegram botları ve toplulukları',
      'टेलीग्राम बॉट और समुदाय',
      '电报机器人与社区',
      'Bot & komunitas Telegram'
    ),
    airdrops: L(
      'Airdrop e campagne',
      'Airdrops & campaigns',
      'Airdrops y campañas',
      'Airdrops et campagnes',
      'Airdrops & Kampagnen',
      'Airdrops e campanhas',
      'Эйрдропы и кампании',
      'إيردروب والحملات',
      'Airdrop ve kampanyalar',
      'एयरड्रॉप और अभियान',
      '空投与活动',
      'Airdrop & kampanye'
    ),
  } as Record<EntryCategoryId, MultiLang>,
};

function buildEntryFlowText(): Record<SupportedLang, EntryFlowText> {
  const out = {} as Record<SupportedLang, EntryFlowText>;
  for (const lang of SUPPORTED_LANGS) {
    const categoryLabels = {} as Record<EntryCategoryId, string>;
    for (const cat of ENTRY_CATEGORIES) {
      categoryLabels[cat.id] = TEXTS.categoryLabels[cat.id][lang];
    }
    out[lang] = {
      langTitle: TEXTS.langTitle[lang],
      marketTitle: TEXTS.marketTitle[lang],
      marketDesc: TEXTS.marketDesc[lang],
      marketBack: TEXTS.marketBack[lang],
      prefsTitle: TEXTS.prefsTitle[lang],
      prefsDesc: TEXTS.prefsDesc[lang],
      prefsBack: TEXTS.prefsBack[lang],
      durationLabel: TEXTS.durationLabel[lang],
      continueBtn: TEXTS.continueBtn[lang],
      otherCountryLabel: TEXTS.otherCountryLabel[lang],
      categoryLabels,
    };
  }
  return out;
}

export const ENTRY_FLOW_TEXT: Record<SupportedLang, EntryFlowText> = buildEntryFlowText();
