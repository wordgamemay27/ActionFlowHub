# INCARICO DI SVILUPPO – COMPLETAMENTO DELLE SPECIFICHE FINANZIARIE AUTOMATICHE

## OBIETTIVO

Completare le 10 nuove specifiche economiche e operative, integrandole nei moduli esistenti senza alterare le funzionalità già conformi.

Non riscrivere il sistema esistente se non necessario.

Prima di ogni intervento verificare dipendenze, codice, database e compatibilità.

## 1. Acquisizione selettiva delle informazioni

Integrare la lettura automatica di fonti pubbliche e private autorizzate.

Utilizzare esclusivamente le informazioni pertinenti alle logiche finanziarie e operative dei fornitori.

## 2. Valutazione automatica dei fornitori

Integrare ai criteri di performance già esistenti:

- Tempi contrattuali di pagamento.
- Scadenze.
- Regolarità dei pagamenti.
- Saldi dovuti.
- Esposizione finanziaria.
- Affidabilità maturata.

Privilegiare i fornitori con pagamenti più brevi e regolari.

## 3. Esposizione progressiva

Implementare:

- Nuovo fornitore: esposizione minima.
- Fornitore regolare: possibilità di 2 esposizioni.
- Affidabilità consolidata: massimo 3 esposizioni.
- Esposizione aggiuntiva massima: 25% del saldo dovuto.

## 4. Scadenze e limitazioni

Implementare il controllo automatico delle scadenze contrattuali.

Alla scadenza senza pagamento:

- Applicare le limitazioni previste.
- Bloccare nuove assegnazioni che aumentino l'esposizione oltre il limite.
- Mantenere le limitazioni fino al pagamento.

Dopo il pagamento effettivo, riattivare automaticamente il fornitore se sussistono le condizioni di affidabilità.

## 5. Alternanza dei fornitori

Integrare il ranking esistente con il bilanciamento finanziario.

Distribuire automaticamente i cicli per:

- Privilegiare pagamenti brevi.
- Evitare concentrazioni.
- Ridurre l'esposizione.
- Evitare vuoti operativi eccessivi.

## 6. Prelievi utenti

Implementare le fasce di approvazione:

- Immediata.
- Da 1 a 10 giorni lavorativi.

Associare la fascia alle condizioni del servizio e del relativo ciclo finanziario.

Comunicare preventivamente i termini applicabili agli utenti.

## 7. Stati dei prelievi

Completare la distinzione tra:

- Guadagno maturato.
- In attesa di verifica.
- Prelievo approvato.
- Pagamento programmato.
- Pagamento effettuato.

Aggiungere lo stato SCHEDULED se necessario, preservando gli stati già esistenti.

## 8. Penalità utenti

Implementare la penalità pari a 2 volte l'importo di riferimento, esclusivamente dopo accertamento della responsabilità.

Se i fondi sono insufficienti:

- Registrare il debito.
- Recuperarlo dai successivi accrediti.
- Conservare il saldo residuo fino al completo recupero.

Mantenere le verifiche basate su prove documentabili.

## 9. Coordinamento automatico

Integrare i moduli esistenti attraverso un orchestratore finanziario unico.

Deve coordinare:

- Fornitori.
- Cicli.
- Esposizioni.
- Scadenze.
- Incassi.
- Pagamenti.
- Limitazioni.
- Riattivazioni.
- Prelievi utenti.

## 10. Sostenibilità finanziaria

Il sistema deve minimizzare automaticamente l'esposizione, evitare anticipazioni non necessarie e sincronizzare i flussi finanziari con i tempi effettivi dei fornitori.

## MODALITÀ DI SVILUPPO

1. Effettuare prima una verifica completa del codice esistente.
2. Riutilizzare i moduli già conformi.
3. Evitare duplicazioni di logica.
4. Mantenere partita doppia, idempotenza, fail-closed e controlli di sicurezza.
5. Implementare transazioni atomiche e verifiche delle condizioni finanziarie.
6. Non modificare le funzionalità già conformi senza motivazione tecnica.
7. Eseguire test automatici e di regressione.
8. Documentare ogni modifica.
9. Non dichiarare implementata una funzionalità senza prove nel codice e test verificabili.

## RISULTATO ATTESO

Un unico sistema automatico di gestione finanziaria, integrato con l'architettura esistente, che governi fornitori, cicli, esposizioni, pagamenti e prelievi utenti.

Importante: questo è l'incarico di sviluppo, non la dichiarazione che le funzionalità siano già state realizzate.

Questo documento costituisce la base per riprendere il lavoro anche in una nuova chat senza perdere le decisioni.