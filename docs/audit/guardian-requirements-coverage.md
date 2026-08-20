> **Historical pre-rename record.** Names, identifiers, commands, repository/worktree paths and measured protocol references below are retained as immutable provenance. The current product is Aiopago; use `docs/portable-alpha.md` for canonical `aio` usage and `docs/rename-aiopago-migration.md` for compatibility.

# Guardian — audit di copertura dei requisiti

**Data audit:** 2026-08-05  
**Ambito:** sola copertura documentale/implementativa; nessuna implementazione e nessuna estensione di M0.  
**Repository:** `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, zero commit.  
**Fonti iniziali nel repository:** `Guardian_Pi_Agent_Guida_Funzionale.pdf` v0.1 (incluso il suo indice), `docs/it/00-regole-operative.md` e `CHECKPOINT.md`. **Aggiornamento M0.1:** aggiunti `docs/adr/0015-m0-boundaries-and-contract-freeze.md`, `docs/contracts/m0-contracts.md` e `docs/roadmap.md`, con riscontro mirato di `Sistema_FARO_Guardian_Durex_Babysitting_Agenti.pdf`. Non esistono sorgenti o test applicativi Eiopago. I test citati dal checkpoint appartengono a progetti terzi isolati e non provano funzionalità Eiopago. Il PDF dichiara esplicitamente di descrivere comportamento previsto, non disponibilità implementata.

## Metodo e legenda

- **COMPLETE:** requisito documentato, implementato e verificato con evidenza pertinente.
- **PARTIAL:** requisito o vincolo documentato, ma specifica, implementazione o verifica è incompleta.
- **MISSING:** requisito non coperto in modo sostanziale da documentazione, codice o test.
- **CONFLICTING:** fonti vigenti incompatibili senza una risoluzione documentata.
- **OUT_OF_SCOPE:** esplicitamente assegnato fuori dall'ambito Eiopago corrente.
- **NOT_VERIFIABLE:** esiste un'affermazione, ma le evidenze disponibili non permettono di verificarla.

In tutte le tabelle, **codice/test: nessuno** significa che nel repository non esistono sorgenti o test Eiopago. La presenza nella roadmap non è considerata completamento. Le decisioni indicate come provvisorie o non ratificate restano `PARTIAL`.

## 1. Cost Guard

| Requisito | Stato | Documentazione | Codice/test | Lacuna esatta | Milestone | Dipendenze | Rischio |
|---|---|---|---|---|---|---|---|
| Telemetria input/output/reasoning/cache | PARTIAL | `CHECKPOINT.md` § Ambiente rilevato, § Audit Pi completato, § Priorità economiche | Nessuno; sono registrate solo osservazioni manuali di JSONL Pi | Mancano schema canonico, ingestione, deduplica, persistenza e test Eiopago | M1 | API/session JSONL Pi; modello dati | Alto: conteggi doppi o incompleti |
| Costo per fase e sessione | PARTIAL | `CHECKPOINT.md` § Statistiche al gate, § Priorità economiche (telemetria/fasi/storage), righe sui dati roadmap | Nessuno | Il costo di sessione è stato calcolato manualmente; non esistono attribuzione per fase, fonti normalizzate né test | M1 base; attribuzione completa M2 | Telemetria, lineage, riconciliazione | Alto: decisioni budget errate |
| SQLite | PARTIAL | `CHECKPOINT.md` § Decisioni già prese e limiti; § Rischi n. 22 | Nessuno; schema/migrazione esplicitamente non iniziati | Archivio previsto ma decisione non ratificata; schema, migrazioni, concorrenza e rapporto con Markdown aperti | M1 | Modello dati; source of truth | Alto: doppia fonte divergente |
| Warning | PARTIAL | `CHECKPOINT.md` § Statistiche al gate; § Priorità economiche | Nessuno | Esistono soglie usate nell'audit e una voce roadmap, non un contratto runtime configurabile e testato | M1 | Telemetria, policy budget | Alto |
| Soglie | PARTIAL | `CHECKPOINT.md` § Statistiche al gate; § Priorità economiche | Nessuno | Mancano semantica per scope/fase/sessione, precisione, persistenza, aggiornamento e test limite | M1 | Accounting, configurazione | Critico |
| Block-next-LLM-call | PARTIAL | `CHECKPOINT.md` § Audit Pi completato (limite critico); § Rischi n. 2; § Priorità economiche | Nessuno; API dichiarata non verificata | Nessun hook bloccabile provato e nessun harness offline; la fattibilità Extension è aperta | M1 | Verifica API Pi; latch; stop | Critico: spesa oltre limite |
| Checkpoint-and-stop | PARTIAL | `CHECKPOINT.md` § Priorità economiche; § Roadmap vincolante | Nessuno | È un requisito di roadmap senza protocollo atomico, modello checkpoint o test failure | M1 | Block-next-call, storage, integrità Git | Critico |
| Export CSV/JSON | PARTIAL | `Guardian_Pi_Agent_Guida_Funzionale.pdf` § UC-16 e § Sicurezza; `CHECKPOINT.md` righe 104–111 | Nessuno | Ambiti/formati e sicurezza sono richiesti; schema, versionamento, provenance e test export non esistono | M1/M9 nel PDF | Modello dati, sicurezza output | Medio |
| TUI minima Cost Guard | PARTIAL | `Guardian_Pi_Agent_Guida_Funzionale.pdf` § UC-01, UC-02 e UC-16; `CHECKPOINT.md` § pi-token-usage e pi-usage | Nessuno; solo pattern terzi auditati | Footer/pannello/TUI sono descritti, ma contratto UI, API e criteri/test non esistono | M1/M9 | Telemetria, API TUI Pi | Medio |

## 2. Automatic Session Handoff

| Requisito | Stato | Documentazione | Codice/test | Lacuna esatta | Milestone | Dipendenze | Rischio |
|---|---|---|---|---|---|---|---|
| Modalità `manual` | PARTIAL | `CHECKPOINT.md` righe 115–120; § Decisioni già prese e limiti | Nessuno | Comando nominato, ma transizioni, input/output e API non verificati | M1 | API comandi/sessione; state machine | Alto |
| Modalità `confirm` | PARTIAL | `CHECKPOINT.md` righe 92, 115–120; § Priorità economiche | Nessuno | Default e collocazione M1 definiti; mancano UX di conferma, atomicità e test E2E | M1 | Handoff prepare/commit; latch | Critico |
| Modalità `supervised-auto` | PARTIAL | `CHECKPOINT.md` righe 115–120; roadmap | Nessuno | Nome, priorità e milestone presenti; policy di supervisione e trigger assenti | M1.1 | M1 stabile; crash recovery | Alto |
| Modalità `auto` | PARTIAL | `CHECKPOINT.md` righe 115, 119–120; § Rischi n. 27 | Nessuno | Disabilitata per default e Runner condizionale, ma fattibilità e contratto non provati | M1.2 se necessario | Verifica Extension vs Runner | Critico |
| Nuova sessione senza cronologia | PARTIAL | `CHECKPOINT.md` righe 92, 95; § Priorità economiche | Nessuno | È richiesto un pacchetto minimo, ma non esistono schema, redazione o test che provino assenza di history | M1 | API `newSession`; manifest | Critico: leakage/contesto duplicato |
| Parent session | PARTIAL | `CHECKPOINT.md` righe 92, 120; § Rischi n. 10; § Roadmap vincolante | Nessuno | Parent linkage richiesto ma semantica API non verificata | M1 | API sessione Pi | Alto |
| Prompt minimo di ripresa | PARTIAL | `docs/it/00-regole-operative.md` § Chiusura e passaggio; esempi in `CHECKPOINT.md`; § Priorità economiche | Nessun generatore/test automatico | La pratica manuale è attiva, ma non è implementato il prompt automatico di handoff né validata la sua sufficienza | M1 | Quality Gate; manifest; ledger | Alto |
| Handoff Quality Gate | PARTIAL | `CHECKPOINT.md` righe 95, 438; § Prossimo passo | Nessuno | Nome e principio di blocco presenti; criteri, esiti e algoritmo non definiti | M1 | Ledger/checkpoint/Git; evidenze | Critico |
| Continuity Verification | PARTIAL | `CHECKPOINT.md` righe 95, 100, 438; § Roadmap vincolante | Nessuno | Sono richiesti blocco su discrepanza e verifica ledger, ma manca protocollo verificabile | M1 | Manifest, ledger, Git | Critico |
| Resume Context Manifest | PARTIAL | `CHECKPOINT.md` righe 95, 394, 437 | Nessuno | Concetto richiesto; schema, versione, redazione, dimensioni e validazione mancanti | M1 | Ledger/checkpoint; sicurezza | Critico |
| Limiti agli handoff | PARTIAL | `Guardian_Pi_Agent_Guida_Funzionale.pdf` § Configurazione iniziale (`max_handoffs_per_task: 4`, `max_sessions_per_task: 6`); `CHECKPOINT.md` riga 95 | Nessuno | Default e principio anti-loop presenti; enforcement, override, contatori e comportamento al superamento non sono implementati | M1.1 | Persistenza; policy per task | Alto: loop e costo control-plane |
| Crash recovery | PARTIAL | `CHECKPOINT.md` righe 95, 116, 119; roadmap | Nessuno | Milestone e persistenza latch indicate; recovery journal, idempotenza e scenari crash assenti | M1.1 | Transazioni; persistence; state machine | Critico |

## 3. Human Takeover

| Requisito | Stato | Documentazione | Codice/test | Lacuna esatta | Milestone | Dipendenze | Rischio |
|---|---|---|---|---|---|---|---|
| `pause` | PARTIAL | `CHECKPOINT.md` righe 116–117 | Nessuno | Comando elencato; semantica, idempotenza e feedback non definiti | M1 | Latch persistente; API input | Critico |
| `takeover` | PARTIAL | `CHECKPOINT.md` righe 115–118 | Nessuno | Comando e precedenza presenti, ma nessun protocollo/test runtime | M1 | Latch; abort sicuro | Critico |
| `resume` | PARTIAL | `CHECKPOINT.md` righe 116–118 | Nessuno | Solo l'utente dovrebbe rilasciare il latch; autenticità, validazioni e stato di errore mancanti | M1 | Persistenza; continuity check | Critico |
| `handoff cancel` | PARTIAL | `CHECKPOINT.md` riga 117 | Nessuno | Comando nominato senza stati cancellabili, atomicità o risultato | M1 | State machine handoff | Alto |
| Modifica del piano | PARTIAL | `CHECKPOINT.md` riga 117; § Rischi n. 28 | Nessuno | Comandi e invalidazione sono richiesti; manca un ledger reale, versionamento operativo e approvazione | M1 | Master Task Ledger; latch | Alto |
| Precedenza dell'intervento umano | PARTIAL | `CHECKPOINT.md` riga 116; § Rischi n. 24 | Nessuno | Ordine di precedenza esplicito, ma non ratificato né provato in race | M1 | Latch atomico; test concorrenza | Critico |
| Handoff transazionale | PARTIAL | `CHECKPOINT.md` riga 118; § Rischi n. 24 | Nessuno | COMMIT minimo e no rollback parziale sono richiesti, ma confini transazionali e journal mancano | M1 | Storage atomico; API sessione | Critico |
| Intervento durante commit del cambio | PARTIAL | `CHECKPOINT.md` riga 118; § Rischi n. 24 | Nessuno | Esito atteso `NEW_SESSION_PAUSED` documentato; nessun test race/crash | M1 | Handoff transazionale; latch | Critico |
| Lock/latch persistente | PARTIAL | `CHECKPOINT.md` riga 116; § Rischi n. 24, 26 | Nessuno | Persistenza attraverso reload/crash richiesta; formato, ownership, locking e recovery assenti | M1 | SQLite/storage; Extension/Runner | Critico |
| Hotkey o steering deterministico | PARTIAL | `CHECKPOINT.md` righe 117, 120; § Rischi n. 25 | Nessuno | Requisito presente, ma binding Windows/API e convergenza sul latch non verificati | M1 | API TUI/input/steering Pi | Alto |

## 4. Master Task Ledger

| Requisito | Stato | Documentazione | Codice/test | Lacuna esatta | Milestone | Dipendenze | Rischio |
|---|---|---|---|---|---|---|---|
| Piano globale distinto dal checkpoint | PARTIAL | `CHECKPOINT.md` righe 99–101; § Rischi n. 15 | Nessuno; ledger esplicitamente non creato | Distinzione definita, ma manca la fonte canonica effettiva e la convenzione file | M0 decisione; vertical slice M1 | Scelta Markdown/SQLite | Critico |
| ID stabili attività | PARTIAL | `CHECKPOINT.md` riga 99 | Nessuno | Requisito esplicito; formato, namespace e regole di rinomina mancanti | M0/M1 | Schema ledger | Alto |
| Stati attività | PARTIAL | `CHECKPOINT.md` riga 99 | Nessuno | È richiesto uno stato stabile e `DONE` con evidenza, ma manca l'enum/transizioni | M0/M1 | Schema; evidence gate | Alto |
| Dipendenze | PARTIAL | `CHECKPOINT.md` riga 99; roadmap DAG righe 103–104 | Nessuno | DAG richiesto; edge types, cicli e validazione non definiti | M0/M1 | Schema ledger | Alto |
| Criteri di completamento | PARTIAL | `CHECKPOINT.md` righe 99, 441 | Nessuno | Divieto `DONE` senza evidenza presente; criteri per task e validatore assenti | M0/M1 | Evidenze; acceptance | Critico |
| Evidenze | PARTIAL | `CHECKPOINT.md` righe 99, 108, 441 | Nessuno | Evidenze verificabili richieste; tipi, URI/hash, integrità e verifica assenti | M0/M1 | Evidence model | Critico |
| Versionamento requisiti | PARTIAL | `CHECKPOINT.md` righe 99–100 | Nessuno | Requisiti versionati richiesti; schema/version IDs e migration policy mancanti | M0/M1 | Ledger canonico | Alto |
| Attività `SUPERSEDED` | PARTIAL | `CHECKPOINT.md` riga 99; riga 110 per ExpectedCheckpoint | Nessuno | Semantica generale richiesta ma non distinta tra requisito, task e checkpoint | M0/M1 | State model | Medio |
| Aggiornamento progressivo | PARTIAL | `CHECKPOINT.md` righe 95, 100 | Nessuno | Determinismo richiesto; protocollo di update, lock e audit trail mancanti | M1 | Storage; versioning | Alto |
| Coerenza con checkpoint e repository | PARTIAL | `CHECKPOINT.md` righe 100, 438, 441 | Nessuno | Blocco su divergenza richiesto; algoritmo, hash, acceptance e repair policy assenti | M1 | Git, continuity, evidence | Critico |

## 5. Checkpoint Model

| Requisito | Stato | Documentazione | Codice/test | Lacuna esatta | Milestone | Dipendenze | Rischio |
|---|---|---|---|---|---|---|---|
| `checkpoint_message` | PARTIAL | `CHECKPOINT.md` righe 109, 113, 121; esempi nelle chiusure | Nessuno | Campo usato manualmente e vincolo 72–100 ideale; schema, ID, validazione e storage immutabile assenti | M1 minimo roadmap | Modello checkpoint | Medio |
| Parent checkpoint | PARTIAL | `docs/contracts/m0-contracts.md` § 3.2, 3.7; ADR-0015 § D2 | Nessuno | Parent primario, merge parent e DAG sono definiti; mancano schema eseguibile, storage e test cicli | M1 | Modello checkpoint/lineage | Alto |
| Session lineage | PARTIAL | `CHECKPOINT.md` righe 95, 103, 108; § Roadmap vincolante | Nessuno | Requisito presente; identità, edge, root e regole merge non specificati | M1.1 | Handoff/session IDs | Alto |
| Stati `partial/failed/candidate/verified` | PARTIAL | `docs/contracts/m0-contracts.md` § 3.4–3.6 | Nessuno | Enum, semantica e transizioni sono congelate; implementazione e conformance test assenti | M1 | Checkpoint state machine | Critico |
| Checkpoint come commit operativo | PARTIAL | ADR-0015 § D2; `docs/contracts/m0-contracts.md` § 3 | Nessuno | Principio, atomicità operativa e distinzione da Git definiti; persistenza/verifica non implementate | M1 | Storage/event model | Critico |
| Distinzione da commit Git | PARTIAL | `CHECKPOINT.md` righe 99–100 distingue ledger/checkpoint/repository; § Repository e branch | Nessuno | La distinzione è implicita, non esiste un contratto che leghi o separi formalmente le due identità | Non assegnata | Git metadata; checkpoint ID | Alto |
| `CandidateCheckpoint` | PARTIAL | `docs/contracts/m0-contracts.md` § 3 e § 5.5 | Nessuno | Output pubblico, campi e invarianti definiti; JSON Schema, fixture e producer assenti | M1 | CheckpointSpec | Alto |
| Checkpoint acceptance esterna | PARTIAL | ADR-0015 § D2/D6; `docs/contracts/m0-contracts.md` § 4 | Nessuno | Separazione e decisioni esterne definite; consumer, firme/policy e integrazione FARO assenti | Futuro esterno | Governance; EvidenceReference | Critico |
| Evidenze e immutabilità | PARTIAL | ADR-0015 § D2; `docs/contracts/m0-contracts.md` § 1.3, § 3, § 5.6 | Nessuno | Digest, sealing ed evidence reference definiti; canonical JSON, firma/resolver e test assenti | M1/futuro Raiatea | Evidence model; storage | Critico |

## 6. Roadmap visuale

| Requisito | Stato | Documentazione | Codice/test | Lacuna esatta | Milestone | Dipendenze | Rischio |
|---|---|---|---|---|---|---|---|
| `/guardian roadmap` | PARTIAL | `CHECKPOINT.md` righe 103–112 | Nessuno | Comando richiesto; collocazione e contratto CLI non ratificati | M1 minimo; M2 completa | Ledger; renderer | Medio |
| `plan/history/combined` | PARTIAL | `CHECKPOINT.md` riga 108 | Nessuno | Viste nominate senza schema/algoritmo/test | M2 | Event history; ledger | Medio |
| `--oneline` | PARTIAL | `CHECKPOINT.md` riga 104 | Nessuno | Flag nominato; formato stabile e limiti non definiti | M1/M2 | Renderer | Basso |
| Tree/DAG | PARTIAL | `CHECKPOINT.md` righe 103–104, 112 | Nessuno | È vietata la falsa gerarchia; layout, ordinamento e cross-reference non implementati | M2 | DAG ledger | Alto |
| Sessioni | PARTIAL | `CHECKPOINT.md` righe 103, 108 | Nessuno | Campi richiesti ma schema lineage/aggregazione assente | M1.1/M2 | Session lineage | Alto |
| Checkpoint | PARTIAL | `CHECKPOINT.md` righe 103, 108–110 | Nessuno | Rendering richiesto, modello checkpoint incompleto | M1/M2 | Checkpoint model | Alto |
| Checkpoint attesi e mancanti | PARTIAL | `CHECKPOINT.md` righe 108–110 | Nessuno | Enum `ExpectedCheckpoint` dettagliata; trigger e valutatore non implementati | M1/M2 | Eventi fase/task/handoff | Alto |
| Review branch/ciclo review | PARTIAL | `CHECKPOINT.md` righe 103, 108, 112 | Nessuno | Ciclo review/finding/fix previsto; branch identity e regole di merge non definite | M2 | Review model; Git lineage | Medio |
| Costo, durata e token | PARTIAL | `CHECKPOINT.md` righe 105, 108 | Nessuno | Campi e separazione fonti richiesti; aggregazione e unknown handling non implementati | M2 | Telemetria/reconciliation | Alto |
| Output JSON | PARTIAL | `CHECKPOINT.md` righe 104–105, 111 | Nessuno | Schema stabile/versionato richiesto ma non esiste | M2 | Data contract; escaping | Alto |
| Offline e senza LLM | PARTIAL | `CHECKPOINT.md` righe 103, 111–112; § Rischi n. 19 | Nessuno | Vincolo forte documentato; nessun test che impedisca rete/provider | M1/M2 | Architettura locale; test isolation | Critico |

## 7. Modelli e reasoning

| Requisito | Stato | Documentazione | Codice/test | Lacuna esatta | Milestone | Dipendenze | Rischio |
|---|---|---|---|---|---|---|---|
| Profili Economy/Balanced/Quality/Critical | PARTIAL | `CHECKPOINT.md` § Profili usati per fase; § pi-auto-router segnala assenza di mapping | Nessuno | Nomi parzialmente usati, ma obiettivi, vincoli e mapping canonico non definiti | M0 decisione; routing M4/M7 | Model catalog; policy | Alto |
| Mapping non OpenAI | PARTIAL | `Guardian_Pi_Agent_Guida_Funzionale.pdf` § UC-11 richiede mapping funzionale con confidenza; `CHECKPOINT.md` § pi-auto-router segnala mapping incompleto | Nessuno | Principio documentato, ma matrice provider/model/reasoning, calibrazione e test non esistono | M5/M7 | Provider registry; benchmark | Alto |
| Modello per fase | PARTIAL | `CHECKPOINT.md` § Profili usati per fase; § Decisione sul reasoning | Nessuno | Esempio operativo presente, ma policy generalizzabile e fallback assenti | M0/M4 | Phase model; routing | Alto |
| Escalation e downgrade | PARTIAL | `CHECKPOINT.md` § Decisione sul reasoning suggerisce high→medium→low | Nessuno | Guida manuale, non condizioni, autorizzazioni, persistenza o test | M4/M7 | Budget; quality policy | Alto |
| Advisory/confirm | PARTIAL | `Guardian_Pi_Agent_Guida_Funzionale.pdf` § UC-11 e § Modalità del router | Nessuno | Modalità e conferma su aumento costo sono documentate; comandi, policy e test non esistono | M4/M7 | Human control; router | Alto |
| Tracciamento decisioni | PARTIAL | `CHECKPOINT.md` § Audit Pi (cambi model/thinking nel JSONL); § pi-auto-router (decision explanation) | Nessuno Eiopago | Fonti disponibili, ma evento canonico, causa, approvazione e correlazione assenti | M4/M7 | Event model; router | Alto |

## 8. Review PR

| Requisito | Stato | Documentazione | Codice/test | Lacuna esatta | Milestone | Dipendenze | Rischio |
|---|---|---|---|---|---|---|---|
| Round completi e incrementali | PARTIAL | `Guardian_Pi_Agent_Guida_Funzionale.pdf` § UC-09 e § Review delle pull request | Nessuno | Primo round completo e successivi incrementali sono definiti; algoritmo, eccezioni e test non esistono | M2 | Review protocol | Alto |
| Due round puliti | PARTIAL | `Guardian_Pi_Agent_Guida_Funzionale.pdf` § UC-09 e § Review delle pull request | Nessuno | Validazione finale e conferma indipendente sono descritte, ma acceptance ed eccezioni non sono implementate | M2 | Review protocol | Alto |
| Massimo quattro round | PARTIAL | `Guardian_Pi_Agent_Guida_Funzionale.pdf` § Review delle pull request | Nessuno | Default quattro e stop senza progresso presenti; configurazione/enforcement/test assenti | M2 | Budget/stop review | Alto |
| SHA | PARTIAL | `Guardian_Pi_Agent_Guida_Funzionale.pdf` § UC-09 e § Review delle pull request | Nessuno | Base/head e invalidazione su cambio head sono richiesti; acquisizione/verifica Git assenti | M2 | Git model | Alto |
| Finding | PARTIAL | `CHECKPOINT.md` righe 103, 108, 112 | Nessuno | Entità prevista nella roadmap; schema, severità, stato ed evidenza assenti | M2 | Review model | Medio |
| Costo per round | PARTIAL | `CHECKPOINT.md` riga 108 richiede usage/costi per round | Nessuno | Nessuna attribuzione o budget per round | M2 | Telemetria; review IDs | Alto |
| Sessione separata | PARTIAL | `Guardian_Pi_Agent_Guida_Funzionale.pdf` § Politica per tipo di task richiede normalmente una sessione per round indipendente | Nessuno | Policy presente; isolamento, parentage, manifest e verifica non implementati | M2 | Session lineage | Medio |
| Stop per mancata convergenza | PARTIAL | `Guardian_Pi_Agent_Guida_Funzionale.pdf` § UC-09 e § Review delle pull request | Nessuno | Stop dopo massimo round o due tentativi senza progresso documentato; state machine ed escalation non implementate | M2 | Review budget; takeover | Critico |

## 9. Integrazioni già previste

| Requisito | Stato | Documentazione | Codice/test | Lacuna esatta | Milestone | Dipendenze | Rischio |
|---|---|---|---|---|---|---|---|
| TokenSave/TraceDecay | PARTIAL | `CHECKPOINT.md` § Versioni terze, § Test terzi, § TokenSave/TraceDecay, § roadmap | Solo test terzi citati; nessun adapter Eiopago | Audit e scelta provvisoria read-only presenti; integrazione reale, privacy config e test end-to-end assenti | M3 | Cost Guard M1; Rust/binario; consent | Alto |
| pi-auto-router | PARTIAL | `CHECKPOINT.md` § Versioni terze, § Test terzi, § pi-auto-router, § roadmap | Test terzi: 429 pass/3 fail; nessun adapter Eiopago | Autorità proposta ma non ratificata; API stabile assente e fallback budget incompatibile | M4 | Cost Guard; adapter/event log | Critico |
| Provider reconciliation | PARTIAL | `CHECKPOINT.md` § Priorità economiche e roadmap M5; righe 105, 400–401 | Nessuno | Principio raw/normalized/reconciled presente; schema, import e matching assenti | M5 | Accounting; provider adapters | Critico |
| OpenRouter | PARTIAL | `Guardian_Pi_Agent_Guida_Funzionale.pdf` § Roadmap M5 nomina OpenRouter/Moonshot | Nessuno | È solo assegnato alla milestone: adapter, auth, pricing, usage e policy non sono specificati né implementati | M5 | Provider architecture | Alto |
| Billing import | PARTIAL | `Guardian_Pi_Agent_Guida_Funzionale.pdf` § UC-14 include `billing_export`; § Roadmap M5 | Nessuno | Fonte concettuale presente; formati, deduplica, valuta, provenance e import non esistono | M5 | Provider adapters; accounting | Critico |
| API key alias | PARTIAL | `Guardian_Pi_Agent_Guida_Funzionale.pdf` § UC-03, UC-13 e § Sicurezza | Nessuno | Alias e secret store sono requisiti; identità, risoluzione, rotazione e test sicurezza non esistono | M1/M5 | Credential boundary | Critico |
| Abbonamento contro API | PARTIAL | `CHECKPOINT.md` § Profilo corrente; § pi-auto-router (`subscription-first`); righe 105, 325 | Nessuno Eiopago | È richiesta separazione delle fonti, ma classificazione costi/quota e riconciliazione non definite | M5 | Billing import; provider model | Critico |

## 10. Contratti futuri

| Requisito | Stato | Documentazione | Codice/test | Lacuna esatta | Milestone | Dipendenze | Rischio |
|---|---|---|---|---|---|---|---|
| `CheckpointSpec` | PARTIAL | `docs/contracts/m0-contracts.md` § 5.2 | Nessuno | Campi e semantica minimi definiti; schema/fixture e producer esterno assenti | M1 subset standalone; futuro FARO | Checkpoint model | Alto |
| `RunContext` | PARTIAL | `docs/contracts/m0-contracts.md` § 5.3 | Nessuno | Contratto minimo provider-neutral definito; integrazione Durex/Runner rinviata | M1.2/futuro Durex | Runtime boundary | Alto |
| `RunEvent` | PARTIAL | `docs/contracts/m0-contracts.md` § 5.4 | Nessuno | Categorie e ownership definite; schema e transport non implementati | M1 subset; futuro Durex | Event envelope | Alto |
| `CandidateCheckpoint` | PARTIAL | `docs/contracts/m0-contracts.md` § 3 e § 5.5 | Nessuno | Contratto minimo definito; producer, schema e conformance assenti | M1 | CheckpointSpec | Alto |
| `CheckpointDecision` | PARTIAL | `docs/contracts/m0-contracts.md` § 4 | Nessuno | Decisioni e separazione acceptance definite; producer FARO/umano non implementato | Futuro FARO Governance | Acceptance/governance | Alto |
| `EvidenceReference` | PARTIAL | `docs/contracts/m0-contracts.md` § 5.6 | Nessuno | Campi, sensitivity e verification status definiti; resolver/conformance assenti | M1 locale; futuro Raiatea | Storage/security | Critico |
| Event envelope | PARTIAL | `docs/contracts/m0-contracts.md` § 5.1 | Nessuno | Envelope e regole minime definiti; JSON Schema, ordering producer e fixture assenti | M1 subset | RunEvent; migrations | Critico |
| Correlation e causation ID | PARTIAL | `docs/contracts/m0-contracts.md` § 1.2 e § 5.1 | Nessuno | Semantica root/causa definita; propagazione runtime e test assenti | M1 subset | Event envelope; lineage | Alto |
| Modalità standalone | PARTIAL | ADR-0015 § D6; `docs/contracts/m0-contracts.md` § 5.3 e § 7 | Nessuno | Confini e nullability esterna definiti; vertical slice standalone non implementato | M1 | Runtime architecture | Medio |
| Adapter futuro per Durex e FARO | PARTIAL | ADR-0015 § D6; `docs/contracts/m0-contracts.md` § 5 e § 7 | Nessuno | Confini e contratti minimi definiti; adapter e conformance cross-repository esplicitamente rinviati | M1.2/futuro ecosistema | Boundary/ownership ADR | Alto |

## Sintesi richiesta

### 1. Funzionalità COMPLETE

Nessuna. Nel repository non esistono codice o test Eiopago e non è stato considerato `COMPLETE` alcun elemento presente soltanto come requisito, audit terzo o roadmap.

### 2. Funzionalità PARTIAL

- Telemetria e accounting di base, SQLite, warning/soglie, block-next-call, checkpoint-and-stop, export e TUI minima.
- Tutte e quattro le modalità handoff, sessione pulita/parent, prompt di ripresa, Quality Gate, Continuity Verification, Resume Context Manifest, limiti e crash recovery.
- Tutti i controlli Human Takeover elencati, inclusi precedenza, latch e race durante commit.
- Tutti gli elementi richiesti del Master Task Ledger, ma il ledger canonico non esiste.
- `checkpoint_message`, lineage e distinzione implicita da Git.
- Tutte le viste roadmap elencate, incluso offline/nessuna LLM, ma senza implementazione o schema.
- Profili, mapping non OpenAI, modello per fase, escalation/downgrade, advisory/confirm e tracking decisioni.
- Protocollo PR review, finding e costo per round, tutti ancora senza implementazione.
- TokenSave/TraceDecay, pi-auto-router, provider reconciliation, OpenRouter, billing import, API key alias e separazione abbonamento/API.

### 3. Funzionalità MISSING

Dopo M0.1 nessuno dei 92 requisiti elencati resta privo di copertura documentale minima. I 16 elementi precedentemente `MISSING` sono ora `PARTIAL`, non `COMPLETE`: mancano ancora codice, schema eseguibile, fixture e test.

### 4. Cinque lacune più urgenti

1. **Vero block-next-LLM-call non verificato:** senza un gate provato non esiste hard budget affidabile.
2. **Human latch e handoff transazionale senza persistence/test:** race e crash possono perdere il takeover o generare una chiamata/prompt non autorizzati.
3. **Nessun Master Task Ledger canonico:** checkpoint, roadmap, handoff e continuity non hanno la fonte globale richiesta.
4. **Checkpoint/manifest/evidence model non implementato:** il contratto M0.1 esiste, ma schema eseguibile, resolver e test di immutabilità/continuità mancano.
5. **Accounting canonico assente:** schema SQLite, precisione, attribuzione e separazione subscription/API/provider non sono implementati.

### 5. Più piccolo addendum necessario

L'addendum minimo proposto dall'audit è stato prodotto in M0.1 senza riscrivere i documenti esistenti:

1. `docs/adr/0015-m0-boundaries-and-contract-freeze.md` congela source of truth, lifecycle, API Pi e confini;
2. `docs/contracts/m0-contracts.md` definisce ID, checkpoint, envelope ed evidence minimi;
3. `docs/roadmap.md` collega le decisioni ai gate M1/M1.1/M1.2.

Non è necessario un ulteriore addendum M0.1. Restano necessari schema eseguibile, fixture e test in M1.

### 6. Elementi che appartengono a Eiopago

In base alle sole fonti disponibili: Cost Guard e accounting locale; budget/warning/stop; Master Task Ledger; checkpoint/handoff/continuity necessari al controllo costi; Human Takeover; roadmap locale deterministica; policy modello/routing e adapter provider; riconciliazione; integrazioni TokenSave e pi-auto-router sotto autorità Guardian.

### 7. Elementi attribuibili a FARO Governance, Durex o Raiatea

M0.1 ratifica come ipotesi architetturale i confini di ADR-0015:

- **Durex:** queue e run durevoli, worker, claim/lease/fencing, heartbeat, retry/resume, cancellazione, process ownership e output persistente;
- **FARO Governance:** backlog/policy/metodologia globali, priorità/assegnazione, acceptance, GitHub synchronization e project babysitting;
- **Raiatea:** evidence bundle, provenance e risoluzione/verifica delle evidenze;
- **Alfred:** osservazione di eventi e segnali.

Gli adapter e i sistemi esterni non sono implementati in Eiopago; `CheckpointDecision` resta acceptance esterna.

### 8. Rischi di duplicazione o monolite

- Se l'implementazione viola ADR-0015, Ledger Markdown, SQLite, checkpoint e Git possono tornare a essere fonti concorrenti.
- Extension e Runner possono duplicare latch, telemetria, piano e state machine.
- Eiopago può assorbire governance/acceptance esterna invece di esporre contratti minimi.
- Roadmap, review engine, provider billing, router e context optimizer nello stesso core aumentano coupling e autorità sulle credenziali.
- Duplicare parser/metriche di pi-token-usage, pi-auto-router e TokenSave rende divergenti costo e saving.
- L'envelope è definito ma non implementato: senza propagazione reale di correlation/causation IDs, deduplica e audit restano inaffidabili.

## Conclusione

Dopo M0.1 la copertura dei 92 requisiti è **PARTIAL documentale**: zero `COMPLETE`, 92 `PARTIAL`, zero `MISSING`. ADR, contratti e roadmap chiudono le lacune di definizione richieste dal freeze, ma non esistono implementazione o verifica applicativa Eiopago. Checkpoint Model, contratti, Review PR e provider restano non implementati. Non sono emersi requisiti `COMPLETE`, né conflitti vigenti sufficientemente definiti da classificare `CONFLICTING`; sono invece presenti decisioni provvisorie e roadmap sostituite esplicitamente dalla versione più recente.
