# Aiopago/Guardian — roadmap di prodotto

**Versione:** 0.2 — 2026-08-20
**Fonte autorevole:** questo file governa scope e ordine delle milestone; lo stato runtime dei task appartiene al Master Task Ledger e non viene dedotto da questa roadmap.

## Sequenza Aiopago 0.2

| Slice | Scope | Gate |
|---|---|---|
| **0.2-A — Read-only Human Workflow** | `status`, `why`, `next`, `plan`, projection umana e osservazione realmente read-only | **CLOSED**; nessuna mutation |
| **0.2-B — Plan Proposal Foundation** | Plan Port mutating, proposal, compare-and-swap, validazione/materializzazione, diff e provenance minima | **CLOSED / ACCEPTED**; due round indipendenti CLEAN sul candidate `7d53b6e5c99557c70f9e2aa89039618ca0ca7fe6` |
| **0.2-C — Intent Adapter minimo** | `plan.observe/propose/validate/diff/apply` | **READY FOR INDEPENDENT REVIEW**; acceptance 0/2, non CLOSED |
| **0.2-D — Start da obiettivo** | `aio start <obiettivo>` con planning agent-driven e autorizzazione | **NOT STARTED / BLOCKED** fino all'acceptance 0.2-C |
| **0.2-E — UX interattiva unificata** | Projection condivisa nel TUI e handoff umano semplificato | Invarianti core preservate |
| **0.2-F — Stop e ripresa durable** | Sospensione distinta dal takeover e continuity cross-process | Richiede protocollo core dedicato |
| **0.2-G — Block/unblock umano** | Human Action Broker minimo e blocker strutturati | Nessuna inferenza autonoma di completion |
| **0.2-H — Completamento guidato** | Verifica criteria/evidence e chiusura confermata | `DONE` non implica acceptance esterna |
| **0.2-I — Authority routing** | `PROPOSE`, `ESCALATE`, `DEFER` e boundary FARO | Nessuna decisione strategica automatica |
| **0.2-J — Autonomy modes** | Introduzione progressiva di `MANUAL`, `GUIDED`, `AUTO` | Solo con authority e safety invariants verificati |

Gate vincolante dopo 0.2-A:

1. **Dedicated rename migration: COMPLETE**;
2. **0.2-B Plan Proposal Foundation: CLOSED / ACCEPTED** dopo due round indipendenti CLEAN;
3. **0.2-C Intent Adapter minimo: READY FOR INDEPENDENT REVIEW**, gate 0/2;
4. **0.2-D Start da obiettivo: NOT STARTED / BLOCKED** fino all'acceptance 0.2-C.

La migration di nome, 0.2-A e 0.2-B restano chiuse. 0.2-C espone soltanto la superficie programmatica strutturata `plan.*`; non anticipa parsing naturale, provider o planning agent-driven di 0.2-D.

## Fondazione M0/M1

### M0.1 — Contract and Boundary Freeze

Consegne documentali:

- source of truth e precedenze;
- checkpoint-as-operational-commit e lifecycle;
- handoff/human latch state machine;
- matrice API Pi e spike necessari;
- contratti minimi provider-neutral;
- confini Aiopago/Durex/FARO Governance/Raiatea/Alfred;
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
