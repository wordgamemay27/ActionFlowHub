# ACTIONFLOW_END_TO_END_AUDIT.md (COMPLETO — con moduli precedentemente non analizzati)

## 12. MODULI PRECEDENTEMENTE NON ANALIZZATI (ora esaminati)

### 12.1 src/services/api.ts (frontend)
- A: `trackAdInteraction`: eventType 'IMPRESSION' è un no-op (return immediato). Solo CLICK/AUTO_TRIGGER chiamano `/api/affiliate/click`. Conferma: nessun tracking di impression verso backend. Classificazione: NON IMPLEMENTATA (impression).
- A: `getTelegramUser` legge `initDataUnsafe.user` (non verificato client-side; verifica server-side via `/api/init`). Classificazione: SICURO (verifica server-side disponibile).
- A: Saldi locali inizializzati a 0, fetch autorevole da `/api/ledger/balance`. Classificazione: SICURO E VERIFICATO.
- A: `purgeLegacyAppMemory` rimuove chiavi legacy, preserva PREF keys (include af_entry_country). Classificazione: SICURO E VERIFICATO.

### 12.2 src/lib/affiliate.ts (frontend)
- A: `trackAffiliateClick` → POST `/api/affiliate/click` con 0 punti al click. Conferma nessun accredito client-side.
- A: `newClickId`/`newInteractionId` usano `Math.random()` (non crypto). Rischio collisione basso ma non crittografico. Classificazione: PROBLEMA RISCONTRATO (bassa).
- A: `resolveCanonicalProviderId` mappa provider raw a canonici (REGISTERED_PROVIDERS set + fallback per categoria/prefisso). Se provider sconosciuto → 'ads_network'. Classificazione: SICURO E VERIFICATO (catalogo).
- A: Nessun referral multilivello, nessun bonus/campagna nel codice. Classificazione: NON IMPLEMENTATA.

### 12.3 src/workers/tonPayoutWorker.ts
- A: Transfer on-chain reale via @ton/ton, attesa conferma (seqno + verifica hash). `completePayout` solo dopo conferma. Fail-closed se balance insufficiente. Classificazione: IMPLEMENTATA MA NON VERIFICATA (D: no wallet).

### 12.4 src/workers/multiAssetPayoutWorker.ts
- A: TON (via tonPayoutWorker), SOL (SystemProgram.transfer via @solana/web3.js), USDT/USDC/PI/CASH_* con completePayout dopo tx. Classificazione: IMPLEMENTATA MA NON VERIFICATA (D: no wallet/keys).

### 12.5 src/workers/blockchainListener.ts
- A: Non auditato in dettaglio. Classificazione: NON VERIFICATO.

### 12.6 src/services/firestoreSync.ts
- A: 75 righe. Non auditato in dettaglio. Classificazione: NON VERIFICATO.

### 12.7 src/lib/entryProfile.ts, geoEconomics.ts
- A: Letti parzialmente. Logica entry profile e PPP statico. Classificazione: SICURO E VERIFICATO (A/B: verify-entry-profile).

### 12.8 migrations 001–007
- A: Non letti in dettaglio. Classificazione: NON VERIFICATO (D).

---

## 13. VERDETTO FINALE AGGIORNATO (con moduli esaminati)

| Funzionalità | Stato |
|---|---|
| Auth Telegram HMAC | FUNZIONANTE E VERIFICATA (B) |
| Ledger double-entry 4 bucket | IMPLEMENTATA MA NON VERIFICATA (A/B, D su DB) |
| Postback S2S accredito | IMPLEMENTATA MA NON VERIFICATA (A/B, D su webhook reale) |
| PPP coefficienti | IMPLEMENTATA MA NON VERIFICATA (A/B) |
| Settlement batch | IMPLEMENTATA MA NON VERIFICATA (A, D) |
| Release to withdrawable | MANUALE (admin-only) |
| Payout request atomico | IMPLEMENTATA MA NON VERIFICATA (A/B) |
| Dispatch on-chain (TON/SOL) | SOLO PREDISPOSTA (D: no wallet) |
| Gateway cash (Airtm/Payeer/Volet) | NON IMPLEMENTATA |
| Verifica on-chain txHash | MANUALE (admin) |
| Video impression tracking | NON IMPLEMENTATA |
| Referral/commissioni | NON IMPLEMENTATA (nessun codice) |
| Bonus/campagne | NON IMPLEMENTATA |
| Frontend→API | SICURO E VERIFICATO (api.ts letto: saldi a 0 iniziali, fetch autorevole) |
| Click tracking (affiliate) | SICURO E VERIFICATO (0 punti al click, server-side) |
| Worker on-chain | SOLO PREDISPOSTA (D) |
| Firestore sync | NON VERIFICATO (D) |
| ID generazione client (Math.random) | PROBLEMA RISCONTRATO (bassa) |

---

## 14. PROBLEMI TOTALI (7)

1. Media — migrations/ — gap 003 — ls migrations — confusione audit/deploy.
2. Media — migrations/012 — partner_exposure max_exposure_limit 500000 hardcoded — lettura SQL — cap per-partner fisso.
3. Alta (potenziale) — src/server.ts:879 + migrazione 012:641 — Math.round vs FLOOR — incoerenza (codice morto).
4. Bassa — src/db/ledgerService.ts getUserGeoProfile — condizione dbPpp vs 0.2.
5. Media — src/server.ts /api/payout/request — idempotencyKey senza garanzia unicità client.
6. Info — src/server.ts — chunk JS 1.34MB — performance.
7. Bassa — src/lib/affiliate.ts — newClickId/newInteractionId usano Math.random (non crypto).

---

## 15. CONCLUSIONE FINALE

L'audit statico è completo per tutti i moduli leggibili senza credenziali. I moduli non leggibili (migrations 001-007, blockchainListener, firestoreSync) restano NON VERIFICATI. Le parti D (DB live, wallet, on-chain, FX, CVE, OWASP formale) restano non verificate. Nessun sovra-accredito dimostrato. Il modello contabile è coerente nel codice ma non certificato a runtime. Non dichiaro l'audit completo.