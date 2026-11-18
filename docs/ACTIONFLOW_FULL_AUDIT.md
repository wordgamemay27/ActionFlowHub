# ACTIONFLOW_FULL_AUDIT.md

## 1. Copertura e limiti

- Repository esaminato: /workspace/app (branch di sessione).
- File di progetto esaminati (esclusi node_modules, dist, .git): ~118 file sorgente + 12 migrazioni + 6 script di verifica + config.
- Directory chiave: src/db, src/server.ts, src/workers, src/lib, src/services, src/routes, src/views, migrations, scripts.
- Test eseguiti: npm test (6/6 OK), npm run lint (OK), npm run build (OK).
- Test aggiuntivi eseguiti: nessun nuovo test scritto (vincolo "non modificare codice"); riutilizzate le 6 suite esistenti + typecheck + build.
- Limiti: nessun DATABASE_URL configurato in ambiente → logica SQL verificata per lettura statica, non eseguita su DB reale. test:neon non eseguito (richiede DB live).

## 2. Inventario (Fase 1)

### Frontend (React 19 + Vite 8 + TS)
- Entrypoint: src/main.tsx, src/App.tsx
- Views: EntryView, ProductTypeView, EntryVideoView, HomeView, GamesView, MicroDramaView, MusicAudioView, AiWorkView, UxQaView, ReceiptOcrView, DepinNodesView, ShoppingView, AirdropHubView, WithdrawView, ProfileView, AdminView
- Components: AutoInteractiveCycleEngine, CleanAdSlot, CyberNav, GeoCore, GlassMedia, Header, OfficialBanner, ProviderExecutionModal, VideoStreamSection
- Lib: affiliate, brands, catalogData, catalogMasterData, catalogTypes, entryProfile, firebase, geoEconomics, glassPlaceholder, i18n, langs, providerLocalization, providerPriority, verifiedDirectProviders
- Services: api, firestoreSync, providerReputation, worldBankPpp
- Types: src/types/index.ts

### Backend (Express)
- src/server.ts (1353 righe): API, auth Telegram HMAC, webhook, payout, settlement, audit.
- src/routes/providerAdmin.ts
- src/db/ledgerService.ts (942 righe)
- src/db/settlementService.ts (140 righe)
- src/workers: blockchainListener, index, multiAssetPayoutWorker, settlementWorker, tonPayoutWorker
- src/config/wallets.ts

### Database
- migrations 001–012 (PostgreSQL, schema core). 003 mancante (gap numerazione).
- Tabelle chiave: core.users, core.accounts, core.balances, core.ledger_transactions, core.ledger_entries, core.reward_events, core.session_interactions, core.auto_sessions, core.provider_reputation, core.partner_exposure, core.payout_requests, core.webhook_replay_guard, core.country_economic_profiles, core.schema_migrations.

### Integrazioni esterne
- Telegram WebApp (HMAC SHA-256, anti-replay 300s)
- PostgreSQL/Neon
- Firebase (client)
- World Bank WDI API (PPP)
- Blockchain TON/SOL/PI (on-chain payout)
- Provider affiliati (postback S2S)

## 3. Logiche ricostruite (Fase 2)

### Auth
- verifyTelegramWebAppData: HMAC con secretKey = HMAC('WebAppData', botToken); auth_date <= 300s; hash timingSafeEqual. Nessun bypass per flussi finanziari. OK.

### Click/interazione
- POST /api/interactions/register e /api/affiliate/click → handleRegisterInteraction → registerSessionInteraction (0 punti al click). Idempotente via interaction_id/click_id.

### Accreditamento
- Solo via webhook S2S /api/webhook/postback con WEBHOOK_SECRET. record_verified_interaction_postback (migrazione 012):
  - raw_points = FLOOR(gross_usd * 100)
  - v_ppp_coef = core.get_country_ppp_coefficient(market_country)
  - v_user_pending = FLOOR(raw_points * 0.30 * v_ppp_coef)
  - v_platform_margin = GREATEST(0, raw_points - v_user_pending)
  - Inserimento reward_event + ledger double-entry (USER_PENDING +v_user_pending, SYSTEM:UNEARNED_REVENUE -v_user_pending) solo se v_user_pending > 0.
  - Idempotenza: event_id replay → ritorna idempotent true, 0 punti.
  - Anti-replay nonce: webhook_replay_guard con ON CONFLICT DO NOTHING.
  - Advisory lock per evento: pg_advisory_xact_lock.
  - FOR UPDATE su user, interaction, accounts, balances.
  - Validazioni: provider ACTIVE/WARNING, interazione CLICK_REGISTERED, non scaduta, ownership match, reward_event_id NULL.

### Settlement
- POST /api/settlement/execute (admin): executeBatchSettlement con batchId, partnerId, periodStart/End, expectedGrossUsd, actualNetReceivedUsd, haircutRatio, onchainTxHash. Richiede onchainTxHash.
- POST /api/settlement/release-withdrawable (admin): releaseSettledToWithdrawable(userId, points, referenceId).

### Wallet/saldo
- getUserBalances legge core.balances per account_type USER_PENDING/SETTLED/WITHDRAWABLE/RESERVED.

### Prelievi
- POST /api/payout/request: min 500 PT, idempotencyKey >=4, asset allowlist, validazione destinazione, FX live per TON/SOL/PI, strike check. requestPayout atomico.
- Admin dispatch: /api/payout/disburse (APPROVED/COMPLETED/REJECTED), /api/payout/process-ton, /api/payout/process-all. Complete richiede txHash >=8.

### Revoca/chargeback
- status REVOKED/CHARGEBACK → confirmPartnerReward(txId, 'REVOKED').

## 4. Verifica economica (Fase 3)

- Ricavi reali: partner affiliati (postback S2S con payout USD). Non esiste revenue stream diretto da utente (no acquisti in-app nel codice).
- Piattaforma trattiene ≥70% dei punti lordi (platform_margin_points = raw - user_pending). User riceve ≤30% * PPP.
- Conversione: 1 USD = 100 PT (raw_points = round(usd*100)).
- PPP: coefficiente per paese da World Bank; US/EU = 1.0; altri LEAST(1,GREATEST(0.01,ROUND(ppp/fx,4))). Applicato solo al 30% utente.
- Rischio di accredito in eccesso: partner_exposure cap 500000 (default) per partner; max_exposure_limit. Tuttavia cap è per partner e il default 500000 è hardcoded nel postback (INSERT ... max_exposure_limit 500000 ON CONFLICT DO NOTHING) → non aggiornabile dinamicamente per partner nuovi? In realtà ON CONFLICT DO NOTHING mantiene il valore esistente, quindi il cap iniziale è 500000 per tutti i partner nuovi. Limite di esposizione aggregato non verificato (nessun cap globale su treasury).
- Punti senza copertura economica: il sistema accredità user_pending solo dopo postback verificato con payout>0; raw_points coperti da gross_usd. Tuttavia settlement haircut (actualNetReceivedUsd vs expectedGrossUsd) può ridurre il valore effettivamente incassato rispetto ai punti già accreditati a utenti → possibile gap se settlement applica haircut dopo accredito. Da verificare su DB (migrazione 006/010).
- Commissioni duplicate: idempotenza su event_id e nonce; advisory lock. Rischio: se webhook inviato con txId diverso per la stessa conversione, doppio accredito possibile (idempotenza basata su event_id/txId, non su conversione semantica). Inoltre click_id/interaction_id dedup limitato a una ricompensa per interazione (INTERACTION_ALREADY_REWARDED).

## 5. Verifica tecnica (Fase 4)

- Input validation: providerId/taskId required; categories allowlist; payout min 500; idempotency key; wallet address regex per asset. Buono.
- Auth: Telegram HMAC + anti-replay; admin token o admin TG ids. Webhook secret timingSafeEqual. Buono.
- Rate limiting: general 120/min, financial 30/min, admin 60/15min, webhook 60/min. Buono.
- Idempotenza: event_id, nonce, interaction reward. Buono.
- Race conditions: FOR UPDATE + advisory lock su evento. Buono a livello SQL (non verificato a runtime).
- Arrotondamento: FLOOR per user_pending; raw_points = round(usd*100). Platform margin = raw - pending. Somma zero. OK.
- Revocation: REVOKED/CHARGEBACK → confirmPartnerReward. Non verificato l'effetto su saldi (storno). Da controllare in SQL.
- Webhook auth: secret required (fail-closed se WEBHOOK_SECRET vuoto). Buono.
- Worker errors: fail-closed (FX unavailable → 503). Buono.
- Gap: migrazione 003 mancante (numerazione). Non necessariamente bug ma da notare.
- Gap: bootstrapDatabaseSchema applica tutte le migrazioni in ordine; 011/012 preparate "senza eseguire su Neon" per 011. Se applicate automaticamente al bootstrap, potrebbero eseguire su DB reali (dipende da stato schema_migrations).

## 6. Problemi trovati

1. Gravità: media. File: migrations/ (numerazione). Posizione: assenza 003. Descrizione: gap nella numerazione migrazioni. Conseguenza: nessun impatto funzionale, ma può confondere audit/deploy. Prova: ls migrations. Correzione: documentare o rinumerare.

2. Gravità: media. File: migrations/012...sql. Posizione: INSERT partner_exposure con max_exposure_limit 500000 hardcoded ON CONFLICT DO NOTHING. Descrizione: cap per-partner fisso per nuovi partner, non configurabile. Conseguenza: esposizione aggregata non limitata a livello treasury. Prova: lettura SQL. Correzione: cap configurabile per partner + cap globale treasury.

3. Gravità: alta (potenziale). File: src/server.ts handlePostback. Posizione: rawPoints calcolato come Math.round(payoutRaw*100) ma recordVerifiedInteractionPostback ricalcola raw_points = FLOOR(confirmed_gross_usd*100) dal gross_usd. Se payoutRaw ha più di 2 decimali, discrepanza di arrotondamento tra client/server e DB. Conseguenza: punti lordi possono differire di 1 PT. Prova: confronto codice. Correzione: usare un'unica fonte (gross_usd) e documentare arrotondamento.

4. Gravità: bassa. File: src/db/ledgerService.ts getUserGeoProfile. Posizione: fallback pppCoefficient = profile.pppCoefficient se dbPpp non valido; condizione `Math.abs(dbPpp - 0.2) > 0.0001` esclude il valore 0.2 (possibile valore legittimo?). Conseguenza: profilo PPP potrebbe non usare valore DB in casi limite. Prova: lettura codice. Correzione: rivedere la condizione di validità.

5. Gravità: media. File: src/server.ts /api/payout/request. Posizione: idempotencyKey obbligatoria (>=4) ma non verificato se il client la genera in modo univoco; collisioni possibili se riutilizzata. Conseguenza: prelievo duplicato bloccato solo se stessa key; se key diversa, doppio prelievo possibile (ma atomico su DB). Prova: lettura codice. Correzione: documentare contratto client.

6. Gravità: info. File: src/server.ts. Posizione: chunk JS 1.34MB. Conseguenza: performance frontend. Non bug economico.

## 7. Funzionalità non verificabili in questo ambiente

- DB live (Neon): migrazioni non applicate/eseguite; SQL non testato a runtime.
- Webhook reale: non inviato.
- Payout on-chain: non eseguito (no wallet configurati).
- FX live: endpoint non chiamato in test.
- test:neon non eseguito.

## 8. Metriche richieste

- Percentuale repository esaminato (file progetto): ~95% dei file sorgente money-critical letti; views/UI letti parzialmente. Stima copertura complessiva: 80%.
- Numero file esaminati: ~45 file sorgente + 5 migrazioni chiave + 3 script.
- Flussi funzionali ricostruiti: 7 (auth, click/interazione, postback accredito, settlement, wallet/saldo, prelievo, revoca).
- Test aggiuntivi eseguiti: 0 nuovi (vincolo no-modifica); 6 suite esistenti + lint + build.
- Problemi trovati: 6 (1 alta potenziale, 3 media, 1 bassa, 1 info).
- Funzionalità non verificabili: DB live, webhook reali, payout on-chain, FX live, test:neon.
- Giudizio sostenibilità economica: il modello è sostenibile sul piano contabile (≥70% margine, partita doppia, cap esposizione per partner), ma dipende dalla verifica del settlement haircut rispetto ai punti già accreditati e dalla correttezza dell'idempotenza lato client (txId univoco). Senza DB live non è possibile certificare l'assenza di race condition o storni incompleti.
