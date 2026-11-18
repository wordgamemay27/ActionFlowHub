// ============================================================================
// PROVIDER & LEGAL LOCALIZATION — 14 Lingue Complete per Card, Modali,
// Video Player e Informative Legali / Protocollo 3-Strike
// ============================================================================

import { SupportedLang } from './langs';
import { TranslationStrings } from './i18n';
import { VerifiedProviderItem } from '../components/ProviderExecutionModal';

export interface ExtraUiLocalization {
  // WithdrawView & ProfileView Legal / 3-Strike
  legalTitle: string;
  legalPoint1: string;
  legalPoint2: string;
  legalPoint3: string;
  threeStrikeTitle: string;
  threeStrikeStatusRegular: string;
  strike1Desc: string;
  strike2Label: string;
  strike2Desc: string;
  strike3Label: string;
  strike3Desc: string;
  pointsRedeemSummary: string;
  internationalDisclaimerText: string;
  // VideoStreamSection & AdPlayerModal
  videoStreamTitle: string;
  videoStreamSubtitle: string;
  backToHomeTitle: string;
  adPlaying: string;
  adLoading: string;
  audioOn: string;
  audioMute: string;
  closeBtn: string;
  advertisementLabel: string;
  // Provider localization templates
  compartmentLabel: string;
  directPartnerBadge: string;
  s2sDirectBadge: string;
  web3InstantBadge: string;
  step1MailTemplate: (mail: string) => string;
  step1WalletTemplate: (wallet: string) => string;
  step1DirectTemplate: (name: string) => string;
  step2OpenTemplate: (name: string, mail?: string) => string;
  step3CompleteTemplate: (duration: string, currencies: string) => string;
  step3ServiceTemplate: (name: string) => string;
}

export const EXTRA_UI_LOCALIZATION: Record<SupportedLang, ExtraUiLocalization> = {
  it: {
    legalTitle: 'Informativa Legale Internazionale & Esonero di Responsabilità',
    legalPoint1:
      '1. Natura Fedeltà (Zero Depositi Fiat): ActionFlow Hub opera esclusivamente come programma promozionale di raccolta punti fedeltà digitali (PT). La piattaforma non è una banca, non raccoglie depositi o investimenti dagli utenti e non presta servizi finanziari o di cambio.',
    legalPoint2:
      '2. Erogazione tramite Gateway Terzi Indipendenti: I riscatti in valuta locale contante (tramite Airtm, Payeer, Volet) o in asset digitali (tramite Wallet Non-Custodial) sono processati ed erogati da fornitori terzi indipendenti, unici titolari delle relative conformità normative (AML/KYC) nei 190+ Paesi serviti.',
    legalPoint3:
      '3. Assenza di Subordinazione & Autonomia Fiscale: La partecipazione alle attività promozionali è libera e occasionale, senza alcun vincolo di subordinazione lavorativa. Ciascun utente risponde in via esclusiva degli eventuali adempimenti fiscali e dichiarativi previsti dalle leggi del proprio Stato di residenza.',
    threeStrikeTitle: 'Protocollo Rigido 3-Strike (Utenti & Fornitori)',
    threeStrikeStatusRegular: 'STATO: REGOLARE (0/3)',
    strike1Desc: '1° errore tollerato',
    strike2Label: '2 = AVVISO',
    strike2Desc: 'Avviso severo + penalità',
    strike3Label: '3 = BLOCCO',
    strike3Desc: 'Verifica & Blocco immediato',
    pointsRedeemSummary:
      'I tuoi Punti Azione (PT) possono essere riscattati in Contanti nella tua Valuta Locale (Euro, Dollaro, Yuan WeChat/Alipay, Dirham, Sterlina Egiziana, Taka, Real tramite Airtm, Payeer, Volet) o in Crypto Diretta (USDT, TON, Solana, Pi).',
    internationalDisclaimerText:
      'Esonero di Responsabilità Internazionale: ActionFlow Hub è un programma promozionale gratuito di punti fedeltà (zero depositi e zero investimenti). Non sussiste alcun rapporto di lavoro subordinato. Le conversioni finali in valuta locale o asset digitali avvengono tramite gateway terzi indipendenti; ciascun utente opera in piena autonomia fiscale secondo le leggi del proprio Paese di residenza.',
    videoStreamTitle: 'FLUSSO VIDEO CPM & STREAM INTERATTIVO',
    videoStreamSubtitle:
      'Visione automatica sequenziale ad alto rendimento con micro-task di verifica istantanea.',
    backToHomeTitle: 'Torna alla Home',
    adPlaying: '▶ IN RIPRODUZIONE',
    adLoading: '⏳ CARICAMENTO...',
    audioOn: 'Audio ON',
    audioMute: 'Muto',
    closeBtn: 'Chiudi',
    advertisementLabel: 'PUBBLICITÀ',
    compartmentLabel: 'Compartimento',
    directPartnerBadge: 'Partner Ufficiale',
    s2sDirectBadge: 'S2S Diretto',
    web3InstantBadge: 'Web3 API Istantaneo',
    step1MailTemplate: (mail) => `Apri o copia la Mail di ${mail} indicata qui sopra.`,
    step1WalletTemplate: (wallet) => `Prepara o apri il tuo conto gratuito su ${wallet}.`,
    step1DirectTemplate: (name) => `Accedi al portale ufficiale verificato di ${name}.`,
    step2OpenTemplate: (name, mail) =>
      mail
        ? `Clicca sul pulsante di avvio per aprire ${name} e registrati con la mail ${mail}.`
        : `Clicca sul pulsante di avvio per aprire la pagina ufficiale di ${name}.`,
    step3CompleteTemplate: (duration, currencies) =>
      `Completa l'attività richiesta (${duration}) per attivare la verifica S2S e l'accredito (${currencies}).`,
    step3ServiceTemplate: (name) =>
      `Utilizza direttamente il servizio ufficiale ${name} dal portale verificato.`,
  },
  en: {
    legalTitle: 'International Legal Notice & Liability Disclaimer',
    legalPoint1:
      '1. Loyalty Program Nature (Zero Fiat Deposits): ActionFlow Hub operates exclusively as a digital promotional loyalty points (PT) program. The platform is not a bank, collects zero deposits or investments from users, and does not provide financial or exchange services.',
    legalPoint2:
      '2. Fulfillment via Independent Third-Party Gateways: Local cash redemptions (via Airtm, Payeer, Volet) or digital asset payouts (via Non-Custodial Wallets) are processed by independent third-party providers solely responsible for AML/KYC compliance across 190+ countries.',
    legalPoint3:
      '3. No Employment & Tax Autonomy: Participation in promotional activities is voluntary and occasional, with no employment relationship. Each user is solely responsible for any tax reporting required by the laws of their country of residence.',
    threeStrikeTitle: 'Strict 3-Strike Protocol (Users & Providers)',
    threeStrikeStatusRegular: 'STATUS: REGULAR (0/3)',
    strike1Desc: '1st error tolerated',
    strike2Label: '2 = WARNING',
    strike2Desc: 'Strict warning + penalty',
    strike3Label: '3 = BLOCK',
    strike3Desc: 'Immediate Verification & Block',
    pointsRedeemSummary:
      'Your Action Points (PT) can be redeemed for Local Currency Cash (EUR, USD, CNY WeChat/Alipay, AED, EGP, BDT, BRL via Airtm, Payeer, Volet) or Direct Crypto (USDT, TON, Solana, Pi).',
    internationalDisclaimerText:
      'International Disclaimer: ActionFlow Hub is a free promotional loyalty points program (zero deposits and zero investments). No employment relationship exists. Final conversions into local currency or digital assets are handled by independent third-party gateways; each user operates with full tax autonomy under the laws of their country of residence.',
    videoStreamTitle: 'CPM VIDEO STREAM & INTERACTIVE FLOW',
    videoStreamSubtitle:
      'Automated sequential high-yield viewing with instant verification micro-tasks.',
    backToHomeTitle: 'Back to Home',
    adPlaying: '▶ PLAYING',
    adLoading: '⏳ LOADING...',
    audioOn: 'Audio ON',
    audioMute: 'Mute',
    closeBtn: 'Close',
    advertisementLabel: 'ADVERTISEMENT',
    compartmentLabel: 'Compartment',
    directPartnerBadge: 'Official Partner',
    s2sDirectBadge: 'Direct S2S',
    web3InstantBadge: 'Instant Web3 API',
    step1MailTemplate: (mail) => `Copy or open the ${mail} address shown above.`,
    step1WalletTemplate: (wallet) => `Prepare or open your free account on ${wallet}.`,
    step1DirectTemplate: (name) => `Access the verified official portal of ${name}.`,
    step2OpenTemplate: (name, mail) =>
      mail
        ? `Click the start button to open ${name} and sign up using ${mail}.`
        : `Click the start button to open the official ${name} page.`,
    step3CompleteTemplate: (duration, currencies) =>
      `Complete the required activity (${duration}) to trigger S2S verification and credit (${currencies}).`,
    step3ServiceTemplate: (name) =>
      `Use the official ${name} service directly on the verified portal.`,
  },
  es: {
    legalTitle: 'Aviso Legal Internacional y Exención de Responsabilidad',
    legalPoint1:
      '1. Programa de Fidelidad (Cero Depósitos Fiat): ActionFlow Hub opera exclusivamente como un programa promocional de puntos de fidelidad digitales (PT). La plataforma no es un banco, no recauda depósitos ni inversiones y no presta servicios financieros.',
    legalPoint2:
      '2. Pago mediante Pasarelas Externas Independientes: Los retiros en efectivo local (vía Airtm, Payeer, Volet) o activos digitales (Billeteras No Custodiales) son procesados por proveedores independientes responsables del cumplimiento AML/KYC en más de 190 países.',
    legalPoint3:
      '3. Autonomía Fiscal y Sin Relación Laboral: La participación es libre y ocasional, sin vínculo laboral. Cada usuario es responsable exclusivo de sus obligaciones fiscales según las leyes de su país de residencia.',
    threeStrikeTitle: 'Protocolo Estricto 3-Strike (Usuarios y Proveedores)',
    threeStrikeStatusRegular: 'ESTADO: REGULAR (0/3)',
    strike1Desc: '1er error tolerado',
    strike2Label: '2 = AVISO',
    strike2Desc: 'Aviso severo + penalización',
    strike3Label: '3 = BLOQUEO',
    strike3Desc: 'Verificación y Bloqueo inmediato',
    pointsRedeemSummary:
      'Tus Puntos de Acción (PT) pueden canjearse por Efectivo en Moneda Local (EUR, USD, CNY, Dirham, Peso, Real vía Airtm, Payeer, Volet) o Cripto Directa (USDT, TON, Solana, Pi).',
    internationalDisclaimerText:
      'Exención Internacional: ActionFlow Hub es un programa promocional gratuito de puntos (cero depósitos y cero inversiones). Las conversiones finales se realizan mediante pasarelas independientes; cada usuario actúa con plena autonomía fiscal en su país.',
    videoStreamTitle: 'FLUJO DE VIDEO CPM Y STREAM INTERACTIVO',
    videoStreamSubtitle:
      'Visualización secuencial automática con micro-tareas de verificación instantánea.',
    backToHomeTitle: 'Volver al Inicio',
    adPlaying: '▶ REPRODUCIENDO',
    adLoading: '⏳ CARGANDO...',
    audioOn: 'Audio ON',
    audioMute: 'Silencio',
    closeBtn: 'Cerrar',
    advertisementLabel: 'PUBLICIDAD',
    compartmentLabel: 'Compartimento',
    directPartnerBadge: 'Socio Oficial',
    s2sDirectBadge: 'S2S Directo',
    web3InstantBadge: 'API Web3 Instantánea',
    step1MailTemplate: (mail) => `Copia o abre el correo de ${mail} indicado arriba.`,
    step1WalletTemplate: (wallet) => `Prepara o abre tu cuenta gratuita en ${wallet}.`,
    step1DirectTemplate: (name) => `Accede al portal oficial verificado de ${name}.`,
    step2OpenTemplate: (name, mail) =>
      mail
        ? `Haz clic en iniciar para abrir ${name} y regístrate con ${mail}.`
        : `Haz clic en iniciar para abrir la página oficial de ${name}.`,
    step3CompleteTemplate: (duration, currencies) =>
      `Completa la actividad (${duration}) para activar la verificación S2S y el abono (${currencies}).`,
    step3ServiceTemplate: (name) =>
      `Utiliza directamente el servicio oficial de ${name} en su portal verificado.`,
  },
  fr: {
    legalTitle: 'Mentions Légales Internationales & Clause de Non-Responsabilité',
    legalPoint1:
      '1. Programme de Fidélité (Zéro Dépôt Fiat) : ActionFlow Hub fonctionne exclusivement comme un programme promotionnel de points de fidélité numériques (PT). La plateforme n’est pas une banque et ne collecte aucun dépôt ou investissement.',
    legalPoint2:
      '2. Paiement via Passerelles Indépendantes : Les retraits en devise locale (via Airtm, Payeer, Volet) ou en actifs numériques (Portefeuilles Non-Custodiaux) sont traités par des prestataires tiers indépendants dans plus de 190 pays.',
    legalPoint3:
      '3. Absence de Subordination & Autonomie Fiscale : La participation est libre et occasionnelle, sans contrat de travail. Chaque utilisateur est seul responsable de ses obligations fiscales dans son pays de résidence.',
    threeStrikeTitle: 'Protocole Strict 3-Strike (Utilisateurs & Fournisseurs)',
    threeStrikeStatusRegular: 'STATUT : RÉGULIER (0/3)',
    strike1Desc: '1re erreur tolérée',
    strike2Label: '2 = AVERTISSEMENT',
    strike2Desc: 'Avertissement sévère + pénalité',
    strike3Label: '3 = BLOCAGE',
    strike3Desc: 'Vérification & Blocage immédiat',
    pointsRedeemSummary:
      'Vos Points d’Action (PT) sont convertibles en Espèces en Devise Locale (EUR, USD, CNY, Dirham, etc. via Airtm, Payeer, Volet) ou en Crypto Directe (USDT, TON, Solana, Pi).',
    internationalDisclaimerText:
      'Avis International : ActionFlow Hub est un programme promotionnel gratuit de points de fidélité (zéro dépôt et zéro investissement). Chaque utilisateur opère en totale autonomie fiscale selon les lois de son pays.',
    videoStreamTitle: 'FLUX VIDÉO CPM & STREAM INTERACTIF',
    videoStreamSubtitle:
      'Visionnage séquentiel automatique avec micro-tâches de vérification instantanée.',
    backToHomeTitle: 'Retour à l’Accueil',
    adPlaying: '▶ EN LECTURE',
    adLoading: '⏳ CHARGEMENT...',
    audioOn: 'Audio ON',
    audioMute: 'Muet',
    closeBtn: 'Fermer',
    advertisementLabel: 'PUBLICITÉ',
    compartmentLabel: 'Compartiment',
    directPartnerBadge: 'Partenaire Officiel',
    s2sDirectBadge: 'S2S Direct',
    web3InstantBadge: 'API Web3 Instantanée',
    step1MailTemplate: (mail) => `Copiez ou ouvrez l'adresse ${mail} indiquée ci-dessus.`,
    step1WalletTemplate: (wallet) => `Préparez ou ouvrez votre compte gratuit sur ${wallet}.`,
    step1DirectTemplate: (name) => `Accédez au portail officiel vérifié de ${name}.`,
    step2OpenTemplate: (name, mail) =>
      mail
        ? `Cliquez sur démarrer pour ouvrir ${name} et inscrivez-vous avec ${mail}.`
        : `Cliquez sur démarrer pour ouvrir la page officielle de ${name}.`,
    step3CompleteTemplate: (duration, currencies) =>
      `Terminez l'activité (${duration}) pour activer la vérification S2S et le crédit (${currencies}).`,
    step3ServiceTemplate: (name) =>
      `Utilisez directement le service officiel ${name} sur le portail vérifié.`,
  },
  de: {
    legalTitle: 'Internationaler Rechtshinweis & Haftungsausschluss',
    legalPoint1:
      '1. Treueprogramm (Keine Fiat-Einzahlungen): ActionFlow Hub arbeitet ausschließlich als digitales Treuepunkteprogramm (PT). Die Plattform ist keine Bank und nimmt keine Einzahlungen oder Investitionen entgegen.',
    legalPoint2:
      '2. Auszahlung über unabhängige Drittanbieter: Auszahlungen in Landeswährung (über Airtm, Payeer, Volet) oder digitalen Assets (Non-Custodial Wallets) erfolgen durch unabhängige Drittanbieter in über 190 Ländern.',
    legalPoint3:
      '3. Keine Beschäftigung & Steuerliche Eigenverantwortung: Die Teilnahme ist freiwillig. Jeder Nutzer ist für die steuerliche Meldung in seinem Wohnsitzland selbst verantwortlich.',
    threeStrikeTitle: 'Striktes 3-Strike-Protokoll (Nutzer & Anbieter)',
    threeStrikeStatusRegular: 'STATUS: REGULÄR (0/3)',
    strike1Desc: '1. Fehler toleriert',
    strike2Label: '2 = WARNUNG',
    strike2Desc: 'Strenge Warnung + Strafe',
    strike3Label: '3 = SPERRE',
    strike3Desc: 'Sofortige Prüfung & Sperre',
    pointsRedeemSummary:
      'Ihre Aktionspunkte (PT) können in Bargeld in Landeswährung (EUR, USD, CNY usw. über Airtm, Payeer, Volet) oder direkt in Krypto (USDT, TON, Solana, Pi) eingelöst werden.',
    internationalDisclaimerText:
      'Internationaler Haftungsausschluss: ActionFlow Hub ist ein kostenloses Treuepunkteprogramm (keine Einzahlungen, keine Investitionen). Jeder Nutzer handelt in voller steuerlicher Eigenverantwortung gemäß den Gesetzen seines Wohnsitzlandes.',
    videoStreamTitle: 'CPM-VIDEOSTREAM & INTERAKTIVER ABLAUF',
    videoStreamSubtitle:
      'Automatische sequenzielle Wiedergabe mit sofortigen Verifizierungs-Mikroaufgaben.',
    backToHomeTitle: 'Zurück zur Startseite',
    adPlaying: '▶ WIEDERGABE',
    adLoading: '⏳ LÄDT...',
    audioOn: 'Ton AN',
    audioMute: 'Stumm',
    closeBtn: 'Schließen',
    advertisementLabel: 'WERBUNG',
    compartmentLabel: 'Postfach',
    directPartnerBadge: 'Offizieller Partner',
    s2sDirectBadge: 'Direktes S2S',
    web3InstantBadge: 'Sofortige Web3-API',
    step1MailTemplate: (mail) => `Kopieren oder öffnen Sie die oben angezeigte Adresse ${mail}.`,
    step1WalletTemplate: (wallet) => `Bereiten Sie Ihr kostenloses Konto bei ${wallet} vor.`,
    step1DirectTemplate: (name) => `Öffnen Sie das verifizierte offizielle Portal von ${name}.`,
    step2OpenTemplate: (name, mail) =>
      mail
        ? `Klicken Sie auf Start, um ${name} zu öffnen, und registrieren Sie sich mit ${mail}.`
        : `Klicken Sie auf Start, um die offizielle Seite von ${name} zu öffnen.`,
    step3CompleteTemplate: (duration, currencies) =>
      `Schließen Sie die Aktivität (${duration}) ab, um die S2S-Prüfung und Gutschrift (${currencies}) auszulösen.`,
    step3ServiceTemplate: (name) =>
      `Nutzen Sie den offiziellen Dienst von ${name} direkt über das verifizierte Portal.`,
  },
  pt: {
    legalTitle: 'Aviso Legal Internacional e Isenção de Responsabilidade',
    legalPoint1:
      '1. Programa de Fidelidade (Zero Depósitos Fiat): O ActionFlow Hub opera exclusivamente como programa promocional de pontos de fidelidade digitais (PT). A plataforma não é um banco nem recebe depósitos ou investimentos.',
    legalPoint2:
      '2. Pagamento via Gateways Independentes: Os resgates em moeda local (via Airtm, Payeer, Volet, Pix) ou ativos digitais (Carteiras Não-Custodiais) são processados por provedores independentes em mais de 190 países.',
    legalPoint3:
      '3. Autonomia Fiscal e Sem Vínculo Empregatício: A participação é livre e ocasional. Cada usuário é exclusivamente responsável por suas obrigações fiscais em seu país de residência.',
    threeStrikeTitle: 'Protocolo Rígido 3-Strike (Usuários e Provedores)',
    threeStrikeStatusRegular: 'STATUS: REGULAR (0/3)',
    strike1Desc: '1º erro tolerado',
    strike2Label: '2 = AVISO',
    strike2Desc: 'Aviso severo + penalidade',
    strike3Label: '3 = BLOQUEIO',
    strike3Desc: 'Verificação e Bloqueio imediato',
    pointsRedeemSummary:
      'Seus Pontos de Ação (PT) podem ser resgatados em Dinheiro na Moeda Local (BRL Pix, EUR, USD via Airtm, Payeer, Volet) ou em Cripto Direta (USDT, TON, Solana, Pi).',
    internationalDisclaimerText:
      'Isenção Internacional: O ActionFlow Hub é um programa promocional gratuito de pontos de fidelidade (zero depósitos e zero investimentos). Cada usuário opera com total autonomia fiscal segundo as leis do seu país.',
    videoStreamTitle: 'FLUXO DE VÍDEO CPM & STREAM INTERATIVO',
    videoStreamSubtitle:
      'Visualização sequencial automática com micro-tarefas de verificação instantânea.',
    backToHomeTitle: 'Voltar ao Início',
    adPlaying: '▶ REPRODUZINDO',
    adLoading: '⏳ CARREGANDO...',
    audioOn: 'Áudio ON',
    audioMute: 'Mudo',
    closeBtn: 'Fechar',
    advertisementLabel: 'PUBLICIDADE',
    compartmentLabel: 'Compartimento',
    directPartnerBadge: 'Parceiro Oficial',
    s2sDirectBadge: 'S2S Direto',
    web3InstantBadge: 'API Web3 Instantânea',
    step1MailTemplate: (mail) => `Copie ou abra o e-mail ${mail} indicado acima.`,
    step1WalletTemplate: (wallet) => `Prepare ou abra sua conta gratuita em ${wallet}.`,
    step1DirectTemplate: (name) => `Acesse o portal oficial verificado de ${name}.`,
    step2OpenTemplate: (name, mail) =>
      mail
        ? `Clique em iniciar para abrir ${name} e cadastre-se com ${mail}.`
        : `Clique em iniciar para abrir a página oficial de ${name}.`,
    step3CompleteTemplate: (duration, currencies) =>
      `Conclua a atividade (${duration}) para ativar a verificação S2S e o crédito (${currencies}).`,
    step3ServiceTemplate: (name) =>
      `Utilize diretamente o serviço oficial ${name} no portal verificado.`,
  },
  ru: {
    legalTitle: 'Международное правовое уведомление и отказ от ответственности',
    legalPoint1:
      '1. Программа лояльности (без депозитов): ActionFlow Hub работает исключительно как бонусная программа цифровых баллов (PT). Платформа не является банком и не принимает депозиты или инвестиции.',
    legalPoint2:
      '2. Выплаты через независимые шлюзы: Вывод в местной валюте (через Airtm, Payeer, Volet) или цифровых активах (некастодиальные кошельки) обрабатывается независимыми провайдерами в 190+ странах.',
    legalPoint3:
      '3. Налоговая самостоятельность: Участие является добровольным. Каждый пользователь самостоятельно несет ответственность за соблюдение налогового законодательства своей страны.',
    threeStrikeTitle: 'Строгий протокол 3-Strike (Пользователи и Провайдеры)',
    threeStrikeStatusRegular: 'СТАТУС: АКТИВЕН (0/3)',
    strike1Desc: '1-я ошибка допустима',
    strike2Label: '2 = ПРЕДУПРЕЖДЕНИЕ',
    strike2Desc: 'Строгое предупреждение',
    strike3Label: '3 = БЛОКИРОВКА',
    strike3Desc: 'Проверка и блокировка',
    pointsRedeemSummary:
      'Ваши баллы (PT) можно вывести наличными в местной валюте (RUB, USD, EUR и др. через Airtm, Payeer, Volet) или напрямую в крипто (USDT, TON, Solana, Pi).',
    internationalDisclaimerText:
      'Международный отказ от ответственности: ActionFlow Hub — бесплатная бонусная программа (без вложений и депозитов). Все выплаты осуществляются через независимые платежные шлюзы.',
    videoStreamTitle: 'CPM ВИДЕОПОТОК И ИНТЕРАКТИВНЫЙ СТРИМ',
    videoStreamSubtitle:
      'Автоматический последовательный просмотр с мгновенной проверкой микро-заданий.',
    backToHomeTitle: 'На главную',
    adPlaying: '▶ ВОСПРОИЗВЕДЕНИЕ',
    adLoading: '⏳ ЗАГРУЗКА...',
    audioOn: 'Звук ВКЛ',
    audioMute: 'Без звука',
    closeBtn: 'Закрыть',
    advertisementLabel: 'РЕКЛАМА',
    compartmentLabel: 'Отсек почты',
    directPartnerBadge: 'Официальный партнер',
    s2sDirectBadge: 'Прямой S2S',
    web3InstantBadge: 'Мгновенный Web3 API',
    step1MailTemplate: (mail) => `Скопируйте или откройте почту ${mail}, указанную выше.`,
    step1WalletTemplate: (wallet) => `Подготовьте или откройте бесплатный аккаунт в ${wallet}.`,
    step1DirectTemplate: (name) => `Перейдите на проверенный официальный портал ${name}.`,
    step2OpenTemplate: (name, mail) =>
      mail
        ? `Нажмите кнопку запуска, чтобы открыть ${name}, и зарегистрируйтесь с ${mail}.`
        : `Нажмите кнопку запуска, чтобы открыть официальную страницу ${name}.`,
    step3CompleteTemplate: (duration, currencies) =>
      `Выполните действие (${duration}) для S2S-проверки и начисления (${currencies}).`,
    step3ServiceTemplate: (name) =>
      `Используйте официальный сервис ${name} напрямую на проверенном портале.`,
  },
  zh: {
    legalTitle: '国际法律声明与免责声明',
    legalPoint1:
      '1. 忠诚度积分性质（零法币存款）：ActionFlow Hub 仅作为数字促销忠诚度积分 (PT) 计划运营。本平台不是银行，不向用户收取任何存款或投资。',
    legalPoint2:
      '2. 独立第三方网关兑付：本地货币现金提现（通过 Airtm、Payeer、Volet，支持微信/支付宝）或数字资产提现均由覆盖 190 多个国家的独立第三方提供商处理。',
    legalPoint3:
      '3. 无雇佣关系与税务自主：参与促销活动完全自愿。每位用户独自承担其居住国法律规定的税务申报义务。',
    threeStrikeTitle: '严格三振出局协议 (3-Strike：用户与供应商)',
    threeStrikeStatusRegular: '状态：正常 (0/3)',
    strike1Desc: '第1次失误容忍',
    strike2Label: '2 = 警告',
    strike2Desc: '严厉警告 + 降权',
    strike3Label: '3 = 封锁',
    strike3Desc: '立即核查并封锁',
    pointsRedeemSummary:
      '您的行动积分 (PT) 可兑换为本地货币现金（人民币微信/支付宝、欧元、美元等，通过 Airtm、Payeer、Volet）或直接加密货币（USDT、TON、Solana、Pi）。',
    internationalDisclaimerText:
      '国际免责声明：ActionFlow Hub 是免费的促销积分计划（零存款、零投资）。最终兑换由独立第三方网关处理，用户按居住国法律自主纳税。',
    videoStreamTitle: 'CPM 视频流与互动播放',
    videoStreamSubtitle: '高收益自动连续播放与即时微任务验证。',
    backToHomeTitle: '返回首页',
    adPlaying: '▶ 正在播放',
    adLoading: '⏳ 加载中...',
    audioOn: '开启声音',
    audioMute: '静音',
    closeBtn: '关闭',
    advertisementLabel: '广告',
    compartmentLabel: '专用邮箱',
    directPartnerBadge: '官方合作伙伴',
    s2sDirectBadge: 'S2S 直连',
    web3InstantBadge: 'Web3 即时 API',
    step1MailTemplate: (mail) => `复制或打开上方显示的 ${mail} 邮箱。`,
    step1WalletTemplate: (wallet) => `准备或免费注册您的 ${wallet} 账户。`,
    step1DirectTemplate: (name) => `访问经过验证的 ${name} 官方门户。`,
    step2OpenTemplate: (name, mail) =>
      mail
        ? `点击开始按钮打开 ${name} 并使用 ${mail} 注册。`
        : `点击开始按钮打开 ${name} 官方网站。`,
    step3CompleteTemplate: (duration, currencies) =>
      `完成所需任务 (${duration}) 以触发 S2S 验证并获得奖励 (${currencies})。`,
    step3ServiceTemplate: (name) => `直接在经过验证的门户上使用 ${name} 官方服务。`,
  },
  ja: {
    legalTitle: '国際法的通知および免責事項',
    legalPoint1:
      '1. ロイヤルティプログラムの性質（法定通貨の預金ゼロ）：ActionFlow Hubはデジタルポイント（PT）プログラムとしてのみ運営されています。銀行ではなく、ユーザーからの預金や投資は一切受け付けません。',
    legalPoint2:
      '2. 独立した第三者ゲートウェイによる支払い：現地通貨での現金化（Airtm、Payeer、Volet経由）および暗号資産（非カストディアルウォレット経由）は190カ国以上の独立プロバイダーによって処理されます。',
    legalPoint3:
      '3. 雇用関係なし・税務上の自己責任：参加は任意であり、雇用関係はありません。各ユーザーは居住国の税法に従い自己責任で申告を行います。',
    threeStrikeTitle: '厳格な3ストライク・プロトコル（ユーザー＆プロバイダー）',
    threeStrikeStatusRegular: 'ステータス：正常 (0/3)',
    strike1Desc: '1回目のエラーは許容',
    strike2Label: '2 = 警告',
    strike2Desc: '厳重警告＋ペナルティ',
    strike3Label: '3 = ブロック',
    strike3Desc: '即時確認＆ブロック',
    pointsRedeemSummary:
      '獲得したアクションポイント（PT）は現地通貨の現金（Airtm、Payeer、Volet経由）または暗号資産（USDT、TON、Solana、Pi）に交換できます。',
    internationalDisclaimerText:
      '国際免責事項：ActionFlow Hubは無料のプロモーションポイントプログラム（預金ゼロ・投資ゼロ）です。最終的な換金は独立した第三者ゲートウェイを通じて行われます。',
    videoStreamTitle: 'CPM ビデオストリーム＆インタラクティブ再生',
    videoStreamSubtitle: '即時確認マイクロタスク付きの自動連続再生ストリーム。',
    backToHomeTitle: 'ホームに戻る',
    adPlaying: '▶ 再生中',
    adLoading: '⏳ 読み込み中...',
    audioOn: '音声 ON',
    audioMute: 'ミュート',
    closeBtn: '閉じる',
    advertisementLabel: '広告',
    compartmentLabel: '専用メール区分',
    directPartnerBadge: '公式パートナー',
    s2sDirectBadge: 'S2S ダイレクト',
    web3InstantBadge: '即時 Web3 API',
    step1MailTemplate: (mail) => `上に表示されている ${mail} のメールアドレスをコピーまたは開きます。`,
    step1WalletTemplate: (wallet) => `${wallet} の無料アカウントを準備または作成します。`,
    step1DirectTemplate: (name) => `${name} の公式認証ポータルにアクセスします。`,
    step2OpenTemplate: (name, mail) =>
      mail
        ? `開始ボタンをクリックして ${name} を開き、${mail} で登録します。`
        : `開始ボタンをクリックして ${name} の公式ページを開きます。`,
    step3CompleteTemplate: (duration, currencies) =>
      `タスク（${duration}）を完了すると、S2S認証と報酬（${currencies}）が有効になります。`,
    step3ServiceTemplate: (name) => `認証ポータルで ${name} の公式サービスを直接ご利用ください。`,
  },
  ko: {
    legalTitle: '국제 법적 고지 및 면책 조항',
    legalPoint1:
      '1. 로열티 프로그램 성격 (법정화폐 예치금 제로): ActionFlow Hub는 디지털 포인트(PT) 프로모션 프로그램으로만 운영됩니다. 당사는 은행이 아니며 예치금이나 투자를 받지 않습니다.',
    legalPoint2:
      '2. 독립 제3자 게이트웨이를 통한 지급: 현지 통화 현금 출금(Airtm, Payeer, Volet) 및 디지털 자산 출금(비수탁형 지갑)은 190개국 이상의 독립 제공업체에서 처리됩니다.',
    legalPoint3:
      '3. 고용 관계 없음 및 세무 자율성: 참여는 자율적이며 고용 관계가 성립하지 않습니다. 각 사용자는 거주 국가의 세법에 따라 납세 의무를 집니다.',
    threeStrikeTitle: '엄격한 3-Strike 프로토콜 (사용자 및 제공업체)',
    threeStrikeStatusRegular: '상태: 정상 (0/3)',
    strike1Desc: '1차 오류 허용',
    strike2Label: '2 = 경고',
    strike2Desc: '엄중 경고 + 페널티',
    strike3Label: '3 = 차단',
    strike3Desc: '즉시 검증 및 차단',
    pointsRedeemSummary:
      '액션 포인트(PT)는 현지 통화 현금(Airtm, Payeer, Volet 경유) 또는 직접 암호화폐(USDT, TON, Solana, Pi)로 출금할 수 있습니다.',
    internationalDisclaimerText:
      '국제 면책 조항: ActionFlow Hub는 무료 로열티 포인트 프로그램(예치금 및 투자 제로)입니다. 모든 환전은 독립된 제3자 게이트웨이를 통해 이루어집니다.',
    videoStreamTitle: 'CPM 비디오 스트림 & 인터랙티브 플레이어',
    videoStreamSubtitle: '즉시 검증 마이크로 태스크가 포함된 자동 연속 스트리밍.',
    backToHomeTitle: '홈으로 돌아가기',
    adPlaying: '▶ 재생 중',
    adLoading: '⏳ 로딩 중...',
    audioOn: '오디오 켜기',
    audioMute: '음소거',
    closeBtn: '닫기',
    advertisementLabel: '광고',
    compartmentLabel: '전용 메일함',
    directPartnerBadge: '공식 파트너',
    s2sDirectBadge: 'S2S 다이렉트',
    web3InstantBadge: '즉시 Web3 API',
    step1MailTemplate: (mail) => `위에 표시된 ${mail} 주소를 복사하거나 엽니다.`,
    step1WalletTemplate: (wallet) => `${wallet}에서 무료 계정을 준비하거나 개설합니다.`,
    step1DirectTemplate: (name) => `${name}의 공식 인증 포털에 접속합니다.`,
    step2OpenTemplate: (name, mail) =>
      mail
        ? `시작 버튼을 눌러 ${name}을(를) 열고 ${mail}로 가입합니다.`
        : `시작 버튼을 눌러 ${name} 공식 페이지를 엽니다.`,
    step3CompleteTemplate: (duration, currencies) =>
      `활동(${duration})을 완료하면 S2S 검증 및 보상(${currencies})이 적립됩니다.`,
    step3ServiceTemplate: (name) => `인증된 포털에서 ${name} 공식 서비스를 직접 이용하세요.`,
  },
  ar: {
    legalTitle: 'إشعار قانوني دولي وإخلاء مسؤولية',
    legalPoint1:
      '1. طبيعة برنامج الولاء (صفر إيداعات مالية): يعمل ActionFlow Hub حصرياً كبرنامج ترويجي لنقاط الولاء الرقمية (PT). المنصة ليست بنكاً ولا تجمع أي إيداعات أو استثمارات من المستخدمين.',
    legalPoint2:
      '2. الصرف عبر بوابات خارجية مستقلة: تتم عمليات السحب النقدي بالعملة المحلية (عبر Airtm و Payeer و Volet) أو الأصول الرقمية (المحافظ غير الحاضنة) بواسطة مزودين مستقلين في أكثر من 190 دولة.',
    legalPoint3:
      '3. عدم وجود علاقة عمل والاستقلالية الضريبية: المشاركة طوعية ومستقلة تماماً، ويتحمل كل مستخدم المسؤولية الضريبية وفق قوانين بلد إقامته.',
    threeStrikeTitle: 'بروتوكول 3-Strike الصارم (للمستخدمين والمزودين)',
    threeStrikeStatusRegular: 'الحالة: نظامي (0/3)',
    strike1Desc: 'الخطأ الأول مسموح',
    strike2Label: '2 = تحذير',
    strike2Desc: 'تحذير شديد + عقوبة',
    strike3Label: '3 = حظر',
    strike3Desc: 'تحقق وحظر فوري',
    pointsRedeemSummary:
      'يمكن استبدال نقاطك (PT) نقداً بعملتك المحلية (اليورو، الدولار، الدرهم، الجنيه المصري، الريال عبر Airtm و Payeer و Volet) أو بالعملات الرقمية المباشرة (USDT، TON، Solana، Pi).',
    internationalDisclaimerText:
      'إخلاء مسؤولية دولي: ActionFlow Hub هو برنامج نقاط ولاء ترويجي مجاني (بدون إيداع وبدون استثمار). تتم التحويلات النهائية عبر بوابات طرف ثالث مستقلة.',
    videoStreamTitle: 'بث فيديو CPM وتدفق تفاعلي',
    videoStreamSubtitle: 'مشاهدة متسلسلة تلقائية مع مهام تحقق فورية.',
    backToHomeTitle: 'العودة إلى الرئيسية',
    adPlaying: '▶ قيد التشغيل',
    adLoading: '⏳ جاري التحميل...',
    audioOn: 'تشغيل الصوت',
    audioMute: 'كتم الصوت',
    closeBtn: 'إغلاق',
    advertisementLabel: 'إعلان',
    compartmentLabel: 'صندوق بريد مخصص',
    directPartnerBadge: 'شريك رسمي',
    s2sDirectBadge: 'ربط S2S مباشر',
    web3InstantBadge: 'Web3 API فوري',
    step1MailTemplate: (mail) => `انسخ أو افتح بريد ${mail} الموضح أعلاه.`,
    step1WalletTemplate: (wallet) => `جهز أو افتح حسابك المجاني على ${wallet}.`,
    step1DirectTemplate: (name) => `ادخل إلى البوابة الرسمية الموثقة لـ ${name}.`,
    step2OpenTemplate: (name, mail) =>
      mail
        ? `اضغط على زر البدء لفتح ${name} وسجل باستخدام ${mail}.`
        : `اضغط على زر البدء لفتح الصفحة الرسمية لـ ${name}.`,
    step3CompleteTemplate: (duration, currencies) =>
      `أكمل النشاط المطلوب (${duration}) لتفعيل تحقق S2S وإضافة الرصيد (${currencies}).`,
    step3ServiceTemplate: (name) => `استخدم خدمة ${name} الرسمية مباشرة من البوابة الموثقة.`,
  },
  hi: {
    legalTitle: 'अंतर्राष्ट्रीय कानूनी सूचना और अस्वीकरण',
    legalPoint1:
      '1. लॉयल्टी प्रोग्राम की प्रकृति (शून्य जमा): ActionFlow Hub केवल डिजिटल लॉयल्टी पॉइंट्स (PT) प्रोग्राम के रूप में कार्य करता है। यह कोई बैंक नहीं है और उपयोगकर्ताओं से कोई जमा या निवेश नहीं लेता है।',
    legalPoint2:
      '2. स्वतंत्र थर्ड-पार्टी गेटवे द्वारा भुगतान: स्थानीय मुद्रा में नकद निकासी (Airtm, Payeer, Volet के माध्यम से) या क्रिप्टो निकासी 190+ देशों में स्वतंत्र प्रदाताओं द्वारा संसाधित की जाती है।',
    legalPoint3:
      '3. कोई रोजगार संबंध नहीं और कर स्वायत्तता: भागीदारी स्वैच्छिक है। प्रत्येक उपयोगकर्ता अपने निवास देश के कानूनों के अनुसार कर दायित्वों के लिए स्वयं जिम्मेदार है।',
    threeStrikeTitle: 'सख्त 3-Strike प्रोटोकॉल (उपयोगकर्ता और प्रदाता)',
    threeStrikeStatusRegular: 'स्थिति: नियमित (0/3)',
    strike1Desc: 'पहली त्रुटि मान्य',
    strike2Label: '2 = चेतावनी',
    strike2Desc: 'सख्त चेतावनी + पेनल्टी',
    strike3Label: '3 = ब्लॉक',
    strike3Desc: 'तत्काल सत्यापन और ब्लॉक',
    pointsRedeemSummary:
      'आपके एक्शन पॉइंट्स (PT) को स्थानीय मुद्रा नकद (INR, USD, EUR, BDT आदि Airtm, Payeer, Volet द्वारा) या डायरेक्ट क्रिप्टो (USDT, TON, Solana, Pi) में भुनाया जा सकता है।',
    internationalDisclaimerText:
      'अंतर्राष्ट्रीय अस्वीकरण: ActionFlow Hub एक निःशुल्क प्रचार लॉयल्टी प्रोग्राम है (शून्य जमा और शून्य निवेश)। सभी अंतिम भुगतान स्वतंत्र गेटवे द्वारा किए जाते हैं।',
    videoStreamTitle: 'CPM वीडियो स्ट्रीम और इंटरैक्टिव फ्लो',
    videoStreamSubtitle: 'त्वरित सत्यापन माइक्रो-टास्क के साथ स्वचालित वीडियो स्ट्रीमिंग।',
    backToHomeTitle: 'होम पर वापस जाएं',
    adPlaying: '▶ चल रहा है',
    adLoading: '⏳ लोड हो रहा है...',
    audioOn: 'ऑडियो चालू',
    audioMute: 'म्यूट',
    closeBtn: 'बंद करें',
    advertisementLabel: 'विज्ञापन',
    compartmentLabel: 'ईमेल कम्पार्टमेंट',
    directPartnerBadge: 'आधिकारिक पार्टनर',
    s2sDirectBadge: 'डायरेक्ट S2S',
    web3InstantBadge: 'इंस्टेंट Web3 API',
    step1MailTemplate: (mail) => `ऊपर दिए गए ${mail} ईमेल को कॉपी करें या खोलें।`,
    step1WalletTemplate: (wallet) => `${wallet} पर अपना निःशुल्क खाता तैयार करें या खोलें।`,
    step1DirectTemplate: (name) => `${name} के सत्यापित आधिकारिक पोर्टल पर जाएं।`,
    step2OpenTemplate: (name, mail) =>
      mail
        ? `${name} खोलने के लिए स्टार्ट बटन दबाएं और ${mail} से साइन अप करें।`
        : `${name} का आधिकारिक पेज खोलने के लिए स्टार्ट बटन दबाएं।`,
    step3CompleteTemplate: (duration, currencies) =>
      `S2S सत्यापन और क्रेडिट (${currencies}) प्राप्त करने के लिए गतिविधि (${duration}) पूरी करें।`,
    step3ServiceTemplate: (name) => `सत्यापित पोर्टल पर सीधे आधिकारिक ${name} सेवा का उपयोग करें।`,
  },
  tr: {
    legalTitle: 'Uluslararası Yasal Bildirim ve Sorumluluk Reddi',
    legalPoint1:
      '1. Sadakat Programı Niteliği (Sıfır Fiat Yatırımı): ActionFlow Hub yalnızca dijital sadakat puanları (PT) programı olarak faaliyet gösterir. Platform bir banka değildir, kullanıcılardan depozito veya yatırım toplamaz.',
    legalPoint2:
      '2. Bağımsız Üçüncü Taraf Geçitleri ile Ödeme: Yerel para birimi nakit çekimleri (Airtm, Payeer, Volet ile) veya kripto ödemeleri 190+ ülkede bağımsız sağlayıcılar tarafından işlenir.',
    legalPoint3:
      '3. İş İlişkisi Yoktur & Vergi Özerkliği: Katılım tamamen isteğe bağlıdır. Her kullanıcı ikamet ettiği ülkenin vergi yasalarına uymaktan tek başına sorumludur.',
    threeStrikeTitle: 'Katı 3-Strike Protokolü (Kullanıcılar ve Sağlayıcılar)',
    threeStrikeStatusRegular: 'DURUM: DÜZENLİ (0/3)',
    strike1Desc: '1. hata tolere edilir',
    strike2Label: '2 = UYARI',
    strike2Desc: 'Sert uyarı + ceza',
    strike3Label: '3 = ENGEL',
    strike3Desc: 'Anında Doğrulama ve Engelleme',
    pointsRedeemSummary:
      'Eylem Puanlarınız (PT), Yerel Para Birimi Nakit (TRY, EUR, USD vb. Airtm, Payeer, Volet üzerinden) veya Doğrudan Kripto (USDT, TON, Solana, Pi) olarak çekilebilir.',
    internationalDisclaimerText:
      'Uluslararası Sorumluluk Reddi: ActionFlow Hub ücretsiz bir sadakat puanı programıdır (sıfır yatırım ve sıfır depozito). Son ödemeler bağımsız üçüncü taraf ödeme geçitleri ile yapılır.',
    videoStreamTitle: 'CPM VİDEO AKIŞI VE ETKİLEŞİMLİ YAYIN',
    videoStreamSubtitle: 'Anında doğrulama görevleriyle otomatik sıralı video izleme.',
    backToHomeTitle: 'Ana Sayfaya Dön',
    adPlaying: '▶ OYNATILIYOR',
    adLoading: '⏳ YÜKLENİYOR...',
    audioOn: 'Ses AÇIK',
    audioMute: 'Sessiz',
    closeBtn: 'Kapat',
    advertisementLabel: 'REKLAM',
    compartmentLabel: 'E-posta Bölmesi',
    directPartnerBadge: 'Resmi Ortak',
    s2sDirectBadge: 'Doğrudan S2S',
    web3InstantBadge: 'Anında Web3 API',
    step1MailTemplate: (mail) => `Yukarıda gösterilen ${mail} adresini kopyalayın veya açın.`,
    step1WalletTemplate: (wallet) => `${wallet} üzerindeki ücretsiz hesabınızı hazırlayın veya açın.`,
    step1DirectTemplate: (name) => `${name} doğrulanmış resmi portalına erişin.`,
    step2OpenTemplate: (name, mail) =>
      mail
        ? `${name} sayfasını açmak için başlat düğmesine tıklayın ve ${mail} ile kaydolun.`
        : `${name} resmi sayfasını açmak için başlat düğmesine tıklayın.`,
    step3CompleteTemplate: (duration, currencies) =>
      `S2S doğrulamasını ve ödülü (${currencies}) etkinleştirmek için etkinliği (${duration}) tamamlayın.`,
    step3ServiceTemplate: (name) => `Doğrulanmış portalda doğrudan resmi ${name} hizmetini kullanın.`,
  },
  id: {
    legalTitle: 'Pemberitahuan Hukum Internasional & Penafian Tanggung Jawab',
    legalPoint1:
      '1. Program Loyalitas (Tanpa Deposit Fiat): ActionFlow Hub beroperasi khusus sebagai program poin loyalitas digital (PT). Platform ini bukan bank dan tidak mengumpulkan deposit atau investasi dari pengguna.',
    legalPoint2:
      '2. Pencairan melalui Gateway Pihak Ketiga Independen: Penarikan tunai mata uang lokal (melalui Airtm, Payeer, Volet) atau aset kripto (Dompet Non-Kustodial) diproses oleh penyedia independen di 190+ negara.',
    legalPoint3:
      '3. Tanpa Hubungan Kerja & Otonomi Pajak: Partisipasi bersifat sukarela. Setiap pengguna bertanggung jawab penuh atas kewajiban pajak sesuai hukum negara tempat tinggalnya.',
    threeStrikeTitle: 'Protokol Ketat 3-Strike (Pengguna & Penyedia)',
    threeStrikeStatusRegular: 'STATUS: AKTIF (0/3)',
    strike1Desc: 'Kesalahan ke-1 ditoleransi',
    strike2Label: '2 = PERINGATAN',
    strike2Desc: 'Peringatan keras + penalti',
    strike3Label: '3 = BLOKIR',
    strike3Desc: 'Verifikasi & Blokir segera',
    pointsRedeemSummary:
      'Poin Aksi (PT) Anda dapat dicairkan ke Tunai Mata Uang Lokal (IDR, USD, EUR dll. melalui Airtm, Payeer, Volet) atau Kripto Langsung (USDT, TON, Solana, Pi).',
    internationalDisclaimerText:
      'Penafian Internasional: ActionFlow Hub adalah program poin loyalitas promosi gratis (tanpa deposit dan tanpa investasi). Konversi akhir dilakukan melalui gateway pihak ketiga independen.',
    videoStreamTitle: 'ALIRAN VIDEO CPM & STREAM INTERAKTIF',
    videoStreamSubtitle: 'Penayangan berurutan otomatis dengan tugas mikro verifikasi instan.',
    backToHomeTitle: 'Kembali ke Beranda',
    adPlaying: '▶ MEMUTAR',
    adLoading: '⏳ MEMUAT...',
    audioOn: 'Audio ON',
    audioMute: 'Bisu',
    closeBtn: 'Tutup',
    advertisementLabel: 'IKLAN',
    compartmentLabel: 'Kompartemen Email',
    directPartnerBadge: 'Mitra Resmi',
    s2sDirectBadge: 'S2S Langsung',
    web3InstantBadge: 'API Web3 Instan',
    step1MailTemplate: (mail) => `Salin atau buka alamat ${mail} yang tertera di atas.`,
    step1WalletTemplate: (wallet) => `Siapkan atau buka akun gratis Anda di ${wallet}.`,
    step1DirectTemplate: (name) => `Akses portal resmi terverifikasi dari ${name}.`,
    step2OpenTemplate: (name, mail) =>
      mail
        ? `Klik tombol mulai untuk membuka ${name} dan daftar menggunakan ${mail}.`
        : `Klik tombol mulai untuk membuka halaman resmi ${name}.`,
    step3CompleteTemplate: (duration, currencies) =>
      `Selesaikan aktivitas (${duration}) untuk mengaktifkan verifikasi S2S dan kredit (${currencies}).`,
    step3ServiceTemplate: (name) => `Gunakan layanan resmi ${name} langsung di portal terverifikasi.`,
  },
};

export function localizeProviderItem(
  provider: VerifiedProviderItem,
  lang: SupportedLang,
  t: TranslationStrings
): VerifiedProviderItem {
  if (lang === 'it') {
    return provider;
  }

  const extra = EXTRA_UI_LOCALIZATION[lang] || EXTRA_UI_LOCALIZATION.en;
  const id = provider.id.toLowerCase();

  // 1. Localize categoryLabel based on provider ID prefix & nav translations
  let categoryLabel = provider.categoryLabel;
  if (id.startsWith('game-')) {
    categoryLabel = `${t.nav.games || 'Games'} • ${extra.directPartnerBadge}`;
  } else if (id.startsWith('soap-')) {
    categoryLabel = `${t.nav.soap || 'Short Series & Video'} • ${extra.directPartnerBadge}`;
  } else if (id.startsWith('music-')) {
    categoryLabel = `${t.nav.music || 'Music'} • ${extra.directPartnerBadge}`;
  } else if (id.startsWith('ai-')) {
    categoryLabel = `${t.nav.ai || 'Voice & Photo AI'} • ${extra.directPartnerBadge}`;
  } else if (id.startsWith('ocr-')) {
    categoryLabel = `${t.nav.ocr || 'Receipt OCR'} • ${extra.directPartnerBadge}`;
  } else if (id.startsWith('ux-') || id.startsWith('qa-')) {
    categoryLabel = `${t.nav.ux_qa || 'UX & Surveys'} • ${extra.directPartnerBadge}`;
  } else if (id.startsWith('depin-')) {
    categoryLabel = `${t.nav.depin || 'DePIN Nodes'} • ${extra.directPartnerBadge}`;
  } else if (id.startsWith('shop-') || id.startsWith('card-')) {
    categoryLabel = `${t.nav.shopping || 'Cards & Vouchers'} • ${extra.directPartnerBadge}`;
  } else if (id.startsWith('airdrop-') || id.startsWith('ton-') || id.startsWith('exch-')) {
    categoryLabel = `${t.nav.airdrop || 'Airdrop & Crypto'} • ${extra.directPartnerBadge}`;
  }

  // 2. Localize compartmentEmail
  const compartmentEmail = provider.compartmentEmail
    ? provider.compartmentEmail.replace(/Compartimento/gi, extra.compartmentLabel)
    : undefined;

  // 3. Localize modalityBadge
  let modalityBadge = provider.modalityBadge;
  if (provider.isServiceOnly) {
    modalityBadge = t.ui.directServiceBadge;
  } else if (modalityBadge.toLowerCase().includes('web3')) {
    modalityBadge = extra.web3InstantBadge;
  } else {
    modalityBadge = extra.s2sDirectBadge;
  }

  // 4. Localize actionDuration
  let actionDuration = provider.actionDuration
    .replace(/minuti/gi, t.minutesShort)
    .replace(/min\b/gi, t.minutesShort)
    .replace(/Istantaneo/gi, 'Instant')
    .replace(/Passivo/gi, 'Passive')
    .replace(/Partita Iniziale|1ª Battaglia|Partita Rapida|Primo Livello/gi, 'Match')
    .replace(/Episodi Gratis|Episodi Iniziali|Clip Video/gi, 'Video')
    .replace(/Ascolto Brano|Recensione Brano/gi, 'Audio')
    .replace(/Scontrino/gi, 'OCR')
    .replace(/Sondaggio/gi, 'Survey')
    .replace(/Servizio Diretto/gi, t.ui.serviceBadge);

  // 5. Localize payoutInfo & photoSubtitle
  const payoutInfo = provider.isServiceOnly
    ? t.ui.directServiceBadge
    : extra.s2sDirectBadge;
  const photoSubtitle = modalityBadge.toUpperCase();

  // 6. Localize executionSteps
  const localizedSteps: string[] = provider.isServiceOnly
    ? [
        extra.step1DirectTemplate(provider.name),
        extra.step2OpenTemplate(provider.name),
        extra.step3ServiceTemplate(provider.name),
      ]
    : [
        compartmentEmail
          ? extra.step1MailTemplate(compartmentEmail)
          : provider.walletRequiredName
          ? extra.step1WalletTemplate(provider.walletRequiredName.replace(/^Conto\s+/i, ''))
          : extra.step1DirectTemplate(provider.name),
        extra.step2OpenTemplate(provider.name, compartmentEmail),
        extra.step3CompleteTemplate(actionDuration, provider.currencies),
      ];

  return {
    ...provider,
    categoryLabel,
    compartmentEmail,
    modalityBadge,
    actionDuration,
    payoutInfo,
    photoSubtitle,
    executionSteps: localizedSteps,
  };
}

const GIFT_VOUCHER_WORD: Record<SupportedLang, string> = {
  it: 'Voucher',
  en: 'Voucher',
  es: 'Tarjeta Regalo',
  fr: 'Carte Cadeau',
  de: 'Gutschein',
  pt: 'Vale-Presente',
  ru: 'Сертификат',
  zh: '礼品卡',
  ja: 'ギフトカード',
  ko: '기프트카드',
  ar: 'بطاقة هدايا',
  hi: 'गिफ्ट वाउचर',
  tr: 'Hediye Kartı',
  id: 'Voucher Hadiah',
};

const DENOMINATION_PREFIX: Record<SupportedLang, string> = {
  it: 'Tagli',
  en: 'Values',
  es: 'Importes',
  fr: 'Montants',
  de: 'Werte',
  pt: 'Valores',
  ru: 'Номинал',
  zh: '面额',
  ja: '額面',
  ko: '권종',
  ar: 'الفئات',
  hi: 'मूल्य',
  tr: 'Tutarlar',
  id: 'Nominal',
};

export function localizeInventoryItem<
  T extends { id: string; name: string; badge?: string; category?: string }
>(item: T, lang: SupportedLang): T {
  if (lang === 'it') return item;
  const voucherWord = GIFT_VOUCHER_WORD[lang] || 'Voucher';
  const denomWord = DENOMINATION_PREFIX[lang] || 'Values';

  const cleanBrand = item.name
    .replace(/\b(Gift Card|Gift Voucher|Official Voucher|Cash Voucher|Buono Carburante|Ricarica Ufficiale|Ricarica|Wallet Code)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const localizedName =
    lang === 'ar'
      ? `${voucherWord} ${cleanBrand}`
      : `${cleanBrand} ${voucherWord}`.trim();

  const localizedBadge = item.badge
    ? item.badge
        .replace(/^Tagli\b/i, denomWord)
        .replace(/Mesi/gi, 'Mo.')
        .replace(/Zero Pubblicità/gi, 'Ad-Free')
        .replace(/Monete Live/gi, 'Live Coins')
    : item.badge;

  return {
    ...item,
    name: localizedName,
    badge: localizedBadge,
  };
}

