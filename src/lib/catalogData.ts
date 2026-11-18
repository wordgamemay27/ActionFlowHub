// ============================================================================
// CATALOG DATA — Dati progetti, task, provider verificati (14 Lingue Complete)
// ============================================================================

import { CatalogLang } from './i18n';

export type DurationBucket = 'FAST' | 'MEDIUM' | 'LONG';

export type BrandRepartoId = 'ALL' | 'ECOMMERCE' | 'GAMING' | 'STREAMING' | 'CRYPTO';

export interface ProjectActionItem {
  label: Record<CatalogLang, string>;
  points: number;
  actionPhotoUrl?: string;
  directUrl?: string;
}

export interface ProjectCardData {
  id: string;
  pageId: string;
  durationBucket: DurationBucket;
  category?: string;
  provider?: string;
  title: Record<CatalogLang, string>;
  subtitle?: Record<CatalogLang, string>;
  photoUrl?: string;
  unlocksHalfStep?: boolean;
  executionType?: string;
  actions: ProjectActionItem[];
}

export interface LocationSectionMeta {
  id: string;
  title: string;
  subtitle: string;
}

export interface GlobalBrandCryptoCard {
  id: string;
  brand: string;
  reparto: BrandRepartoId;
  title: string;
  denominations: number[];
  url: string;
}

export const PROJECTS_CATALOG: ProjectCardData[] = [
  {
    id: 'proj-games-milestone',
    pageId: 'page_games_ladder',
    durationBucket: 'FAST',
    category: 'GAMES',
    provider: 'Plarium / Wargaming Direct',
    title: {
      it: '01 — Sfida Livello Rapido Mobile',
      en: '01 — Fast Mobile Level Challenge',
      es: '01 — Desafío Rápido de Nivel Móvil',
      fr: '01 — Défi Rapide de Niveau Mobile',
      de: '01 — Schnelle Mobile-Level-Challenge',
      pt: '01 — Desafio Rápido de Nível Mobile',
      ru: '01 — Быстрый челлендж уровней на телефоне',
      zh: '01 — 手机快速升级挑战',
      ja: '01 — モバイル高速レベルチャレンジ',
      ko: '01 — 모바일 빠른 레벨 챌린지',
      ar: '01 — تحدي المستوى السريع للهاتف',
      hi: '01 — फ़ास्ट मोबाइल लेवल चैलेंज',
      tr: '01 — Hızlı Mobil Seviye Görevi',
      id: '01 — Tantangan Level Cepat Mobile',
    },
    actions: [
      {
        label: {
          it: 'Raggiungi Livello 3 (Verifica S2S Diretta)',
          en: 'Reach Level 3 (Direct S2S Verify)',
          es: 'Alcanza el Nivel 3 (Verificación S2S Directa)',
          fr: 'Atteindre le Niveau 3 (Vérification S2S Directe)',
          de: 'Level 3 erreichen (Direkte S2S-Prüfung)',
          pt: 'Alcance o Nível 3 (Verificação S2S Direta)',
          ru: 'Достичь 3-го уровня (Прямая S2S-проверка)',
          zh: '达到 3 级（S2S 直接验证）',
          ja: 'レベル3に到達（S2S直接認証）',
          ko: '레벨 3 달성 (직접 S2S 인증)',
          ar: 'الوصول إلى المستوى 3 (تحقق S2S مباشر)',
          hi: 'लेवल 3 तक पहुँचें (डायरेक्ट S2S सत्यापन)',
          tr: 'Seviye 3’e Ulaş (Doğrudan S2S Doğrulama)',
          id: 'Capai Level 3 (Verifikasi S2S Langsung)',
        },
        points: 15,
        directUrl: 'https://plarium.com/',
      },
      {
        label: {
          it: 'Completa Tutorial Casa Madre',
          en: 'Complete Official Studio Tutorial',
          es: 'Completa el Tutorial Oficial del Estudio',
          fr: 'Terminer le Tutoriel Officiel du Studio',
          de: 'Offizielles Studio-Tutorial abschließen',
          pt: 'Conclua o Tutorial Oficial do Estúdio',
          ru: 'Пройти официальное обучение студии',
          zh: '完成官方工作室新手教程',
          ja: '公式スタジオのチュートリアルを完了',
          ko: '공식 스튜디오 튜토리얼 완료',
          ar: 'إكمال التدريب الرسمي للاستوديو',
          hi: 'आधिकारिक स्टूडियो ट्यूटोरियल पूरा करें',
          tr: 'Resmi Stüdyo Eğitimini Tamamla',
          id: 'Selesaikan Tutorial Studio Resmi',
        },
        points: 15,
        directUrl: 'https://wargaming.net/',
      },
    ],
  },
  {
    id: 'proj-playtime-active',
    pageId: 'page_playtime',
    durationBucket: 'FAST',
    category: 'PLAYTIME',
    provider: 'Gaijin / Epic Games Direct',
    title: {
      it: '02 — Sessione Playtime Diretta',
      en: '02 — Direct Playtime Session',
      es: '02 — Sesión de Juego Directa',
      fr: '02 — Session de Jeu Directe',
      de: '02 — Direkte Spielzeit-Sitzung',
      pt: '02 — Sessão de Jogo Direta',
      ru: '02 — Прямая игровая сессия',
      zh: '02 — 直接游戏时长任务',
      ja: '02 — ダイレクトプレイタイムセッション',
      ko: '02 — 직접 플레이타임 세션',
      ar: '02 — جلسة لعب مباشرة',
      hi: '02 — डायरेक्ट प्लेटाइम सेशन',
      tr: '02 — Doğrudan Oyun Süresi Oturumu',
      id: '02 — Sesi Bermain Langsung',
    },
    actions: [
      {
        label: {
          it: 'Gioca 5 minuti consecutivi',
          en: 'Play 5 consecutive minutes',
          es: 'Juega 5 minutos consecutivos',
          fr: 'Jouer 5 minutes consécutives',
          de: '5 Minuten am Stück spielen',
          pt: 'Jogue 5 minutos consecutivos',
          ru: 'Играть 5 минут подряд',
          zh: '连续游玩 5 分钟',
          ja: '5分間連続でプレイする',
          ko: '5분 연속 플레이하기',
          ar: 'العب لمدة 5 دقائق متواصلة',
          hi: 'लगातार 5 मिनट खेलें',
          tr: 'Kesintisiz 5 dakika oyna',
          id: 'Bermain 5 menit berturut-turut',
        },
        points: 15,
        directUrl: 'https://gaijin.net/',
      },
      {
        label: {
          it: 'Sblocca baule giornaliero ufficiale',
          en: 'Unlock official daily chest',
          es: 'Desbloquea el cofre diario oficial',
          fr: 'Débloquer le coffre quotidien officiel',
          de: 'Offizielle tägliche Truhe freischalten',
          pt: 'Desbloqueie o baú diário oficial',
          ru: 'Открыть официальный ежедневный сундук',
          zh: '解锁官方每日宝箱',
          ja: '公式デイリーチェストを解除',
          ko: '공식 일일 상자 잠금 해제',
          ar: 'فتح الصندوق اليومي الرسمي',
          hi: 'आधिकारिक डेली चेस्ट अनलॉक करें',
          tr: 'Resmi günlük sandığı aç',
          id: 'Buka peti harian resmi',
        },
        points: 15,
        directUrl: 'https://store.epicgames.com/',
      },
    ],
  },
  {
    id: 'proj-voice-3phrases',
    pageId: 'page_ai_work',
    durationBucket: 'MEDIUM',
    category: 'VOICE',
    provider: 'Mozilla Common Voice Direct',
    title: {
      it: '03 — Pronuncia 3 Frasi AI',
      en: '03 — Speak 3 AI Phrases',
      es: '03 — Pronuncia 3 Frases de IA',
      fr: '03 — Prononcer 3 Phrases IA',
      de: '03 — 3 KI-Sätze einsprechen',
      pt: '03 — Pronuncie 3 Frases de IA',
      ru: '03 — Произнести 3 фразы для ИИ',
      zh: '03 — 朗读 3 句 AI 语音',
      ja: '03 — AI音声3フレーズを読み上げ',
      ko: '03 — AI 문장 3개 음성 녹음',
      ar: '03 — نطق 3 جمل للذكاء الاصطناعي',
      hi: '03 — 3 AI वाक्य बोलें',
      tr: '03 — 3 Yapay Zeka Cümlesi Seslendir',
      id: '03 — Ucapkan 3 Kalimat AI',
    },
    actions: [
      {
        label: {
          it: 'Registra 3 frasi vocali chiare',
          en: 'Record 3 clear voice phrases',
          es: 'Graba 3 frases de voz claras',
          fr: 'Enregistrer 3 phrases vocales claires',
          de: '3 klare Sprachsätze aufnehmen',
          pt: 'Grave 3 frases de voz claras',
          ru: 'Записать 3 четкие голосовые фразы',
          zh: '录制 3 句清晰语音',
          ja: 'クリアな音声フレーズを3つ録音',
          ko: '또렷한 음성 문장 3개 녹음',
          ar: 'تسجيل 3 جمل صوتية واضحة',
          hi: '3 स्पष्ट वॉइस वाक्य रिकॉर्ड करें',
          tr: '3 net sesli cümle kaydet',
          id: 'Rekam 3 kalimat suara yang jelas',
        },
        points: 30,
        directUrl: 'https://commonvoice.mozilla.org/it/speak',
      },
      {
        label: {
          it: 'Convalida 3 clip vocali',
          en: 'Validate 3 voice clips',
          es: 'Valida 3 clips de voz',
          fr: 'Valider 3 extraits vocaux',
          de: '3 Sprachclips überprüfen',
          pt: 'Valide 3 clipes de voz',
          ru: 'Проверить 3 голосовых клипа',
          zh: '验证 3 段语音片段',
          ja: '3つの音声クリップを検証',
          ko: '음성 클립 3개 검증하기',
          ar: 'التحقق من 3 مقاطع صوتية',
          hi: '3 वॉइस क्लिप सत्यापित करें',
          tr: '3 ses kaydını doğrula',
          id: 'Validasi 3 klip suara',
        },
        points: 30,
        directUrl: 'https://commonvoice.mozilla.org/it/listen',
      },
    ],
  },
  {
    id: 'proj-voice-15phrases',
    pageId: 'page_ai_work',
    durationBucket: 'MEDIUM',
    category: 'VOICE',
    provider: 'Mozilla Common Voice Direct',
    title: {
      it: '04 — Sessione Vocale 15 Frasi',
      en: '04 — 15 Phrases Voice Session',
      es: '04 — Sesión de Voz de 15 Frases',
      fr: '04 — Session Vocale de 15 Phrases',
      de: '04 — Sprachsitzung mit 15 Sätzen',
      pt: '04 — Sessão de Voz de 15 Frases',
      ru: '04 — Голосовая сессия из 15 фраз',
      zh: '04 — 15 句语音录制任务',
      ja: '04 — 15フレーズ音声セッション',
      ko: '04 — 15개 문장 음성 세션',
      ar: '04 — جلسة صوتية من 15 جملة',
      hi: '04 — 15 वाक्य वॉइस सेशन',
      tr: '04 — 15 Cümlelik Ses Oturumu',
      id: '04 — Sesi Suara 15 Kalimat',
    },
    actions: [
      {
        label: {
          it: 'Registra 15 frasi dataset AI',
          en: 'Record 15 AI dataset phrases',
          es: 'Graba 15 frases para dataset de IA',
          fr: 'Enregistrer 15 phrases pour dataset IA',
          de: '15 Sätze für KI-Datensatz aufnehmen',
          pt: 'Grave 15 frases para dataset de IA',
          ru: 'Записать 15 фраз для ИИ-датасета',
          zh: '录制 15 句 AI 数据集语音',
          ja: 'AIデータセット用に15フレーズを録音',
          ko: 'AI 데이터셋 문장 15개 녹음',
          ar: 'تسجيل 15 جملة لبيانات الذكاء الاصطناعي',
          hi: 'AI डेटासेट के लिए 15 वाक्य रिकॉर्ड करें',
          tr: 'YZ veri seti için 15 cümle kaydet',
          id: 'Rekam 15 kalimat dataset AI',
        },
        points: 30,
        directUrl: 'https://commonvoice.mozilla.org/it/speak',
      },
    ],
  },
  {
    id: 'proj-receipt-photo',
    pageId: 'page_ai_work',
    durationBucket: 'MEDIUM',
    category: 'VISION',
    provider: 'Tabscanner / Veryfi Direct',
    title: {
      it: '05 — Scansione Scontrino Spesa',
      en: '05 — Grocery Receipt Scan',
      es: '05 — Escaneo de Recibo de Compra',
      fr: '05 — Scan de Ticket de Caisse',
      de: '05 — Kassenbon-Scan',
      pt: '05 — Digitalização de Cupom Fiscal',
      ru: '05 — Сканирование кассового чека',
      zh: '05 — 购物小票拍照扫描',
      ja: '05 — 買い物レシートスキャン',
      ko: '05 — 쇼핑 영수증 스캔',
      ar: '05 — مسح إيصال التسوق',
      hi: '05 — शॉपिंग रसीद स्कैन',
      tr: '05 — Alışveriş Fişi Tarama',
      id: '05 — Pindai Struk Belanja',
    },
    actions: [
      {
        label: {
          it: 'Carica foto scontrino leggibile',
          en: 'Upload readable receipt photo',
          es: 'Sube una foto legible del recibo',
          fr: 'Téléverser une photo lisible du ticket',
          de: 'Lesbares Foto des Kassenbons hochladen',
          pt: 'Envie foto legível do cupom fiscal',
          ru: 'Загрузить четкое фото чека',
          zh: '上传清晰的购物小票照片',
          ja: '読み取れるレシート写真をアップロード',
          ko: '식별 가능한 영수증 사진 업로드',
          ar: 'رفع صورة واضحة لإيصال الشراء',
          hi: 'स्पष्ट रसीद फ़ोटो अपलोड करें',
          tr: 'Okunaklı fiş fotoğrafı yükle',
          id: 'Unggah foto struk yang jelas',
        },
        points: 30,
        directUrl: 'https://tabscanner.com/',
      },
    ],
  },
  {
    id: 'proj-bots-youtuber',
    pageId: 'page_bots_youtuber',
    durationBucket: 'MEDIUM',
    category: 'TELEGRAM_BOT',
    provider: 'Telegram Official / Fragment Direct',
    unlocksHalfStep: true,
    title: {
      it: '06 — Bot Telegram & Canali Ufficiali Diretti',
      en: '06 — Official Direct Telegram Bots & Channels',
      es: '06 — Bots y Canales Oficiales de Telegram',
      fr: '06 — Bots & Canaux Telegram Officiels Directs',
      de: '06 — Offizielle Telegram-Bots & Kanäle',
      pt: '06 — Bots e Canais Oficiais do Telegram',
      ru: '06 — Официальные Telegram-боты и каналы',
      zh: '06 — 官方 Telegram 机器人与频道',
      ja: '06 — 公式Telegramボット＆チャンネル',
      ko: '06 — 공식 텔레그램 봇 & 채널',
      ar: '06 — بوتات وقنوات تيليجرام الرسمية المباشرة',
      hi: '06 — आधिकारिक टेलीग्राम बॉट और चैनल',
      tr: '06 — Resmi Telegram Botları ve Kanalları',
      id: '06 — Bot & Kanal Telegram Resmi Langsung',
    },
    actions: [
      {
        label: {
          it: 'Avvia Bot Ufficiale e verifica iscrizione',
          en: 'Start Official Bot & verify join',
          es: 'Inicia el Bot Oficial y verifica la unión',
          fr: 'Démarrer le Bot Officiel et vérifier l’adhésion',
          de: 'Offiziellen Bot starten & Beitritt prüfen',
          pt: 'Inicie o Bot Oficial e verifique a inscrição',
          ru: 'Запустить официального бота и подтвердить вход',
          zh: '启动官方机器人并验证加入',
          ja: '公式ボットを起動して参加を確認',
          ko: '공식 봇 시작 및 가입 인증',
          ar: 'بدء البوت الرسمي وتأكيد الانضمام',
          hi: 'आधिकारिक बॉट शुरू करें और जॉइन सत्यापित करें',
          tr: 'Resmi Botu başlat ve katılımı doğrula',
          id: 'Mulai Bot Resmi & verifikasi bergabung',
        },
        points: 30,
        directUrl: 'https://fragment.com/',
      },
    ],
  },
  {
    id: 'proj-video-object-1m',
    pageId: 'page_ai_work',
    durationBucket: 'LONG',
    category: 'VIDEO_AI',
    provider: 'Roboflow Vision Direct',
    title: {
      it: '07 — Ripresa Oggetto 1 Minuto',
      en: '07 — 1-Minute Object Video',
      es: '07 — Video de Objeto de 1 Minuto',
      fr: '07 — Vidéo d’Objet d’1 Minute',
      de: '07 — 1-Minuten-Objektvideo',
      pt: '07 — Vídeo de Objeto de 1 Minuto',
      ru: '07 — 1-минутное видео объекта',
      zh: '07 — 1 分钟物体视频拍摄',
      ja: '07 — 1分間のオブジェクト動画撮影',
      ko: '07 — 1분 사물 영상 촬영',
      ar: '07 — تصوير فيديو لجسم لمدة دقيقة',
      hi: '07 — 1-मिनट ऑब्जेक्ट वीडियो कैप्चर',
      tr: '07 — 1 Dakikalık Nesne Videosu',
      id: '07 — Rekaman Video Objek 1 Menit',
    },
    actions: [
      {
        label: {
          it: 'Riprendi oggetto a 360° per training AI',
          en: 'Capture 360° object video for AI',
          es: 'Graba un objeto en 360° para entrenamiento IA',
          fr: 'Filmer un objet à 360° pour l’entraînement IA',
          de: '360°-Objektvideo für KI-Training aufnehmen',
          pt: 'Filme um objeto em 360° para treino de IA',
          ru: 'Снять видео объекта на 360° для обучения ИИ',
          zh: '拍摄 360° 物体视频用于 AI 训练',
          ja: 'AI学習用に360°オブジェクト動画を撮影',
          ko: 'AI 학습용 360° 사물 영상 촬영',
          ar: 'تصوير فيديو 360 درجة لجسم لتدريب الذكاء الاصطناعي',
          hi: 'AI प्रशिक्षण के लिए 360° ऑब्जेक्ट वीडियो रिकॉर्ड करें',
          tr: 'YZ eğitimi için 360° nesne videosu çek',
          id: 'Rekam video objek 360° untuk pelatihan AI',
        },
        points: 60,
        directUrl: 'https://universe.roboflow.com/',
      },
    ],
  },
  {
    id: 'proj-home-chores-8m',
    pageId: 'page_ai_work',
    durationBucket: 'LONG',
    category: 'VIDEO_AI',
    provider: 'HuggingFace Dataset Direct',
    title: {
      it: '08 — Ripresa Attività Domestica',
      en: '08 — Home Activity Capture',
      es: '08 — Grabación de Actividad Doméstica',
      fr: '08 — Capture d’Activité Domestique',
      de: '08 — Aufnahme von Alltagsaktivitäten',
      pt: '08 — Gravação de Atividade Doméstica',
      ru: '08 — Съемка домашней активности',
      zh: '08 — 日常居家活动视频采集',
      ja: '08 — 日常アクティビティ動画撮影',
      ko: '08 — 일상 실내 활동 영상 촬영',
      ar: '08 — تصوير نشاط منزلي لتدريب الذكاء الاصطناعي',
      hi: '08 — घरेलू गतिविधि वीडियो कैप्चर',
      tr: '08 — Günlük Ev Aktivitesi Çekimi',
      id: '08 — Rekaman Aktivitas Rumah',
    },
    actions: [
      {
        label: {
          it: 'Sessione video 8 minuti verificata',
          en: 'Verified 8-minute video session',
          es: 'Sesión de video verificada de 8 minutos',
          fr: 'Session vidéo vérifiée de 8 minutes',
          de: 'Verifizierte 8-Minuten-Videositzung',
          pt: 'Sessão de vídeo verificada de 8 minutos',
          ru: 'Проверенная 8-минутная видеосессия',
          zh: '已验证的 8 分钟视频采集任务',
          ja: '認証済み8分間ビデオセッション',
          ko: '인증된 8분 영상 세션',
          ar: 'جلسة فيديو موثقة لمدة 8 دقائق',
          hi: 'सत्यापित 8-मिनट वीडियो सेशन',
          tr: 'Doğrulanmış 8 dakikalık video oturumu',
          id: 'Sesi video 8 menit terverifikasi',
        },
        points: 60,
        directUrl: 'https://huggingface.co/datasets',
      },
    ],
  },
  {
    id: 'proj-home-session-1h',
    pageId: 'page_ai_work',
    durationBucket: 'LONG',
    category: 'FULL_SESSION',
    provider: 'PublicAI / Sahara AI Direct',
    title: {
      it: '09 — Sessione Completa Annotazione',
      en: '09 — Full Annotation Session',
      es: '09 — Sesión Completa de Anotación',
      fr: '09 — Session Complète d’Annotation',
      de: '09 — Vollständige Annotations-Sitzung',
      pt: '09 — Sessão Completa de Anotação',
      ru: '09 — Полная сессия разметки данных',
      zh: '09 — 完整 AI 数据标注任务',
      ja: '09 — フルAIアノテーションセッション',
      ko: '09 — 전체 AI 데이터 라벨링 세션',
      ar: '09 — جلسة تصنيف بيانات كاملة',
      hi: '09 — पूर्ण डेटा एनोटेशन सेशन',
      tr: '09 — Tam Veri Etiketleme Oturumu',
      id: '09 — Sesi Anotasi Data Lengkap',
    },
    actions: [
      {
        label: {
          it: 'Completa batch annotazione',
          en: 'Complete annotation batch',
          es: 'Completa el lote de anotación',
          fr: 'Terminer le lot d’annotation',
          de: 'Annotations-Batch abschließen',
          pt: 'Conclua o lote de anotação',
          ru: 'Завершить пакет разметки данных',
          zh: '完成一组数据标注批次',
          ja: 'アノテーションバッチを完了',
          ko: '데이터 라벨링 배치 완료',
          ar: 'إكمال دفعة تصنيف البيانات',
          hi: 'एनोटेशन बैच पूरा करें',
          tr: 'Veri etiketleme paketini tamamla',
          id: 'Selesaikan batch anotasi data',
        },
        points: 60,
        directUrl: 'https://publicai.io/',
      },
    ],
  },
  {
    id: 'proj-saas-cloud-trial',
    pageId: 'page_saas',
    durationBucket: 'LONG',
    category: 'SAAS',
    provider: 'Vercel / DigitalOcean Direct',
    title: {
      it: '10 — Test Piattaforma Cloud / SaaS Diretta',
      en: '10 — Direct Cloud / SaaS Platform Trial',
      es: '10 — Prueba Directa de Plataforma Cloud / SaaS',
      fr: '10 — Test Direct de Plateforme Cloud / SaaS',
      de: '10 — Direkter Cloud- / SaaS-Plattform-Test',
      pt: '10 — Teste Direto de Plataforma Cloud / SaaS',
      ru: '10 — Тест облачной / SaaS-платформы',
      zh: '10 — 云平台 / SaaS 直接体验测试',
      ja: '10 — クラウド / SaaSプラットフォーム体験テスト',
      ko: '10 — 클라우드 / SaaS 플랫폼 직접 테스트',
      ar: '10 — تجربة منصة سحابية / SaaS مباشرة',
      hi: '10 — डायरेक्ट क्लाउड / SaaS प्लेटफ़ॉर्म परीक्षण',
      tr: '10 — Doğrudan Bulut / SaaS Platform Testi',
      id: '10 — Uji Coba Platform Cloud / SaaS Langsung',
    },
    actions: [
      {
        label: {
          it: 'Registrazione e test funzionalità',
          en: 'Sign up & feature test',
          es: 'Registro y prueba de funciones',
          fr: 'Inscription et test des fonctionnalités',
          de: 'Registrierung & Funktionstest',
          pt: 'Cadastro e teste de recursos',
          ru: 'Регистрация и тестирование функций',
          zh: '注册并测试核心功能',
          ja: '登録と機能テストを完了',
          ko: '가입 및 기능 테스트 완료',
          ar: 'التسجيل واختبار الميزات الأساسية',
          hi: 'साइन अप और फ़ीचर टेस्ट करें',
          tr: 'Kayıt ol ve özellikleri test et',
          id: 'Daftar & uji fitur utama',
        },
        points: 60,
        directUrl: 'https://vercel.com/',
      },
    ],
  },
  {
    id: 'proj-app-test-full',
    pageId: 'page_app_test',
    durationBucket: 'LONG',
    category: 'APP_TEST',
    provider: 'Test.io / uTest Direct',
    title: {
      it: '11 — Test Completo App & QA Diretto',
      en: '11 — Full Direct App QA & Feedback',
      es: '11 — Prueba Completa de App y QA Directo',
      fr: '11 — Test Complet d’App & QA Direct',
      de: '11 — Vollständiger App-QA- & Feedback-Test',
      pt: '11 — Teste Completo de App e QA Direto',
      ru: '11 — Полное QA-тестирование приложения и отзыв',
      zh: '11 — 完整应用 QA 测试与反馈',
      ja: '11 — アプリQAテスト＆フィードバック',
      ko: '11 — 앱 전체 QA 테스트 및 피드백',
      ar: '11 — اختبار شامل للتطبيق ومراجعة الجودة QA',
      hi: '11 — संपूर्ण ऐप QA टेस्ट और फ़ीडबैक',
      tr: '11 — Tam Uygulama QA Testi ve Geri Bildirim',
      id: '11 — Uji QA Aplikasi Lengkap & Umpan Balik',
    },
    actions: [
      {
        label: {
          it: 'Installa, prova e invia bug/feedback',
          en: 'Install, test & submit QA feedback',
          es: 'Instala, prueba y envía comentarios QA',
          fr: 'Installer, tester et envoyer un retour QA',
          de: 'Installieren, testen & QA-Feedback senden',
          pt: 'Instale, teste e envie feedback de QA',
          ru: 'Установить, протестировать и отправить QA-отчет',
          zh: '安装体验并提交 QA 测试反馈',
          ja: 'インストール・テストしてQAフィードバックを送信',
          ko: '설치 및 테스트 후 QA 피드백 제출',
          ar: 'تثبيت وتجربة وإرسال تقرير الجودة QA',
          hi: 'इंस्टॉल करें, परखें और QA फ़ीडबैक भेजें',
          tr: 'Yükle, test et ve QA geri bildirimi gönder',
          id: 'Instal, uji & kirim umpan balik QA',
        },
        points: 60,
        directUrl: 'https://test.io/',
      },
    ],
  },
];

export const LOCATIONS_META: LocationSectionMeta[] = [
  { id: 'page_games_ladder', title: 'Giochi Mobile & Case Madri', subtitle: 'Milestone S2S diretti senza intermediari' },
  { id: 'page_playtime', title: 'Playtime Diretto', subtitle: 'Ricompense dirette dagli sviluppatori' },
  { id: 'page_ai_work', title: 'AI Voice & Vision', subtitle: 'Training modelli e OCR diretto' },
  { id: 'page_bots_youtuber', title: 'Bot Telegram & Canali Diretti', subtitle: 'Verifica istantanea senza aggregatori' },
];

export const VIP_18_CATALOG: ProjectCardData[] = [];
export const PRO_MID_CATALOG: ProjectCardData[] = PROJECTS_CATALOG.filter((p) => p.durationBucket === 'MEDIUM');
export const PRO_HIGH_CATALOG: ProjectCardData[] = PROJECTS_CATALOG.filter((p) => p.durationBucket === 'LONG');
export const MEDIA_AUDIO_VR_CATALOG: ProjectCardData[] = [];

export const BRAND_REPARTI_TABS: { id: BrandRepartoId; label: string }[] = [
  { id: 'ALL', label: 'Tutti' },
  { id: 'ECOMMERCE', label: 'Shopping' },
  { id: 'GAMING', label: 'Gaming' },
  { id: 'STREAMING', label: 'Streaming' },
  { id: 'CRYPTO', label: 'Crypto & TON' },
];

export const GLOBAL_CRYPTO_BRAND_CARDS: GlobalBrandCryptoCard[] = [
  { id: 'amazon', brand: 'amazon', reparto: 'ECOMMERCE', title: 'Amazon Gift Card', denominations: [10, 25, 50, 100], url: 'https://www.amazon.it/' },
  { id: 'steam', brand: 'steam', reparto: 'GAMING', title: 'Steam Wallet', denominations: [10, 20, 50], url: 'https://store.steampowered.com/' },
  { id: 'spotify', brand: 'spotify', reparto: 'STREAMING', title: 'Spotify Premium', denominations: [10, 30, 60], url: 'https://www.spotify.com/' },
  { id: 'netflix', brand: 'netflix', reparto: 'STREAMING', title: 'Netflix Gift Card', denominations: [15, 25, 50], url: 'https://www.netflix.com/' },
];

export const VERIFIED_PROVIDERS_BY_PAGE: Record<string, string[]> = {
  page_games_ladder: ['Plarium Direct', 'Wargaming Direct', 'Gaijin Direct'],
  page_playtime: ['Epic Games Direct', 'Steam Direct'],
  page_ai_work: ['Common Voice', 'Roboflow', 'HuggingFace'],
  page_bots_youtuber: ['Telegram Official', 'Fragment Direct'],
};

export function getDirectProviderRelayUrl(project: ProjectCardData, actionIdx: number = 0): string {
  const act = project.actions[actionIdx] || project.actions[0];
  return act?.directUrl || 'https://plarium.com/';
}
