# Eiopago/Guardian — roadmap congelata dopo M0.1

**Versione:** 0.1 — 2026-08-05  
**Fonte autorevole:** questo file governa scope e ordine delle milestone; lo stato runtime dei task appartiene al Master Task Ledger e non viene dedotto da questa roadmap.

## Gate corrente

### M0.1 — Contract and Boundary Freeze

Consegne documentali:

- source of truth e precedenze;
- checkpoint-as-operational-commit e lifecycle;
- handoff/human latch state machine;
- matrice API Pi e spike necessari;
- contratti minimi provider-neutral;
- confini Eiopago/Durex/FARO Governance/Raiatea/Alfred;
- modalità standalone.

M0.1 non contiene codice applicativo e non rende COMPLETE le funzionalità M1.

## Milestone

| Milestone | Scope congelato | Esclusioni/gate |
|---|---|---|
| **M1** | Cost Guard + confirm handoff + human takeover | Nessun auto; block-next-call deve essere provato |
| **M1.1** | supervised-auto + crash recovery | Solo dopo vertical slice M1 e test race/crash |
| **M1.2** | Guardian Runner, soltanto se necessario | Richiesto se Extension non garantisce block/automazione robusta |
| **M2** | attribution, review budget e roadmap completa | Non ritarda P0 |
| **M3** | TokenSave/TraceDecay | Adapter opzionale dopo misura/stop |
| **M4** | pi-auto-router | Guardian mantiene hard budget e call authorization |
| **M5** | provider e reconciliation | Billing/import/alias, fonti separate |
| **M6** | forecasting | Dopo telemetria reale |
| **M7** | adaptive routing | Inizia advisory/shadow; policy e conferma |
| **M8** | benchmark | Costo fino all'accettazione, metodologia versionata |
| **M9** | grafici avanzati | TUI interattiva/renderer avanzati |
| **M10** | condivisione | Solo opt-in e redazione |
| **M11** | dashboard | Ultima fase; non ritarda i controlli economici |

## Criteri obbligatori M1

M1 può chiudersi soltanto con codice e test per tutti i punti seguenti:

1. **Telemetria:** input, output, reasoning, cache read/write, contesto, costo e provenienza.
2. **Storage:** SQLite versionato per dati runtime canonici; raw/normalized separati; recovery e conflict handling.
3. **Master Task Ledger minimo:** Markdown canonico, ID/revisioni/dipendenze/evidenze, import indicizzato senza sync silenziosa.
4. **Checkpoint model:** `CandidateCheckpoint`, parent/DAG, digest, stati interni, immutabilità e distinzione da external acceptance.
5. **Warning e soglie:** scope e precisione definiti, override umano tracciato.
6. **Block-next-call:** vero gate o fallback Extension dimostrato da SP-01; se non dimostrabile, decisione esplicita `REQUIRES_RUNNER` e nessuna falsa garanzia.
7. **Human-control latch:** persistente, fail-closed, rilascio esclusivamente umano e race testate.
8. **Confirm handoff:** saga transazionale/idempotente con takeover prioritario.
9. **Sessione pulita:** parent preservato e nessuna cronologia copiata.
10. **Prompt minimo:** generato senza call dedicata, inviato exactly-once solo dopo continuity e latch.
11. **Continuity Check:** Ledger/checkpoint/Git/schema/evidenze coerenti; mismatch blocca.
12. **CSV/JSON:** export locale versionato, unknown preservato e injection-safe.
13. **Roadmap oneline minima:** offline, deterministica, senza LLM/provider e sola projection.

## Spike gate prima/durante M1

| ID | Obiettivo | Esito richiesto |
|---|---|---|
| SP-01 | Block-next-call Extension nelle race tool/retry/queue | Zero provider request dopo latch; altrimenti Runner |
| SP-02 | Abort su fake slow stream | Stream aborted, stato persistito, nessun retry inatteso |
| SP-03 | Safe point | Nessuna nuova fase/tool e queue controllata |
| SP-04 | Prompt replacement session | Pausa prima del prompt ed exactly-once dopo continuity |
| SP-05 | Shutdown/suspend | Chiusura graceful e pausa Guardian senza queue residua |
| SP-06 | Reload/crash | Restore M1.1; process crash unattended richiede owner esterno |
| SP-07 | Hotkey Windows | Nessuna collisione con Escape; converge sul latch |
| SP-08 | Failure `newSession()` dopo teardown | Journal riconciliabile, nessun secondo target automatico |
| SP-09 | Takeover durante commit | Target nasce pausato, prompt non inviato |
| SP-10 | Ledger/checkpoint import | Idempotenza e conflitti hash visibili |

## Confini di roadmap

- M1 resta standalone: nessuna dipendenza obbligatoria da Durex, FARO Governance o Raiatea.
- Durex/FARO/Raiatea/Alfred comunicano in futuro tramite contratti versionati; nessun database condiviso.
- TokenSave, pi-auto-router e provider non vengono anticipati in M1.
- `VERIFIED` Guardian non equivale ad `ACCEPTED` esterno.
- Ogni cambio a ownership, source of truth o lifecycle richiede un nuovo ADR.
