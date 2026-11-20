# ActionFlow Hub — Architettura Tecnica, Sicurezza Integrata e Core Crediti

> Documento di riferimento tecnico-architetturale aggiornato in allineamento al rapporto di audit definitivo e al riferimento Kilo (`013`–`020`, incluso commit `090f479`).
> Nota operativa: le migrazioni SQL incrementali (`011`–`020`) sono pronte nel repository e **non** vengono eseguite automaticamente su database Neon di produzione senza autorizzazione esplicita. Vedi anche [`docs/ACTIONFLOW_OPERATIONS_AND_MIGRATIONS.md`](ACTIONFLOW_OPERATIONS_AND_MIGRATIONS.md) per registro migrazioni, configurazione `.env`, backup e rollback.

---

## 1. Mappa dei Collegamenti End-to-End tra i Componenti

```text
[Onboarding & GEO Lock]
  EntryView / ProductTypeView / CountryProfile (World Bank PPP: US/EU=1.0, Altri=PPP/FX)
        │
        ▼
[AutoInteractiveCycleEngine.tsx] (Fail-Closed: running=false di default)
  ├─► GET /api/providers/prioritized?country=..  ──► sortProvidersByPriority (7 Criteri)
  │     • Esclude QUARANTINE / BANNED / isLocked / GEO incompatibile / parole chiave bandite (`cpx`)
  │     • Consente solo ACTIVE e WARNING (+ campagne realmente attive in DB/catalogo)
  └─► POST /api/auto-session/start               ──► core.start_auto_session (PostgreSQL)
        │
        ▼ (Click esplicito su campagna autorizzata & HTTPS sicuro via navigation.ts)
[openTrackedLink() in src/lib/affiliate.ts]
  ├─► POST /api/interactions/register (/api/affiliate/click)
  │     • Schema allowlist (`400 UNEXPECTED_FIELDS`)
  │     • Filtro provider banditi (`403 PROVIDER_BANNED_BY_POLICY`)
  │     • Allowlist domini partner + HTTPS + anti-SSRF (`400 UNAUTHORIZED_TRACKING_URL`)
  │     • Rate limit persistente su PostgreSQL (`core.consume_provider_rate_limit` → `429 PROVIDER_RATE_LIMIT_EXCEEDED`)
  │     └─► core.register_session_interaction ──► core.session_interactions (CLICK_REGISTERED, 0 PT)
  └─► Apertura esterna `https://...` con `rel="noopener noreferrer"` e XSS guard (`isSafeExternalHttpsUrl`)
        │
        ▼ (Solo postback S2S verificato dal partner — zero accrediti dal client o da timer)
[GET|POST /api/webhook/postback]
  ├─► Schema allowlist (`400 UNEXPECTED_FIELDS`)
  ├─► HMAC-SHA256 su `req.rawBody` byte esatti (POST) / raw query (GET) + `X-Webhook-Timestamp` ±300s + transizione legacy `WEBHOOK_LEGACY_SECRET_SUNSET_AT`
  ├─► Rate limit persistente PostgreSQL (`core.consume_provider_rate_limit`) + classificazione anomalie (`core.inbound_security_logs`)
  └─► core.record_verified_interaction_postback (migrazioni 012 + 015)
        • Verifica `core.auto_sessions.status NOT IN ('CANCELLED', 'REVOKED', 'EXPIRED')`
        • Verifica `core.provider_reputation.status IN ('ACTIVE', 'WARNING')`
        • CORE ACCREDITI (Partita Doppia):
            user_pending = FLOOR(raw_points * 0.30 * ppp_coefficient)
            platform_margin = raw_points - user_pending  (>= 70%)
            +USER_<id>:PENDING / -SYSTEM:UNEARNED_REVENUE
        │
        ▼
[Settlement Batch & Maturazione Punti] (src/workers/settlementWorker.ts, migration 013/014)
  ├─► core.execute_batch_settlement (con receivedAsset esplicito su 8 asset)
  │     • Sposta PENDING -> SETTLED + accredita vault specifico per asset in `core.treasury_vault`
  └─► core.release_settled_to_withdrawable_for_user
        • Verifica solvibilità per-asset (`core.v_treasury_vault_status` con `approved_pending_points`, `available_after_approved_points`, `reserved_15pct_points`) + recupero eventuale debito clawback
        • Sposta SETTLED -> WITHDRAWABLE
        │
        ▼
[Prelievi & Payout Esterni Non-Custodial] (`MANUAL_EXTERNAL`)
  ├─► POST /api/payout/idempotency-key (`crypto.randomUUID()` lato server)
  ├─► POST /api/payout/request (min 500 PT = $5.00 USD, `WITHDRAWABLE` -> `RESERVED`, FX live con `expires_at`, payload hash SHA-256 → `409 IDEMPOTENCY_KEY_PAYLOAD_CONFLICT`)
  ├─► Kill Switch globale (`core.get_payout_kill_switch`, fail-closed) + Limiti giornalieri
  ├─► POST /api/payout/disburse (`APPROVED`: doppia approvazione con 2 admin distinti per importi > soglia)
  ├─► Worker & Double-Spend Guard (`migration 020`): `core.claim_payout_for_dispatch` (attempt_id univoco + indice parziale anti-retry concorrente) → `BROADCASTING` → `CONFIRMED_ONCHAIN | UNCERTAIN_TIMEOUT` (divieto reinvio) + riconciliazione `POST /api/payout/reconcile-uncertain`
  └─► Guard pre-completamento (`canVerifyPayoutAssetIndependently` + `verifyPayoutTransactionOnChain`): finalità on-chain (`finalized` SOL legacy/v0 ALT & SPL, `lt/utime` + destinatario/importo TON, PI, USDT/USDC/CASH_* fail-closed) → persistenza prova in `core.payout_onchain_verifications` → `core.complete_payout_atomic`.
```

---

## 2. Motore Automatico `AutoInteractiveCycleEngine` & Sessioni

* **File principali**: `src/components/AutoInteractiveCycleEngine.tsx`, `src/lib/providerPriority.ts`, `src/lib/verifiedDirectProviders.ts`, `src/lib/entryProfile.ts`, `migrations/009`, `migrations/015`.
* **Invarianti di esecuzione fail-closed**:
  * Il componente parte con `running = false` e `reputationSource = 'LOADING'`. Il ciclo visivo non si avvia se la sessione PostgreSQL non è confermata in stato `ACTIVE` (`sessionActive === true`) o se `activePlaylist.length === 0`.
  * Quando il backend è connesso a PostgreSQL (`reputationSource === 'POSTGRES'`), `buildPrioritizedAutoCycleSteps` imposta `requireRegisteredReputation: true` e verifica contro la whitelist `authorizedProviderIds` restituita da `/api/providers/prioritized`: qualsiasi provider non censito (`UNSCORED`), in stato `QUARANTINE` o `BANNED`, bloccato (`isLocked`), o GEO-incompatibile viene escluso. I soli stati ammessi sono `ACTIVE` e `WARNING`.
  * Il timer interno ha scopo **esclusivamente visivo** (scorrimento UI della coda): zero crediti temporali, nessun endpoint `/api/session/complete` o `/api/rewards/record` (entrambi bloccati con HTTP `410 GONE`).
  * Ogni azione "Esegui" è disabilitata quando `!sessionActive || activePlaylist.length === 0`, verifica `isSafeExternalHttpsUrl(currentStep.targetUrl)`, registra un `CLICK_REGISTERED` a **0 PT** su PostgreSQL e delega la conferma esclusivamente al postback S2S partner.
* **Revoca sessione automatizzata & rollback punti (Migrazioni `015` + `019`)**:
  * Lo stato di `core.auto_sessions` include `REVOKED` (`revoked_at`, `revoked_by`).
  * `POST /api/admin/auto-session/revoke` (protetto da `adminLimiter + requireAdmin`) invoca `core.revoke_auto_session(session_id, reason, actor)`: marca la sessione come `REVOKED`, chiude le interazioni ancora in `CLICK_REGISTERED` su `REJECTED`, esegue il **rollback atomico dei punti** sugli eventuali `reward_events` collegati alla sessione (`PENDING` → `core.partner_confirm_reward(..., 'REVOKED')`, `SETTLED` → `core.revoke_settled_reward(..., 'SESSION_REVOKED:' || reason)`) e registra i contatori in `core.security_audit_logs`.
  * `core.record_verified_interaction_postback` blocca la riga di `core.auto_sessions` (`FOR UPDATE`) e rifiuta qualsiasi postback con `AUTO_SESSION_REVOKED_OR_EXPIRED` (HTTP `403`) se `status IN ('CANCELLED', 'REVOKED', 'EXPIRED')`.

---

## 3. Sicurezza Inbound, Webhook e Protezione URL

* **Moduli**: `src/lib/inboundSecurity.ts`, `src/utils/navigation.ts`, `src/server.ts`, `migrations/016`.
* **Schema Allowlist rigorosa (`UNEXPECTED_FIELDS`)**:
  * `POST /api/interactions/register`, `POST /api/affiliate/click` e `GET|POST /api/webhook/postback` validano le chiavi ammesse con `findUnexpectedKeys`. Qualsiasi campo non previsto nel contratto viene respinto con `400 UNEXPECTED_FIELDS` e tracciato come `SUSPICIOUS_BEHAVIOR`.
* **Validazione URL di tracking e anti-XSS/SSRF**:
  * Backend (`validatePartnerTrackingUrl`): richiede `https:`, vieta credenziali embedded, blocca hostname locali o IP privati RFC1918/link-local (`isPrivateOrLocalHostname`) e verifica la corrispondenza con l'allowlist dei domini partner derivata da `ALL_VERIFIED_DIRECT_PROVIDERS`, `PROJECTS_CATALOG`, host Telegram ed `EXTRA_ALLOWED_PARTNER_DOMAINS`. I domini esterni non autorizzati ricevono `400 UNAUTHORIZED_TRACKING_URL`.
  * Frontend (`src/utils/navigation.ts`): `isSafeExternalHttpsUrl` e `openAnyUrlSafely` consentono esclusivamente `https:`, neutralizzando schemi `javascript:` o `data:`.
* **Autenticazione Webhook HMAC-SHA256 su Raw Body, Anti-Replay & Sunset Controllato**:
  * `express.json` cattura i byte esatti del payload in `req.rawBody`; su `POST /api/webhook/postback`, `verifyWebhookRawBodyHmac` calcola `HMAC-SHA256(secret, Buffer.concat([Buffer.from(tsSec + '.'), req.rawBody]))` senza fallback `JSON.stringify`. Su `GET`, verifica la raw query string (con compatibilità canonica solo per GET legacy). Finestra temporale `X-Webhook-Timestamp` ≤ `300s` (future skew max `30s`), integrata con `core.webhook_replay_guard` su `(provider_id, webhook_nonce)` e lock transazionale su `event_id`.
  * **Transizione controllata legacy (`checkLegacyWebhookTransition`)**: `WEBHOOK_REQUIRE_HMAC=true` (oppure superamento di `WEBHOOK_LEGACY_SECRET_SUNSET_AT`) disabilita definitivamente il fallback `X-Webhook-Secret` e i segreti in querystring (`401 LEGACY_WEBHOOK_TRANSITION_EXPIRED` / `401 QUERY_SECRET_DISABLED`).
* **Rate Limiting Multilivello & Persistenza DB (`migrations/016`)**:
  * Limitazione per IP (`express-rate-limit`: `generalApiLimiter`, `financialLimiter`, `webhookLimiter`, `adminLimiter`) affiancata da `core.consume_provider_rate_limit(p_provider_id, p_endpoint, 10)` su PostgreSQL (`core.provider_rate_limits` + `core.provider_rate_limit_windows` con finestra 60s protetta da `pg_advisory_xact_lock` + `FOR UPDATE`), condivisa tra tutte le istanze server (HTTP `429 PROVIDER_RATE_LIMIT_EXCEEDED`, nessuna perdita al riavvio). Configurabile per singolo provider tramite `POST /api/admin/providers/:id/rate-limit`.

---

## 4. Protezione Proporzionata dei Fornitori & Audit Inbound

* **Tabelle e funzioni SQL**: `core.inbound_security_logs`, `core.log_inbound_security_event(...)` (`015` + `016`), `core.admin_review_provider_anomalies` (`016`), `core.update_provider_protection_thresholds` (`016`), gestibili da admin tramite `GET /api/admin/security/inbound-logs`, `GET|POST /api/admin/providers/thresholds/config` e `POST /api/admin/providers/:id/review`.
* **6 categorie di anomalia e soglie configurabili (`PROVIDER_PROTECTION_THRESHOLDS`: default `warning=3`, `quarantine=5`, `ban_admin_only=true`)**:
  1. `TECHNICAL_ERROR` (es. interazione non trovata/scaduta/stato già processato): incrementa `technical_error_count` in `core.provider_reputation` e registra in `inbound_security_logs`, **non penalizza** in alcun modo lo stato del fornitore.
  2. `INVALID_SIGNATURE`: loggato per audit forense senza declassare automaticamente un fornitore legittimo a fronte di richieste spoofate da terzi privi di firma valida.
  3. `REPLAY_ATTEMPT`: replay di timestamp scaduto (`WEBHOOK_TIMESTAMP_EXPIRED`), nonce (`WEBHOOK_NONCE_REPLAYED`) o `event_id` conflittuale (`EVENT_ID_REPLAY_CONFLICT`).
  4. `UNAUTHORIZED_URL`: tentativi di tracking URL non HTTPS o fuori allowlist partner.
  5. `SUSPICIOUS_BEHAVIOR`: `UNEXPECTED_FIELDS`, `PROVIDER_BANNED_BY_POLICY`, superamento rate limit provider, `AUTO_SESSION_REVOKED_OR_EXPIRED` o `INTERACTION_OWNERSHIP_MISMATCH`.
  6. `FRAUDULENT_ACTIVITY`: attività fraudolenta accertata sul fornitore.
* Solo le categorie sospette/malevole (`REPLAY_ATTEMPT`, `UNAUTHORIZED_URL`, `SUSPICIOUS_BEHAVIOR`, `FRAUDULENT_ACTIVITY`) incrementano `consecutive_suspicious_anomalies`: a quota `warning_threshold` (`3`) il provider passa automaticamente a `WARNING`, a quota `quarantine_threshold` (`5`) entra in `QUARANTINE`; **`BANNED` non viene mai imposto automaticamente** (solo decisione esplicita dell'admin via `/review`). L'approvazione/rilascio admin reimposta `consecutive_suspicious_anomalies = 0` e riallinea `partner_exposure`. `cpx` resta permanentemente `BANNED` / `REVOKED`.

---

## 5. Core Crediti, Ledger a 4 Conti, PPP e Tesoreria Multi-Asset

* **Invarianti commerciali preservati**:
  * Scala unica: **`100 PT = $1.00 USD`** (`$0.01 USD/PT`).
  * Formula economica **`30/70` + PPP Banca Mondiale**: `user_pending = FLOOR(raw_points * 0.30 * ppp_coef)` (`US`/`EUROPE` = `1.0000`, altri Paesi `PA.NUS.PRVT.PP / PA.NUS.FCRF`); `platform_margin = raw_points - user_pending` (sempre `>= 70%`).
  * Quattro conti utente (`USER_<id>:PENDING`, `USER_<id>:SETTLED`, `USER_<id>:WITHDRAWABLE`, `USER_<id>:RESERVED`) a somma zero contro i conti di sistema (`core.audit_ledger_integrity()`), con recupero automatico debiti post-clawback (`core.recover_user_clawback_debt`).
  * Soglia minima di prelievo: **`500 PT` (`$5.00 USD`)**.
* **Tesoreria separata su tutti gli 8 canali (Migrazioni `013` + `014` + `016`)**:
  * Asset supportati senza esclusioni: **`TON`**, **`SOL`**, **`PI`**, **`USDT`**, **`USDC`**, **`CASH_PAYEER`**, **`CASH_AIRTM`**, **`CASH_VOLET`**.
  * Ogni asset ha vault dedicato in `core.treasury_vault` con capacità iniziale `0`: nessun payout può essere approvato/completato se `available_points` dello specifico asset richiesto dal destinatario è insufficiente (`TREASURY_VAULT_ASSET_INSUFFICIENT`), evitando doppi conteggi o compensazioni cross-asset non coperte.
  * La vista `core.v_treasury_vault_status` espone inoltre `approved_pending_points`, `available_after_approved_points` e `reserved_15pct_points` (senza rimuovere colonne preesistenti).
  * Ogni conversione interna di tesoreria (`/api/admin/treasury-convert` → `core.record_treasury_conversion`) richiede riferimento esterno verificabile (`CONVERSION_EXTERNAL_TX_REF_REQUIRED` con indice univoco) e tolleranza FX verificata.
* **Separazione privilegi DB & Log Append-Only (`migrations/015` + `019`)**:
  * Ruolo applicativo operativo `actionflow_app` (senza `DELETE`/`UPDATE`/`TRUNCATE` sui log di sicurezza), ruolo read-only `actionflow_auditor` sui dati contabili e log di sicurezza (con `EXCEPTION WHEN insufficient_privilege` per compatibilità Neon), trigger `core.prevent_audit_log_mutation()` per rendere append-only `core.security_audit_logs` e `core.inbound_security_logs`, oltre al registro persistente `core.schema_migrations`.
  * Ordine canonico dei lock anti-deadlock (`user_ledger_<user_id>` + `core.users FOR UPDATE` sempre acquisiti prima di `core.balances`) in `core.execute_batch_settlement`, `core.release_settled_to_withdrawable_for_user` (con wrapper `core.release_settled`) e `core.complete_payout_atomic`.

---

## 6. Prelievi, Idempotenza Server-Side, Custodia Esterna & Finalità Blockchain

* **Idempotenza Payout Server-Side (`migration 017`)**:
  * `POST /api/payout/idempotency-key` genera UUID v4 crittografici (`crypto.randomUUID()`) lato server.
  * `core.request_payout_atomic` salva `request_payload_hash` (SHA-256 PostgreSQL di `asset|address|points|fx_snapshot`) e respinge con HTTP `409` (`IDEMPOTENCY_KEY_PAYLOAD_CONFLICT`) qualsiasi riutilizzo della medesima `idempotency_key` con utente o parametri differenti.
* **Custodia non-custodial (`MANUAL_EXTERNAL`)**: `tonPayoutWorker` e `multiAssetPayoutWorker` rifiutano fail-closed la firma automatica server-side (`MANUAL_PAYOUT_MODE_ACTIVE_NO_SERVER_SIGNING`), eliminando chiavi private dall'ambiente server applicativo.
* **Doppia approvazione e Kill Switch**: il Kill Switch (`core.get_payout_kill_switch`) fallisce chiuso se il DB o la riga di controllo mancano; l'approvazione richiede due amministratori distinti (`DUAL_APPROVAL_DISTINCT_ADMIN_REQUIRED`) con lock atomico per prevenire approvazioni concorrenti.
* **Finalità Blockchain, Verificabilità Indipendente & Prova Persistita (`src/services/onchainVerifier.ts` + `migrations/018`–`020`)**:
  * **Guard Pre-Trasmissione e Pre-Completamento (`canVerifyPayoutAssetIndependently`)**: blocca in fail-closed qualsiasi dispatch o completamento per `PI`, `USDT`, `USDC` o `CASH_*` se l'indirizzo non è valido o manca un verificatore indipendente configurato (`TON_USDC_MASTER`, `CRYPTO_GATEWAY_VERIFY_URL`, `CASH_GATEWAY_VERIFY_URL`).
  * **Solana (`SOL`, `USDC`/`USDT` SPL)**: supporta sia transazioni legacy sia transazioni versioned (`v0` con Address Lookup Tables via `meta.loadedAddresses.writable/readonly`), richiedendo `commitment: 'finalized'`, `maxSupportedTransactionVersion: 0`, `slot > 0`, assenza `meta.err`, destinazione e importo netto ricevuto.
  * **TON (`TON`, `USDT`/`USDC` Jetton)**: verifica `lt` e `utime > 0`, `!aborted`, corrispondenza indirizzo destinatario (`Address.parse`), importo `>= 98%` e `jetton_master` obbligatorio su Jetton.
  * **Pi Network (`PI`) & Canali Cash (`CASH_PAYEER`, `CASH_AIRTM`, `CASH_VOLET`)**: `PI` verifica `G...` 56-char, `successful === true` e operazione `payments` `asset_type = native`; i canali cash richiedono `CASH_GATEWAY_VERIFY_URL` verificato (fail-closed se assente).
* **Protezione Double-Spend Persistente su PostgreSQL (`migration 020` + worker TON/Multi-Asset)**:
  * **Claim Atomico Pre-Trasmissione (`core.claim_payout_for_dispatch`)**: assegna un `attempt_id` univoco, imposta indice parziale univoco `idx_payout_dispatch_one_blocking_attempt` su `(request_id)` per impedire retry concorrenti multi-worker e blocca qualunque reinvio se `dispatch_state` è `UNCERTAIN_TIMEOUT`, `BROADCASTING`, `CONFIRMED_ONCHAIN` o `COMPLETED` (`PAYOUT_RESEND_BLOCKED_UNCERTAIN_OR_CONFIRMED_OUTCOME`).
  * **Transizioni & Audit Immutabile (`core.payout_dispatch_audit`)**: tutte le transizioni (`UNCLAIMED -> CLAIMED -> BROADCASTING -> UNCERTAIN_TIMEOUT | CONFIRMED_ONCHAIN -> COMPLETED`) sono tracciate in modo append-only con trigger anti-manomissione.
  * **Riconciliazione RPC (`POST /api/payout/reconcile-uncertain`)**: interroga `core.get_uncertain_payout_dispatches` e verifica su RPC/gateway i payout rimasti in sospeso dopo crash/timeout prima di finalizzarne il completamento (senza mai effettuare reinvii automatici quando l'esito è incerto).

---

## 7. Stato di Verifica nell'Ambiente Repository

* Verificati localmente in modalità **offline (`DATABASE_URL=""`)**: suite automatica (`npm test`, incluse verifiche stubbed RPC per TON, Solana legacy/v0 ALT, PI, CASH fail-closed e simulazione worker crash/concorrenza/timeout/riconciliazione), compilazione (`vite build`) e type-check TypeScript (`tsc --noEmit`).
* **Non eseguiti in questo ambiente**: applicazione delle migrazioni (`011`–`020`) su database Neon live, test di concorrenza SQL multi-istanza su Postgres reale, webhook partner reali da rete esterna e transazioni blockchain/cash reali su mainnet o testnet (richiedono ambiente di staging/produzione autorizzato con `DATABASE_URL` e credenziali RPC).
