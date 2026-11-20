# ActionFlow Hub

Telegram Mini App (TMA) per attività digitali verificate, playlist automatizzata continua `UNIFIED_AUTO` e gestione contabile **PostgreSQL** a partita doppia su scala unica **`100 PT = $1.00 USD`**.

Stack: **React 19 · Vite 8 · TypeScript 7 · Tailwind 4 · Express · PostgreSQL**.

---

## Avvio rapido

| Script | Cosa fa |
|---|---|
| `npm run dev` | Express con Vite in middleware mode (porta 3000) |
| `npm run build` | Build di produzione in `dist/` |
| `npm start` | Server di produzione (serve `dist/`) |
| `npm run lint` | `tsc --noEmit` (type-check) |
| `npm test` | Suite completa di verifica (ledger, e2e, entry, brand, hardening, economics) |
| `npm run test:ledger` | Verifica ledger a 4 bucket, anti-abuse, idempotenza |
| `npm run test:e2e` | Ciclo completo `PENDING -> SETTLED -> WITHDRAWABLE -> RESERVED -> PAID` |
| `npm run test:entry` | Lingue (14), categorie, sessione `UNIFIED_AUTO`, quota `30%`, reset TZ |
| `npm run test:brands` | Integrità loghi ufficiali |
| `npm run test:hardening` | Auth Telegram HMAC, blocchi `410 GONE`, fail-closed worker TON, FX live |
| `npm run test:economics` | Paesi (`DE`, `US`, `BR`, `CN`, `IN`, `NG`, `KE`), PPP Banca Mondiale, 7 criteri priorità, worker multi-asset, migrazione `012` |

---

## Architettura dell'interfaccia e Flusso Utente

1. **Onboarding persistente (`EntryView`, `ProductTypeView`, `EntryVideoView`)**:
   - Lingua (`14 lingue`), Paese di riferimento persistente (`af_entry_country` + `core.users.market_country`) associato a `tier_zone` (`ZONE_A`, `ZONE_B`, `ZONE_C`) e coefficiente PPP Banca Mondiale (`ppp_multiplier`), oltre alle preferenze categorie.
   - Nessuna perdita del Paese durante pulizia schema/storage (`PRESERVED_PREF_KEYS`).
2. **Motore Automatico `UNIFIED_AUTO` (`HomeView` + `AutoInteractiveCycleEngine`)**:
   - Playlist continua filtrata sulle categorie scelte in onboarding e ordinata sui **7 criteri deterministici** (`src/lib/providerPriority.ts`):
     1. Offerte senza vincoli geografici/di fascia (`GLOBAL`) prima delle regionali compatibili col Paese (`IT_EU` / `US_UK_CA`), senza mai forzare offerte incompatibili.
     2. Completamento rapido/immediato.
     3. Velocità di conferma postback S2S / Web3.
     4. Ciclo di pagamento e liquidazione effettiva più breve.
     5. Elevata percentuale di completamento (`completion_rate` su `core.session_interactions` / EMA).
     6. Reputazione `ACTIVE` e affidabilità verificabile su PostgreSQL (`core.provider_reputation`), escludendo `QUARANTINE` / `BANNED`.
     7. Compatibilità geografica e convenienza economica / disponibilità offerta.
3. **Sezioni dedicate**:
   - `HomeView.tsx`, `GamesView.tsx`, `MicroDramaView.tsx`, `MusicAudioView.tsx`, `AiWorkView.tsx`, `UxQaView.tsx`, `ReceiptOcrView.tsx`, `DepinNodesView.tsx`, `ShoppingView.tsx`, `AirdropHubView.tsx`, `WithdrawView.tsx`, `ProfileView.tsx`, `AdminView.tsx`.

---

## Sistema Economico Internazionale, PPP Banca Mondiale & Prelievi

* **Scala contabile unica invariante**: `100 PT = $1.00 USD` (`$0.01 USD/PT`) — identica nei saldi, nei prelievi e in tesoreria.
* **Coefficienti PPP ufficiali (`src/services/worldBankPpp.ts`, indicatori World Bank WDI `PA.NUS.PRVT.PP` / `PA.NUS.FCRF`)**:
  - `US`: coefficiente base `1.0000`.
  - `Europa` (`IT`, `DE`, `FR`, `ES`, `PT`, `NL`, `BE`, `AT`, `CH`, `PL`, `SE`, `GB` e codici UE/SEE): coefficiente base `1.0000`.
  - `Africa`, `Cina (CN)`, `India (IN)`, `America Latina`, `Asia-Pacifico`, `MENA`, `OTHER`: coefficiente calcolato per Paese da consumo privato PPP vs tasso di cambio ufficiale (`LEAST(1.0000, GREATEST(0.0100, ROUND(ppp / fx, 4)))`), con aggiornamento periodico automatico non bloccante da `api.worldbank.org/v2`.
* **Ripartizione verificata su postback (`30% Utente / >=70% Margine Piattaforma`)**:
  - `user_pending_points = FLOOR(raw_points * 0.30 * ppp_coefficient)`
  - `platform_margin_points = raw_points - user_pending_points` (sempre `>= 70%` dei punti lordi, partita doppia a somma zero senza PT scoperti).
* **Soglia minima e canali di prelievo (`WithdrawView` + `core.request_payout_atomic` + `MultiAssetPayoutWorker`)**:
  - Soglia minima: `500 PT` (`$5.00 USD`), conversione invariata rispetto al PPP.
  - **Crypto Diretta**: `TON`, `SOL`, `PI` (tassi live `/api/fx/rates`), `USDT`, `USDC` (parità `1:1 USD`, indirizzi TON `UQ/EQ` o Solana Base58).
  - **Gateway Cash USD**: `CASH_AIRTM`, `CASH_PAYEER`, `CASH_VOLET`.
  - Automazione pagamenti fail-closed con guardia solvibilità `v_treasury_solvency` (`TON`, `SOL` on-chain `@solana/web3.js`, `PI`, `USDT`, `USDC`, `CASH_*`).
* **Endpoint principali**:
  - `GET /api/ledger/balance`, `POST /api/auto-session/start`, `GET /api/auto-session/status`
  - `GET /api/economics/countries`, `POST /api/economics/sync-worldbank`
  - `GET /api/providers/prioritized?country=..&category=..`
  - `POST /api/interactions/register`, `POST /api/affiliate/click`
  - `GET|POST /api/webhook/postback`
  - `POST /api/payout/idempotency-key`, `POST /api/payout/request`, `GET /api/payout/list`, `POST /api/payout/disburse`, `POST /api/payout/process-ton`, `POST /api/payout/process-all`, `POST /api/payout/reconcile-uncertain`
  - `GET|POST /api/admin/providers/thresholds/config`, `POST /api/admin/providers/:id/rate-limit`, `POST /api/admin/providers/:id/review`
  - `POST /api/settlement/execute`, `POST /api/settlement/release-withdrawable`, `GET /api/audit/ledger-integrity`

---

## Migrazioni PostgreSQL (`migrations/`)

* `001` – `010`: Schema `core`, double-entry a 4 bucket (`PENDING`, `SETTLED`, `WITHDRAWABLE`, `RESERVED`), reset timezone-aware, postback verificati S2S, reputazione fornitori, batch settlement con haircut, `v_treasury_solvency` e `request_payout_atomic`.
* `011_geo_country_lock_and_provider_ranking.sql`: Lock persistente `market_country`, associazione deterministica `core.resolve_country_tier_zone(p_country)` e vista `core.v_prioritized_providers` (da applicare separatamente previa autorizzazione su Neon).
* `012_worldbank_ppp_and_reward_formula.sql`: Tabella `core.country_economic_profiles` (36 Paesi con coefficienti World Bank WDI), `core.get_country_ppp_coefficient`, precisione `NUMERIC(6,4)` su `core.users.ppp_multiplier`, formula PPP su `core.record_verified_interaction_postback` + margine piattaforma tracciato e `completion_rate` su `core.v_prioritized_providers` (preparata senza eseguire su Neon).
* `013_multi_asset_treasury_killswitch_limits_clawback.sql` & `014_audit_hardening_fixes.sql`: Tesoreria separata per ciascuno degli 8 asset (`TON`, `SOL`, `PI`, `USDT`, `USDC`, `CASH_PAYEER`, `CASH_AIRTM`, `CASH_VOLET`), conversioni tracciate con `external_tx_ref` univoco, Kill Switch globale fail-closed, doppia approvazione admin, coda settlement durevole (`core.settlement_jobs`) e recupero automatico debiti post-clawback.
* `015_inbound_security_and_session_revocation.sql`: Tabella e funzione `core.inbound_security_logs` / `core.log_inbound_security_event` con categorie di anomalia proporzionate, revoca atomica sessioni `core.revoke_auto_session` (stato `REVOKED` + blocco nuovi postback su `core.record_verified_interaction_postback`), allineamento `cpx` a `BANNED`/`REVOKED` e ruolo DB `actionflow_auditor` a minimo privilegio.
* `016_persistent_rate_limit_provider_thresholds_killswitch.sql`: Rate limit persistente su PostgreSQL (`core.provider_rate_limits` / `core.consume_provider_rate_limit` con default `10 req/min`), categoria `FRAUDULENT_ACTIVITY`, soglie automatiche proporzionate (`PROVIDER_PROTECTION_THRESHOLDS`: `WARNING=3`, `QUARANTINE=5`, `BANNED` esclusivamente admin), isolamento `TECHNICAL_ERROR`, revisione admin `core.admin_review_provider_anomalies` e colonne di approvazione/riserva estese su `core.v_treasury_vault_status`.
* `017_payout_idempotency_payload_conflict.sql`: Hash SHA-256 del payload payout (`request_payload_hash`) ed enforcement SQL in `core.request_payout_atomic` con errore `IDEMPOTENCY_KEY_PAYLOAD_CONFLICT` (HTTP `409`).
* `018_onchain_verification_tracking.sql`: Tabella `core.payout_onchain_verifications`, funzione `core.record_payout_onchain_verification` e blocco fail-closed in `core.complete_payout_atomic` finché la prova on-chain non è registrata e verificata (`ONCHAIN_PROOF_NOT_RECORDED_OR_UNVERIFIED`).
* `019_treasury_sql_and_session_rollback_hardening.sql`: Registro `core.schema_migrations` (`001`–`020` ↔ Kilo `013`–`020`), trigger append-only su log di sicurezza, ruolo operativo `actionflow_app`, rollback automatico punti alla revoca sessione (`core.revoke_auto_session`), lock deadlock-safe in `execute_batch_settlement` / `release_settled_to_withdrawable_for_user` (+ wrapper `core.release_settled`) e cross-check completo prove on-chain in `complete_payout_atomic`.
* `020_payout_dispatch_claims_and_double_spend_guard.sql`: Protezione persistente anti-double-spend su PostgreSQL con claim atomico pre-trasmissione (`core.claim_payout_for_dispatch`), stato persistente della trasmissione e indice univoco parziale (`idx_payout_dispatch_one_blocking_attempt`), divieto di reinvio su esito incerto, audit immutabile (`core.payout_dispatch_audit`) e riconciliazione RPC (`core.get_uncertain_payout_dispatches`).

---

## Documentazione Architetturale, Sicurezza e Operazioni (`docs/`)

* [`docs/ACTIONFLOW_ARCHITECTURE_AND_SECURITY.md`](docs/ACTIONFLOW_ARCHITECTURE_AND_SECURITY.md): Analisi tecnica integrale aggiornata di `AutoInteractiveCycleEngine`, sicurezza inbound & HMAC raw-body/sunset, rate limiting persistente PostgreSQL, core crediti a 4 conti, tesoreria separata su 8 asset, idempotenza payout, custodia `MANUAL_EXTERNAL`, verificabilità indipendente (TON, Solana legacy/v0 ALT, PI, USDT/USDC/CASH_*), protezione double-spend (`020`) e mappa dei collegamenti end-to-end.
* [`docs/ACTIONFLOW_OPERATIONS_AND_MIGRATIONS.md`](docs/ACTIONFLOW_OPERATIONS_AND_MIGRATIONS.md): Registro migrazioni (`001`–`020` ↔ Kilo `013`–`020`), configurazione variabili d'ambiente, procedura di backup/rollback su Neon e matrice di stato dei test.

