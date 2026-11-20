# ActionFlow Hub — Registro Migrazioni, Variabili Ambiente, Backup/Rollback e Stato Test

> Documento operativo di allineamento definitivo al riferimento Kilo (commit `fbb3ae3` → `090f479` su `kilo/cold-rune-nck`, migrazioni `013`–`020`).
> **Importante**: nessuna migrazione viene eseguita automaticamente sul database Neon di produzione da AI Studio; tutte le procedure sotto sono pronte per applicazione controllata dall'operatore.

---

## 1. Registro Migrazioni (`001`–`020`) & Mappatura Riferimento Kilo (`013`–`020`)

> Nota storica: `003` è un gap intenzionale nella numerazione originale del repository (nessun file SQL rimosso).

| Migrazione AI Studio | Riferimento Kilo Equivalente | Contenuto Principale & Invarianti | Stato Applicazione Live |
|---|---|---|---|
| `001_initial_schema.sql` | Base | Schema `core`, utenti, conti `PENDING`/`SETTLED`/`WITHDRAWABLE`/`RESERVED`, double-entry | Da verificare su Neon |
| `002_reputation_and_exposure.sql` | Base | Reputazione fornitori, `partner_exposure`, sessioni base | Da verificare su Neon |
| `004_pending_reward_verified.sql` | Base | Credito `PENDING` esclusivamente da postback partner | Da verificare su Neon |
| `005_postback_hardening.sql` | Base | Click tracking e anti-duplicazione postback | Da verificare su Neon |
| `006_ppp_and_30_70_split.sql` | Base | `30%` utente × PPP Banca Mondiale / `70%` piattaforma | Da verificare su Neon |
| `007_user_strikes.sql` | Base | Strike anti-abuse persistenti su `core.users` | Da verificare su Neon |
| `008_ledger_payout_hardening.sql` | Base | Hardening partita doppia e payout | Da verificare su Neon |
| `009_unified_auto_session_and_interactions.sql` | Base | `core.auto_sessions` e `core.session_interactions` (`0 PT` al click) | Da verificare su Neon |
| `010_reconciliation_settlement_and_payout_hardening.sql` | Base | `execute_batch_settlement`, `release_settled_to_withdrawable_for_user`, FX snapshot | Da verificare su Neon |
| `011_geo_country_lock_and_provider_ranking.sql` | Base | Lock persistente `market_country`, `resolve_country_tier_zone`, `v_prioritized_providers` | Pronta in repo |
| `012_worldbank_ppp_and_reward_formula.sql` | Base | `country_economic_profiles` (36 Paesi WDI), precisione `NUMERIC(6,4)`, `completion_rate` | Pronta in repo |
| `013_multi_asset_treasury_killswitch_limits_clawback.sql` | Kilo `013` | Tesoreria separata su 8 asset (`TON`, `SOL`, `PI`, `USDT`, `USDC`, `CASH_*`), Kill Switch, limiti, doppia approvazione, `revoke_settled_reward`, `reverse_completed_payout` | Pronta in repo |
| `014_audit_hardening_fixes.sql` | Kilo `014` | Coda `settlement_jobs`, `recover_user_clawback_debt`, univocità `external_tx_ref`, dedup `APPROVED` per asset | Pronta in repo |
| `015_inbound_security_and_session_revocation.sql` | Kilo `015` | `inbound_security_logs`, `revoke_auto_session`, blocco postback su sessione revocata, ruolo `actionflow_auditor` | Pronta in repo |
| `016_persistent_rate_limit_provider_thresholds_killswitch.sql` | Kilo `016` | Rate limit persistente DB (`10 req/min`), `FRAUDULENT_ACTIVITY`, soglie `3/5` (`PROVIDER_PROTECTION_THRESHOLDS`), `v_treasury_vault_status` estesa | Pronta in repo |
| `017_payout_idempotency_payload_conflict.sql` | Kilo `017` | `request_payload_hash` SHA-256 + blocco `409 IDEMPOTENCY_KEY_PAYLOAD_CONFLICT` | Pronta in repo |
| `018_onchain_verification_tracking.sql` | Kilo `018` | `payout_onchain_verifications`, `record_payout_onchain_verification`, blocco SQL `ONCHAIN_PROOF_NOT_RECORDED_OR_UNVERIFIED` | Pronta in repo |
| `019_treasury_sql_and_session_rollback_hardening.sql` | Kilo `019` | Registro `core.schema_migrations`, trigger append-only log, ruolo `actionflow_app`, rollback punti su `revoke_auto_session`, lock deadlock-safe in `execute_batch_settlement` & `release_settled_to_withdrawable_for_user`, wrapper `core.release_settled`, cross-check completo proof in `complete_payout_atomic` | Pronta in repo |
| `020_payout_dispatch_claims_and_double_spend_guard.sql` | Kilo `020` (`090f479`) | Protezione anti-double-spend persistente su PostgreSQL: `core.payout_dispatch_attempts` (indice parziale univoco anti-concorrenza), state machine (`CLAIMED -> BROADCASTING -> CONFIRMED_ONCHAIN \| UNCERTAIN_TIMEOUT -> COMPLETED`), `core.claim_payout_for_dispatch`, `core.update_payout_dispatch_state` (blocco reinvio su esito incerto), `core.get_uncertain_payout_dispatches` per riconciliazione RPC, `core.payout_dispatch_audit` append-only | Pronta in repo |

---

## 2. Configurazione Variabili d'Ambiente (`.env.example`)

Nessun segreto reale deve essere committato nel repository. Le variabili operative richieste in produzione sono definite in `.env.example`:

* **Database PostgreSQL / Neon**: `DATABASE_URL` (runtime pooled), `DATABASE_URL_UNPOOLED` (migrazioni/backup DDL), `PG_POOL_MAX`, `PG_ALLOW_SELF_SIGNED="false"`.
* **Autenticazione & Doppia Approvazione Admin**: `TELEGRAM_BOT_TOKEN`, `ADMIN_API_TOKEN`, `ADMIN_SECONDARY_API_TOKEN`, `ADMIN_SECONDARY_ID`, `ADMIN_OPERATOR_TOKENS`, `ADMIN_TELEGRAM_IDS`.
* **Sicurezza Inbound & Webhook S2S**: `WEBHOOK_SECRET`, `WEBHOOK_REQUIRE_HMAC="true"`, `WEBHOOK_LEGACY_SECRET_SUNSET_AT`, `EXTRA_ALLOWED_PARTNER_DOMAINS`.
* **Custodia & Verifica Payout (`MANUAL_EXTERNAL` di default)**:
  * `PAYOUT_EXECUTION_MODE="MANUAL_EXTERNAL"` e `ENABLE_AUTO_PAYOUT_DISPATCH="false"` (nessuna chiave privata server-side attiva).
  * `ONCHAIN_TX_VERIFY_REQUIRED="true"` (in `NODE_ENV=production` è sempre obbligatorio e non disattivabile).
  * `CASH_MANUAL_RECEIPT_ALLOW="false"` (in produzione richiede `CASH_GATEWAY_VERIFY_URL` + `CASH_GATEWAY_API_KEY`, salvo autorizzazione manuale esplicita).
* **RPC & Token Contract Address verificabili**:
  * TON: `TON_RPC`, `TON_V3_API_URL`, `TONCENTER_API_KEY`, `TON_USDT_MASTER`, `TON_USDC_MASTER`.
  * Solana: `SOL_RPC`, `SOL_USDT_MINT`, `SOL_USDC_MINT`.
  * Pi Network: `PI_HORIZON_RPC`.
  * Gateway opzionali (se configurati): `CRYPTO_GATEWAY_VERIFY_URL` / `API_URL` / `API_KEY`, `CASH_GATEWAY_VERIFY_URL` / `API_URL` / `API_KEY`, `PI_PAYOUT_API_URL` / `API_KEY`.

---

## 3. Procedura di Backup, Applicazione Migrazioni & Rollback

### 3.1 Pre-Checklist prima di applicare migrazioni su Neon
1. **Attivare Kill Switch payout** prima della manutenzione (`POST /api/admin/kill-switch` con `enabled: true`) per evitare transiti payout concorrenti.
2. **Creare snapshot/branch Neon pre-migrazione** (Neon Console → Branches → *Create branch from `main`* nominato `pre-mig-019-YYYYMMDD`) **e** dump logico di sicurezza con connessione unpooled:
   ```bash
   pg_dump "$DATABASE_URL_UNPOOLED" \
     --schema=core \
     --format=custom \
     --file="backup_core_pre_019_$(date -u +%Y%m%dT%H%M%SZ).dump"
   ```
3. **Verificare integrità contabile pre-migrazione**:
   ```sql
   SELECT core.audit_ledger_integrity();
   SELECT * FROM core.v_treasury_vault_status;
   ```

### 3.2 Applicazione controllata su staging / produzione
Eseguire le migrazioni mancanti in ordine stretto usando `DATABASE_URL_UNPOOLED` dentro transazione atomica (`-v ON_ERROR_STOP=1`):
```bash
for f in migrations/011_*.sql migrations/012_*.sql migrations/013_*.sql migrations/014_*.sql migrations/015_*.sql migrations/016_*.sql migrations/017_*.sql migrations/018_*.sql migrations/019_*.sql migrations/020_*.sql; do
  echo "Applying $f ..."
  psql "$DATABASE_URL_UNPOOLED" -v ON_ERROR_STOP=1 -f "$f"
done
```
Verificare subito dopo:
```sql
SELECT migration_id, source_reference, applied_at FROM core.schema_migrations ORDER BY migration_id;
SELECT core.audit_ledger_integrity();
```

### 3.3 Procedura di Rollback
* **Rollback applicativo**: ripristino del tag Git precedente (`git checkout <tag_precedente> && npm run build`) e riavvio processo Express (`npm start`).
* **Rollback database (preferito — Neon Point-in-Time / Branch Restore)**:
  1. Mantenere `PAYOUT_KILL_SWITCH = TRUE`.
  2. Promuovere il branch Neon `pre-mig-019-*` (o eseguire Point-in-Time Recovery al timestamp immediatamente precedente alla manutenzione).
  3. In alternativa da dump locale: ripristino su nuovo branch pulito con `pg_restore --clean --if-exists --dbname="$TARGET_UNPOOLED_URL" backup_core_pre_019_*.dump` (mai sovrascrivere alla cieca senza verifica `audit_ledger_integrity()`).

---

## 4. Stato dei Test e Verifiche

| Verifica | Comando / Origine | Stato | Note |
|---|---|---|---|
| Suite offline `npm test` (6/6 script: `ledger`, `e2e`, `entry`, `brands`, `hardening`, `economics`) | `DATABASE_URL="" npm test` | **PASS** | Eseguito localmente dopo l'allineamento |
| Build di produzione (`vite build`) | `npm run build` | **PASS** | Bundle compilato senza errori |
| Type-check TypeScript (`tsc --noEmit`) | `npm run lint` | **PASS** | Zero errori di tipo |
| Test live PostgreSQL/Neon (`test:neon`, concorrenza SQL multi-istanza, applicazione `011`–`020`) | Richiede `DATABASE_URL` live | **NON ESEGUITO** | Ambiente privo di DB live e migrazioni produzione bloccate per sicurezza |
| Verifica live RPC blockchain (`TON`, `SOL`, `PI`, `USDT`, `USDC`) e gateway cash reali (`Payeer`, `Airtm`, `Volet`) | Richiede rete/credenziali esterne | **NON ESEGUITO** | Coperti offline con stub fetch + state machine mock (`verify-hardening.ts`); mainnet/testnet live richiedono staging autorizzato |
