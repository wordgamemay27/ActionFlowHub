# ACTIONFLOW_SECURITY_AUDIT.md

## 1. SICUREZZA DELLE VISUALIZZAZIONI
- Simulazione dal frontend: NON IMPLEMENTATA protezione (non esiste tracking impression). I punti non derivano dalla visualizzazione. Classificazione: NON IMPLEMENTATA.
- Accrediti via endpoint: legacy `/api/rewards/record` e `/api/session/complete` → 410 GONE. Classificazione: SICURO E VERIFICATO (B).
- Postback auth: `WEBHOOK_SECRET` required, timingSafeEqual, fail-closed se vuoto. Classificazione: SICURO E VERIFICATO (A/B).
- Replay/duplicazioni: idempotenza event_id, nonce replay guard, advisory lock, FOR UPDATE. Classificazione: IMPLEMENTATA MA NON VERIFICATA a runtime (D).
- Associazione ad attività confermata: postback richiede interaction_id/click_id valido, stato CLICK_REGISTERED, non scaduto, ownership match. Classificazione: SICURO E VERIFICATO (A).

## 2. SICUREZZA DEGLI ACCREDITI
- Formule: raw=FLOOR(gross*100); user_pending=FLOOR(raw*0.30*ppp); platform_margin=raw-user_pending. Classificazione: SICURO E VERIFICATO (A/B).
- PPP: get_country_ppp_coefficient, US/EU=1.0. Classificazione: SICURO E VERIFICATO (A).
- Arrotondamenti: FLOOR coerente lato DB. Classificazione: SICURO E VERIFICATO (A).
- Modifica punti dal client: nessun endpoint pubblico di scrittura saldo; legacy 410. Classificazione: SICURO E VERIFICATO (A).
- Auto-accredito: impossibile senza postback partner. Classificazione: SICURO E VERIFICATO (A).
- Idempotenza/concorrenza: event_id + nonce + advisory lock + FOR UPDATE. Non testato sotto concorrenza reale (D). Classificazione: IMPLEMENTATA MA NON VERIFICATA.

## 3. SICUREZZA WALLET E LEDGER
- Partita doppia/invariante saldi: USER_PENDING +n, SYSTEM:UNEARNED_REVENUE -n. Somma zero. (B: verify-ledger). Classificazione: SICURO E VERIFICATO.
- Quattro bucket: PENDING/SETTLED/WITHDRAWABLE/RESERVED. Classificazione: SICURO E VERIFICATO (A/B).
- Saldi negativi: non verificato esplicitamente nel codice letto; dipende da vincoli SQL (D).
- Doppi accrediti: idempotenza event_id. Classificazione: SICURO E VERIFICATO (A).
- Storni/annullamenti: REVOKED/CHARGEBACK → confirmPartnerReward. Effetto su saldi non verificato (D). Classificazione: NON VERIFICATO.
- Tracciamento movimenti: ledger_transactions + ledger_entries. Classificazione: SICURO E VERIFICATO (A).

## 4. SICUREZZA PRELIEVI
- Solo proprio saldo disponibile: requestPayout usa userId da auth Telegram, points da body. Classificazione: SICURO E VERIFICATO (A).
- Modifica importi/destinatari: validazione asset + regex destinazione. Classificazione: SICURO E VERIFICATO (A).
- Richieste duplicate: idempotencyKey>=4 richiesta. Classificazione: SICURO E VERIFICATO (A), ma unicità client non garantita (problema #5).
- Doppia approvazione: idempotent su completePayout. Classificazione: SICURO E VERIFICATO (A).
- Contabilizzazione post-pagamento: COMPLETED richiede txHash>=8. Classificazione: MANUALE.
- Admin alterazione saldi senza tracciamento: disburse tracciato (request_id, txHash, note). Ma txHash non verificato on-chain automaticamente. Classificazione: IMPLEMENTATA MA NON VERIFICATA.

## 5. SICUREZZA AMMINISTRATIVA
- Auth admin: token x-admin-token o Telegram ID in ADMIN_TELEGRAM_IDS. Classificazione: SICURO E VERIFICATO (A).
- Separazione ruoli: requireAdmin su endpoint admin. Classificazione: SICURO E VERIFICATO (A).
- Protezione endpoint admin: adminLimiter + requireAdmin. Classificazione: SICURO E VERIFICATO (A).
- Utente normale → funzioni riservate: bloccato 401/403. Classificazione: SICURO E VERIFICATO (A/B).
- Audit log: /api/audit/ledger-integrity, /api/audit/guardian. Classificazione: SICURO E VERIFICATO (A).
- Sessioni/token: Telegram HMAC anti-replay 300s. Classificazione: SICURO E VERIFICATO (A/B).

## 6. SICUREZZA APPLICAZIONE
- API Express: helmet, rate limit, body limit 64kb. Classificazione: SICURO E VERIFICATO (A).
- PostgreSQL/Neon: SSL condizionale, pool max 20. Classificazione: SICURO E VERIFICATO (A).
- Query SQL: parametrizzate ($1..), no concatenazione. Classificazione: SICURO E VERIFICATO (A).
- Telegram Mini App auth: HMAC + anti-replay. Classificazione: SICURO E VERIFICATO (A/B).
- Webhook: secret timingSafeEqual, fail-closed. Classificazione: SICURO E VERIFICATO (A).
- Worker: fail-closed (FX unavailable → 503). Classificazione: SICURO E VERIFICATO (A).
- Env/secrets: dotenv, token non esposti (wallet config solo receiveAddress). Classificazione: SICURO E VERIFICATO (A).
- Dipendenze: non auditate per CVE (D).
- Gestione errori: try/catch, messaggi generici. Classificazione: SICURO E VERIFICATO (A).
- Rate limiting: general 120/min, financial 30/min, admin 60/15min, webhook 60/min. Classificazione: SICURO E VERIFICATO (A).
- Validazione input: allowlist categorie, asset, regex wallet, min 500 PT. Classificazione: SICURO E VERIFICATO (A).
- Accessi non autorizzati: auth obbligatoria su endpoint finanziari. Classificazione: SICURO E VERIFICATO (A).
- OWASP: non auditato formalmente (D). Possibili: nessun CSRF token (Telegram Mini App, mitigato da HMAC), nessun CSP (helmet CSP disabilitato).

## 7. TEST DI ROBUSTEZZA (non eseguiti, solo deduzioni dal codice)
- Richieste duplicate: idempotenza su event_id/nonce (A, D runtime).
- Importi manipolati: validazione payout>0, min 500 PT (A).
- Utenti non autorizzati: 401/403 (A/B).
- Accessi admin non autorizzati: 401/403 (A/B).
- Accrediti simultanei: FOR UPDATE + advisory lock (A, D runtime).
- Prelievi concorrenti: atomico requestPayout (A, D runtime).
- Postback invalidi: 400 con messaggio (A).
- Eventi annullati/ripetuti: REVOKED + idempotenza (A, D runtime).

## 8. PROBLEMI (gravità/file/righe/causa/conseguenza/prova/correzione)
1. Media — migrations/ — gap 003 — numerazione — confusione audit/deploy — ls migrations — rinumerare/documentare.
2. Media — migrations/012 — partner_exposure max_exposure_limit 500000 hardcoded — cap per-partner fisso — lettura SQL — cap configurabile + cap treasury globale.
3. Alta (potenziale) — src/server.ts:879 + migrazione 012:641 — Math.round vs FLOOR — incoerenza arrotondamento — confronto codice — unificare su gross_usd/FLOOR.
4. Bassa — src/db/ledgerService.ts getUserGeoProfile — condizione dbPpp vs 0.2 — PPP potrebbe non usare valore DB — lettura codice — rivedere condizione.
5. Media — src/server.ts /api/payout/request — idempotencyKey senza garanzia unicità client — doppio prelievo possibile — lettura codice — documentare contratto client / generare server-side.
6. Info — src/server.ts — chunk JS 1.34MB — performance — build output — code-splitting.

## 9. CLASSIFICAZIONE COMPONENTI
- SICURO E VERIFICATO: auth Telegram, webhook auth, input validation, rate limiting, SQL parametrizzato, helmet, legacy 410, double-entry invariant (test), idempotenza (codice).
- PROBLEMA RISCONTRATO: #1-#6 sopra.
- NON VERIFICATO: storni post-liquidazione, race condition runtime, payout on-chain, gateway cash, frontend→API, dipendenze CVE, OWASP formale, DB live.
- NON IMPLEMENTATO: impression tracking, gateway cash reali, verifica on-chain automatica, referral/bonus, scheduler settlement automatico.

## 10. RISCHI RESIDUI
- Nessun payout on-chain eseguito (no wallet).
- Nessun DB live testato.
- Nessuna verifica on-chain del txHash.
- Admin può completare payout con txHash non verificato.
- Cap esposizione per-partner, non globale.
- Settlement haircut post-accredito senza rollback punti.

Non dichiaro il sistema inviolabile. Parti D non verificate. Priorità: proteggere utenti, punti, wallet e fondi admin.