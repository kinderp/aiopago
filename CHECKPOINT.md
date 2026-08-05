# CHECKPOINT — M0.1 Contract and Boundary Freeze completata

## Ultima sessione — M0.1 Contract and Boundary Freeze (corrente)

- Data: 2026-08-05; sessione Pi `019fd3de-0d1b-7cb8-bfd2-9b50b354432c`.
- Profilo verificato prima delle decisioni: `openai-codex/gpt-5.6-sol`, reasoning `high`.
- Esito: **M0.1 completata esclusivamente a livello documentale; STOP DI SESSIONE**. M1 non iniziata, nessun codice applicativo creato, nessuna dipendenza installata e nessun commit eseguito.
- Decisioni `DECIDED`: ownership ibrida distinta per categoria (Ledger Markdown; checkpoint JSON immutabile; telemetria/handoff/latch SQLite; Git tecnico; provider billing per addebito; evidenze presso artefatto owner); checkpoint come commit operativo distinto da Git; lifecycle e parent/DAG; acceptance esterna separata; handoff saga fail-closed e human latch prioritario; confini Eiopago/Durex/FARO Governance/Raiatea/Alfred; modalità standalone.
- Decisioni `PROVISIONAL`: path `TASK_PLAN.md` e `.guardian/checkpoints/`; fallback Extension-first per block-next-call; Raiatea resolver futuro. Qualsiasi cambio di autorità richiede nuovo ADR e migrazione one-way.
- API Pi 0.83.0 classificate in ADR-0015: `CONFIRMED` usage, statistiche, abort surface, input/steering, comandi, conferme, nuova sessione, parent, naming, model e reasoning; `NEEDS_SPIKE` block-next-call, safe point, prompt exactly-once, shutdown/suspend; `REQUIRES_RUNNER` per recovery automatica dopo process crash. Un block hook Extension immediatamente pre-request è `UNSUPPORTED`; Runner resta condizionale a SP-01/SP-04.
- Spike offline M0.1 in `%TEMP%`, senza provider/rete e senza modificare `~/.pi`: RPC (`get_state`, stats, naming, `new_session`, abort idle) riuscito; SessionManager ha verificato header parent v3 e sessione child senza history parent. Rilevata materializzazione differita del JSONL fino alla prima risposta assistant, da coprire nel journal.
- Spike M1 richiesti: SP-01 block race; SP-02 active-stream abort; SP-03 safe point; SP-04 prompt exactly-once; SP-05 shutdown/suspend; SP-06 reload/crash; SP-07 hotkey Windows; SP-08 failure dopo teardown `newSession`; SP-09 takeover durante commit; SP-10 import/conflitti Ledger-checkpoint.
- Contratti minimi definiti: ID e Ledger schema; checkpoint fields/lifecycle/immutabilità; `EventEnvelope`, `CheckpointSpec`, `RunContext`, `RunEvent`, `CandidateCheckpoint`, `CheckpointDecision`, `EvidenceReference`; latch e handoff transaction. JSON Schema, fixture e conformance restano M1/futuro e nessun contratto è implementato.
- Documenti creati: `docs/adr/0015-m0-boundaries-and-contract-freeze.md`, `docs/contracts/m0-contracts.md`, `docs/roadmap.md`.
- Documenti aggiornati in modo mirato: `docs/audit/guardian-requirements-coverage.md` (zero COMPLETE, 92 PARTIAL, zero MISSING), `PIANO_MAESTRO_FARO_DUREX_EIOPAGO.md` e questo checkpoint. PDF funzionali non modificati.
- Git verificato: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, remote `origin` `https://github.com/kinderp/eiopago.git`, zero commit. Non tracciati: checkpoint, due PDF, Piano Maestro e `docs/`; nessun file applicativo.
- Rischi aperti: nessun gate Extension pre-request; teardown del vecchio runtime prima della garanzia del nuovo; prompt replacement avvia una call; crash unattended richiede process owner; source-of-truth sicura solo se projection non scrivono indietro; `VERIFIED` non deve essere mostrato come `ACCEPTED`.
- Modello consigliato per l'avvio M1: `openai-codex/gpt-5.6-sol`, reasoning `high` per SP-01/SP-02/SP-03/SP-04 e race di sicurezza; passare a `medium` solo dopo il gate per scaffold/implementazione meccanica e test ordinari.
- Prossimo passo globale: soltanto dopo autorizzazione esplicita a iniziare M1, eseguire prima SP-01 con fake stream/no rete e decidere Extension fallback vs Runner; non integrare provider, TokenSave, pi-auto-router, Durex o FARO.
- `checkpoint_message`: “M0.1 congelata: contratti, ownership, lifecycle e API Pi classificati”.

**Nome sessione suggerito:** `eiopago-m1-block-next-call-spike`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md`, `CHECKPOINT.md`, ADR-0015, `docs/contracts/m0-contracts.md` e `docs/roadmap.md`; usa coverage/Piano Maestro solo per riscontri e non ripetere audit o M0.1. Verifica Git e profilo `openai-codex/gpt-5.6-sol`, reasoning `high`. Inizia M1 solo se esplicitamente autorizzato: esegui prima SP-01 con fake stream e zero rete per provare block-next-call; se fallisce classifica `REQUIRES_RUNNER` senza hack terminali. Non integrare provider, TokenSave, pi-auto-router, Durex o FARO e non modificare `~/.pi`.

## Sessione precedente — audit copertura requisiti

- Data: 2026-08-05; sessione Pi `019fd3de-0d1b-7cb8-bfd2-9b50b354432c`.
- Esito: **audit di copertura completato; STOP DI SESSIONE**. Creato `docs/audit/guardian-requirements-coverage.md`; nessuna funzionalità implementata, M0 non ampliata, M1 non iniziata e nessuna decisione critica ratificata.
- Fonti lette in modo mirato: regole canoniche, checkpoint e indice/sezioni pertinenti di `Guardian_Pi_Agent_Guida_Funzionale.pdf` v0.1. Il PDF è comparso come file non tracciato durante la sessione ed è stato incluso perché materialmente pertinente all'audit. Nessun altro documento o repository terzo è stato riletto.
- Risultato sintetico: zero funzionalità `COMPLETE`; copertura prevalentemente `PARTIAL` documentale; lacune maggiori in block-next-call verificabile, latch/handoff transazionale, ledger canonico, checkpoint/evidence model e accounting canonico. Contratti futuri nominati dal mandato non risultano documentati nelle fonti.
- Verifiche: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, remote `origin` `https://github.com/kinderp/eiopago.git`, zero commit. Stato finale non tracciato: `CHECKPOINT.md`, `Guardian_Pi_Agent_Guida_Funzionale.pdf` e `docs/`.
- Profilo della sessione: `openai-codex/gpt-5.6-sol`, reasoning `medium`, usato esclusivamente per audit di copertura; il gate `high` resta obbligatorio prima di ratificare decisioni M0 o verificare le API critiche.
- Modifiche: soltanto il nuovo report di audit e questo checkpoint; `~/.pi` non modificato. Nessun test eseguito perché non esiste codice Eiopago e il mandato vietava implementazioni.
- Prossimo passo: in una nuova sessione `high`, leggere il report senza ripetere l'audit e riprendere il gate M0 già previsto; non iniziare M1 prima delle decisioni/verifiche richieste.
- `checkpoint_message`: “Audit copertura completato: zero COMPLETE, gap critici M0/M1 identificati”.

**Nome sessione suggerito:** `eiopago-m0-gap-ratifica-high`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md`, `CHECKPOINT.md` e `docs/audit/guardian-requirements-coverage.md`; usa `Guardian_Pi_Agent_Guida_Funzionale.pdf` solo per riscontri puntuali e non ripetere l’audit. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`; se non conforme aggiorna solo il checkpoint e fermati. Riprendi esclusivamente il gate M0 già previsto, partendo dai cinque gap urgenti e senza segnare COMPLETE ciò che è solo in roadmap. Non iniziare M1 né modificare `~/.pi`.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd3de-0d1b-7cb8-bfd2-9b50b354432c`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; Master Task Ledger non creato, API Pi non verificate, decisioni M0 non ratificate e M1 non avviata.
- Profilo esatto rilevato dalle variabili `PI_*`: `openai-codex/gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning richiesto è `high`, quindi il profilo obbligatorio non è soddisfatto.
- Git verificato: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, remote `origin` `https://github.com/kinderp/eiopago.git`, zero commit; soltanto `CHECKPOINT.md` e `docs/` sono non tracciati, coerentemente con lo stato dichiarato.
- In conformità al gate non sono stati ripetuti audit/test, non sono state svolte verifiche API mirate e `~/.pi` non è stato modificato. Modificato soltanto `CHECKPOINT.md`.
- Prossimo gate: avviare una nuova sessione con profilo effettivo `openai-codex/gpt-5.6-sol`, reasoning esattamente `high`; verificare Git e le variabili `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` prima di creare il ledger o assumere decisioni M0.
- `checkpoint_message`: “Profilo Sol corretto, reasoning ancora medium; M0 rinviata senza decisioni”.

**Nome sessione suggerito:** `eiopago-m0-api-ratifica-high`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md` e `CHECKPOINT.md`; non ripetere audit/test. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`, altrimenti aggiorna solo il checkpoint e fermati. Completa solo M0: crea il Master Task Ledger; verifica le API Pi mirate e ratifica confirm handoff, takeover, latch, Extension vs Runner, state machine e roadmap M1/M1.1/M1.2. Non iniziare M1 né modificare `~/.pi`. Chiudi aggiornando ledger/checkpoint, prompt minimo e nome sessione.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd3c2-76f7-783a-9b94-20bd2c5c83b4`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; Master Task Ledger non creato, API Pi non verificate, decisioni M0 non ratificate e M1 non avviata.
- Profilo esatto rilevato dalle variabili `PI_*`: `openai-codex/gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning richiesto è `high`, quindi il profilo obbligatorio non è soddisfatto.
- Git verificato: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, remote `origin` `https://github.com/kinderp/eiopago.git`, zero commit; soltanto `CHECKPOINT.md` e `docs/` sono non tracciati, coerentemente con lo stato dichiarato.
- In conformità al gate non sono stati ripetuti audit/test, non sono state svolte verifiche API mirate e `~/.pi` non è stato modificato. Modificato soltanto `CHECKPOINT.md`.
- Prossimo gate: avviare una nuova sessione con profilo effettivo `openai-codex/gpt-5.6-sol`, reasoning esattamente `high`; verificare Git e le variabili `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` prima di creare il ledger o assumere decisioni M0.
- `checkpoint_message`: “Profilo Sol corretto, reasoning ancora medium; M0 rinviata senza decisioni”.

**Nome sessione suggerito:** `eiopago-m0-api-ratifica-high`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md` e `CHECKPOINT.md`; non ripetere audit/test. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`, altrimenti aggiorna solo il checkpoint e fermati. Completa solo M0: crea il Master Task Ledger; verifica le API Pi mirate e ratifica confirm handoff, takeover, latch, Extension vs Runner, state machine e roadmap M1/M1.1/M1.2. Non iniziare M1 né modificare `~/.pi`. Chiudi aggiornando ledger/checkpoint, prompt minimo e nome sessione.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd3b8-ecd8-72be-a936-898825b9de6b`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; Master Task Ledger non creato, API Pi non verificate, decisioni M0 non ratificate e M1 non avviata.
- Profilo esatto rilevato dalle variabili `PI_*`: `openai-codex/gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning richiesto è `high`, quindi il profilo obbligatorio non è soddisfatto.
- Git verificato: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, remote `origin` `https://github.com/kinderp/eiopago.git`, zero commit; soltanto `CHECKPOINT.md` e `docs/` sono non tracciati, coerentemente con lo stato dichiarato.
- In conformità al gate non sono stati ripetuti audit/test, non sono state svolte verifiche API mirate e `~/.pi` non è stato modificato. Modificato soltanto `CHECKPOINT.md`.
- Prossimo gate: avviare una nuova sessione con profilo effettivo `openai-codex/gpt-5.6-sol`, reasoning esattamente `high`; verificare Git e le tre variabili `PI_*` prima di creare il ledger o assumere decisioni M0.
- `checkpoint_message`: “Profilo Sol corretto, reasoning ancora medium; M0 rinviata senza decisioni”.

**Nome sessione suggerito:** `eiopago-m0-api-ratifica-high`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md` e `CHECKPOINT.md`; non ripetere audit/test. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`, altrimenti aggiorna solo il checkpoint e fermati. Completa solo M0: crea il Master Task Ledger; verifica le API Pi mirate e ratifica confirm handoff, takeover, latch, Extension vs Runner, state machine e roadmap M1/M1.1/M1.2. Non iniziare M1 né modificare `~/.pi`. Chiudi aggiornando ledger/checkpoint, prompt minimo e nome sessione.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd3b2-61c0-7724-84c9-fdfc49645e27`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; Master Task Ledger non creato, API Pi non verificate, decisioni M0 non ratificate e M1 non avviata.
- Profilo esatto rilevato dalle variabili `PI_*`: `openai-codex/gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning richiesto è `high`, quindi il profilo obbligatorio non è soddisfatto.
- Git verificato: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, remote `origin` `https://github.com/kinderp/eiopago.git`, zero commit; soltanto `CHECKPOINT.md` e `docs/` sono non tracciati, coerentemente con lo stato dichiarato.
- In conformità al gate non sono stati ripetuti audit/test, non sono state svolte verifiche API mirate e `~/.pi` non è stato modificato. Modificato soltanto `CHECKPOINT.md`.
- Prossimo gate: avviare una nuova sessione con profilo effettivo `openai-codex/gpt-5.6-sol`, reasoning esattamente `high`; verificare Git e le tre variabili `PI_*` prima di creare il ledger o assumere decisioni M0.
- `checkpoint_message`: “Reasoning ancora medium; M0 e verifica API rinviate senza modifiche”.

**Nome sessione suggerito:** `eiopago-m0-api-ratifica-high`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md` e `CHECKPOINT.md`; non ripetere audit/test. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`, altrimenti aggiorna solo il checkpoint e fermati. Completa solo M0: crea il Master Task Ledger; verifica le API Pi mirate e ratifica confirm handoff, takeover, latch, Extension vs Runner, state machine e roadmap M1/M1.1/M1.2. Non iniziare M1 né modificare `~/.pi`. Chiudi aggiornando ledger/checkpoint, prompt minimo e nome sessione.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd327-16e7-7e9f-a249-758ed2723c33`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; Master Task Ledger non creato, nessuna decisione M0 ratificata e M1 non avviata.
- Profilo rilevato da `PI_PROVIDER`, `PI_MODEL` e `PI_REASONING_LEVEL`: `openai-codex/gpt-5.6-sol`, reasoning effettivo `medium`. Provider e modello sono corretti, ma il reasoning non è esattamente `high`; il profilo obbligatorio non è soddisfatto.
- Git verificato: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, remote `origin` coerente, nessun commit; `CHECKPOINT.md` e `docs/` restano non tracciati e coerenti con lo stato dichiarato.
- Non sono stati ripetuti audit o test e `~/.pi` non è stato modificato. Una ricerca mirata iniziale nelle API/documentazione installate ha rilevato l'esempio `examples/extensions/handoff.ts`, ma è stata interrotta al riscontro del profilo non conforme: nessuna semantica API, fattibilità, state machine, latch o scelta Extension/Runner è stata ratificata.
- Modifiche: aggiornato soltanto `CHECKPOINT.md` per registrare il gate e il passaggio di sessione. Roadmap e requisiti restano quelli già acquisiti sotto.
- Prossimo gate: nuova sessione con profilo effettivo `openai-codex/gpt-5.6-sol`, reasoning `high`; verificare le tre variabili `PI_*` prima di creare il ledger o riprendere la verifica API mirata.
- `checkpoint_message`: “Profilo Sol confermato ma reasoning medium; M0 critica rinviata senza decisioni”.

**Nome sessione suggerito:** `eiopago-m0-handoff-takeover-api-high`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md` e `CHECKPOINT.md`; non ripetere audit/test. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`, altrimenti aggiorna solo il checkpoint e fermati. Completa solo M0: crea il Master Task Ledger; verifica le API Pi mirate e ratifica confirm handoff, takeover, latch, Extension vs Runner, state machine e roadmap M1/M1.1/M1.2. Non iniziare M1 né modificare `~/.pi`. Chiudi aggiornando ledger/checkpoint, prompt minimo e nome sessione.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd303-d3c1-703b-95b2-7a6b423833e7`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; nessuna decisione critica o attività M1 avviata.
- Profilo rilevato: provider `openai-codex`, modello `gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning non è esattamente `high`, quindi il profilo obbligatorio richiesto non è soddisfatto.
- Repository verificato: `E:/dev/eiopago`; branch `feat/pi-usage-guardian-foundation`; worktree principale; remote `origin` coerente; nessun commit; `CHECKPOINT.md` e `docs/` non tracciati, coerenti con i file dichiarati nel checkpoint.
- Non sono stati ripetuti audit, inventari o test già completati; `~/.pi` non è stato modificato.
- Statistiche rilevate durante il gate: 10 entry JSONL; 2 record usage; input 9.715; output 714; reasoning 150; cache read 0; cache write 0; costo riportato USD 0,069995; contesto stimato 8.509 / 272.000 = 3,13%. Nessuna soglia quantitativa raggiunta; stop esclusivamente qualitativo.
- Nuovo requisito prioritario ricevuto e registrato senza progettarlo in profilo non conforme: **Automatic Session Handoff** deve appartenere al Cost Guard MVP/M1, non a dashboard od orchestratore futuro. Deve creare una sessione pulita nello stesso processo (non clone/fork), preservare il parent, trasferire solo checkpoint/stato minimo, bloccare ulteriori chiamate nella vecchia sessione e supportare `manual`/`confirm`/`auto` (default `confirm`). Il mandato prescrive state machine, validazioni, configurazione iniziale e dieci criteri E2E; questi elementi devono essere incorporati in roadmap, requisiti, casi d'uso, architettura, ADR e criteri M1 durante la fase critica `high`.
- Modifiche: aggiornato soltanto questo checkpoint per acquisire requisito, stato reale, statistiche e handoff. Nessun documento architetturale creato perché ciò violerebbe il gate `high`; M1 non iniziata.
- Prossimo gate: nuova sessione con `openai-codex/gpt-5.6-sol`, reasoning effettivo `high`; includere Automatic Session Handoff nella fase critica delimitata e verificare le API Pi mirate necessarie senza rileggere l'intero audit.
- Integrazione strategica successiva ricevuta nella stessa sessione: la continuità dei task lunghi deve seguire il principio «cronologia corta, memoria persistente affidabile, contesto recuperato su richiesta e passaggi verificati». Il mandato amplia l'handoff con punti stabili, pacchetto persistente/versionato, aggiornamento progressivo deterministico, costo control-plane separato, Quality Gate, Continuity Check, Resume Context Manifest, lineage task/sessione, crash recovery, redazione segreti, policy per tipo di task, limiti anti-loop, estensione atomica controllata e misure di qualità/A-B. Non presume che più contesto o ogni nuova sessione migliorino automaticamente la qualità.
- Roadmap richiesta dall'ultima integrazione: M0 fondazione/decisioni; M1 Cost Guard MVP; M1.1 Automatic Session Handoff; poi M2–M11. In fase critica `high` va deciso se includere l'handoff direttamente in M1 quando l'API Pi lo consente senza ritardare eccessivamente il primo guard, altrimenti completarlo nell'estensione immediata M1.1; non può essere rinviato alla dashboard.
- Output architetturali richiesti ma **non redatti in questa sessione medium**: visione, requisiti, casi d'uso, architettura, modello dati, budget/stop, routing, roadmap, sicurezza, benchmark, domande aperte, documento dedicato e ADR non duplicati. Il gate qualitativo resta vincolante; nessuna supposizione sulle API Pi è stata ratificata.
- Statistiche dopo l'acquisizione dell'integrazione: 22 entry JSONL; 6 record usage; input 24.790; output 3.829; reasoning 742; cache read 44.032; cache write 0; costo USD 0,260836; contesto stimato 21.254 / 272.000 = 7,81%. Nessuna soglia quantitativa raggiunta; permane lo stop per reasoning `medium`.
- Ulteriore requisito ricevuto nella stessa sessione: **Persistent Master Task Ledger** canonico e versionato per l'intero task, distinto da Session Checkpoint, documentazione/ADR e repository/test. Deve mantenere requisiti versionati, DAG/lista di attività con ID e stati stabili, dipendenze, evidenze verificabili, budget/costo, lineage e prossimo passo globale; nessuna attività può diventare `DONE` senza evidenza. I cambi requisito devono restare tracciati tramite `SUPERSEDED`/`DROPPED`, senza cancellazioni silenziose.
- Il ledger deve essere aggiornato progressivamente e verificato prima dell'handoff e durante la continuity verification; il checkpoint deve restare un delta di sessione con riferimenti al ledger. Per l'MVP deve esistere una sola fonte canonica leggibile in Markdown; l'eventuale SQLite generatore della vista è futuro e non deve creare doppie fonti divergenti.
- Convenzione file e schema non ratificati: il repository non possiede ancora una convenzione oltre a checkpoint/regole; la fase `high` deve scegliere motivatamente tra `TASK_PLAN.md` e `.guardian/tasks/<task-id>/...`, creare il ledger iniziale senza ricostruzioni indipendenti e aggiungere le entità/equivalenti richieste al modello dati.
- Statistiche dopo questa integrazione: 35 entry JSONL; 11 record usage; input 34.819; output 6.965; reasoning 1.159; cache read 158.208; cache write 0; costo USD 0,462149; contesto stimato 28.927 / 272.000 = 10,63%. Nessuna soglia quantitativa raggiunta; STOP invariato perché reasoning effettivo `medium`.
- Requisito successivo ricevuto nella stessa sessione: **Visual Task Roadmap e Checkpoint History**, comando primario `/guardian roadmap` interamente locale, senza chiamate LLM/provider, con possibile CLI coerente. Deve proiettare Master Task Ledger, DAG/piano, session lineage, handoff, checkpoint effettivi/previsti/mancanti, requirement changes, review/finding/fix, test, uso e costi.
- Varianti richieste: default, `--oneline`, `--details`, filtri active/completed/planned/missing/checkpoints/sessions/reviews, `--usage`, `--cost`, `--json`; Unicode con fallback ASCII, colori opzionali e semantica non dipendente dal colore. Il DAG non deve essere falsificato come gerarchia: percorso principale, rami e riferimenti trasversali espliciti.
- `--missing` diventa una vista di controllo coerenza su checkpoint/evidenze/requisiti/handoff/continuity; `--json` richiede schema stabile e versionato. Usage e costi devono mantenere separate fonti misurate, stimate, abbonamento, API, provider riconciliato e control plane.
- Collocazione, contratto dati e nomenclatura CLI non ratificati in profilo `medium`: integrarli in specifiche, architettura, modello dati, casi d'uso, roadmap e criteri durante M0 `high`, senza iniziare la milestone d'implementazione.
- Statistiche dopo l'acquisizione: 44 entry JSONL; 15 record usage; input 43.516; output 9.650; reasoning 1.301; cache read 280.064; cache write 0; costo USD 0,647112; contesto stimato 35.842 / 272.000 = 13,18%. Nessuna soglia quantitativa raggiunta; STOP qualitativo invariato.
- Completamento del requisito Visual Task Roadmap ricevuto nella stessa sessione: la vista deve modellare cicli implementazione→review→finding→fix→review→approvazione, plan/history/combined, `ExpectedCheckpoint`, requirement-change events, summary aggregate e filtri non mutanti. Ogni round/sessione/checkpoint conserva identità, lineage, Git, profilo, durata, usage/costi distinti, test/finding/handoff/continuity/evidenze; i campi assenti sono `unknown`, mai zero inventato.
- Nuovo campo richiesto `checkpoint_message`: una riga descrittiva, idealmente 72–100 caratteri, generata durante la normale chiusura senza chiamata LLM dedicata. Dettagli esclusi dalla larghezza restano accessibili con `/guardian roadmap --details <id>` o comando show da ratificare.
- `ExpectedCheckpoint` deve distinguere `PLANNED`, `NOT_YET_DUE`, `DUE`, `SATISFIED`, `MISSING`, `WAIVED`, `SUPERSEDED`; è `MISSING` solo dopo trigger/fase/task/handoff pertinente, mai prima che sia dovuto. La vista essenziale statica è proposta per M1, lineage/handoff per M1.1, review/finding/fix e filtri avanzati per M2, TUI interattiva per M9; non rinviarla alla dashboard.
- Requisiti non funzionali acquisiti: offline, deterministica, incrementale/indicizzata, nessuna rete/LLM/provider, dati parziali sicuri, terminale stretto, Unicode/ASCII/no-color, escape/CSV injection safety, output JSON versionato e tempo obiettivo locale da documentare/misurare. La source-of-truth strategy Markdown/SQLite/Git/provider deve essere decisa senza correzioni silenziose.
- Test richiesti registrati senza esecuzione: casi lineari/DAG/branch-merge, sessioni/handoff/review/fix, stati checkpoint, evidenze e requirement superseded, dati incompleti/costi non riconciliati, rendering/filtri/ordinamenti/JSON/idempotenza, assenza rete/LLM e injection. Golden/snapshot solo se leggibili e non fragili.
- `checkpoint_message` corrente: “Acquisiti ledger e roadmap visuale; fase critica ancora bloccata dal profilo”.
- Statistiche dopo il completamento del requisito: 52 entry JSONL; 19 record usage; input 52.360; output 12.145; reasoning 1.404; cache read 426.496; cache write 0; costo USD 0,839398; contesto stimato 42.272 / 272.000 = 15,54%. Nessuna soglia quantitativa raggiunta; STOP qualitativo invariato (`medium` anziché `high`).
- Nuova priorità P0 ricevuta: **Session Handoff Orchestrator con Human Takeover** precede roadmap avanzata, TokenSave, auto-router, forecasting, benchmark, provider avanzati e dashboard. La modalità iniziale è `confirm`; sono richieste esattamente `manual`, `confirm`, `supervised-auto`, `auto`, con `auto` disabilitata per default e possibile Guardian Runner solo se l'Extension API non supporta automazione robusta.
- Precedenza vincolante acquisita: HUMAN TAKEOVER → emergency stop/sicurezza → hard budget → checkpoint/integrità repository → handoff → piano agente → ottimizzazione. Un persistent human-control latch blocca nuove LLM/tool agentici, handoff, cambi profilo/budget e mutazioni piano; sopravvive a session switch, reload, crash e restart, ed è rilasciabile solo dall'utente.
- Comandi richiesti registrati: pause/takeover/resume; handoff prepare/confirm/cancel/status; plan show/edit/add/remove/reprioritize/approve; mode manual/confirm/supervised-auto/auto. Hotkey configurabile senza sovrascrivere Escape e steering directives deterministiche devono convergere sullo stesso latch.
- State machine candidata imposta dal mandato: `RUNNING → THRESHOLD_DETECTED → SAFE_POINT_REQUESTED → CHECKPOINT_PREPARING → HANDOFF_PREPARED → HANDOFF_ARMED → HANDOFF_COMMIT → NEW_SESSION_PAUSED → CONTINUITY_CHECK → RESUME_READY → RESUMED`. Durante COMMIT si esegue solo lo switch tecnico minimo; un takeover concorrente viene persistito e porta la nuova sessione a `NEW_SESSION_PAUSED`, senza rollback parziale né prompt automatico.
- Nuovo ordine roadmap sostituisce quello precedente: M0 API/session-control architecture; M1 Cost Guard + confirm handoff + takeover; M1.1 supervised-auto + crash recovery; M1.2 Runner per auto solo se necessario; M2 attribuzione/review budget/roadmap completa; M3–M11 come riportato sotto. La roadmap visuale minima può restare M1 ma non ritarda handoff/takeover/block/new-session/resume prompt.
- Verifiche API richieste ma non eseguite in `medium`: session creation/parent/name/prompt, pre-next-call block, safe abort, command/input/steering/hotkey/TUI, persistence/reload e confini Extension vs AgentSession/RPC. Non dichiarare implementabile alcuna modalità finché non provata con test mirati.
- `checkpoint_message` corrente: “Promosso handoff con takeover a P0; verifica API bloccata dal profilo”.
- Statistiche dopo l'acquisizione: 62 entry JSONL; 24 record usage; input 63.310; output 15.183; reasoning 1.772; cache read 644.096; cache write 0; costo USD 1,094088; contesto stimato 50.157 / 272.000 = 18,44%. Nessuna soglia quantitativa raggiunta; STOP qualitativo invariato (`medium` anziché `high`).

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd2f1-57cb-78f7-8b69-0aaba6cc227d`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; nessuna decisione critica avviata.
- Profilo rilevato: provider `openai-codex`, modello `gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning non è esattamente `high`, quindi il profilo obbligatorio non è soddisfatto.
- Regole operative canoniche: create in `docs/it/00-regole-operative.md` su richiesta esplicita dell'utente; il mandato corrente e questo checkpoint le integrano.
- Repository verificato: `E:/dev/eiopago`; branch `feat/pi-usage-guardian-foundation`; worktree principale; remote `origin` coerente; nessun commit; solo `CHECKPOINT.md` non tracciato.
- Confronto checkpoint/stato reale: inizialmente nessuna discrepanza. Non risultavano README, ADR o altri file di progetto; in conformità al checkpoint non sono stati ripetuti audit, test, inventari o letture terze.
- Statistiche rilevate prima dell'aggiornamento del checkpoint: 11 entry JSONL; 3 record usage; input 10.774; output 862; reasoning 181; cache read 0; cache write 0; costo riportato USD 0,079730; contesto stimato 7.790 / 272.000 = 2,86%.
- Soglie di consumo: nessun warning o stop raggiunto. Lo stop deriva esclusivamente dal gate qualitativo del reasoning.
- Modifiche: su richiesta esplicita dell'utente, creata la fonte canonica `docs/it/00-regole-operative.md` e resa obbligatoria a ogni chiusura la consegna, sia nel checkpoint sia nel messaggio finale, del prompt minimo per la sessione successiva e di un nome breve suggerito. Aggiornato anche questo checkpoint; roadmap, decisioni pregresse e prossimo passo restano invariati.
- M0 ancora mancante: intera fase critica (architettura e autorità, TokenSave/TraceDecay, accounting e dati, sicurezza/threat model, budget e hard stop verificabile, compose/fork/rewrite, metodologia benchmark, ADR e documenti canonici minimi). M1 non iniziata.
- Profilo obbligatorio per la prossima sessione: `openai-codex/gpt-5.6-sol`, reasoning effettivo `high`; verificarlo prima di qualsiasi decisione critica.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd2d9-3737-701e-a520-f7ce52715c1f`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; nessuna decisione critica avviata.
- Profilo rilevato: provider `openai-codex`, modello `gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning non è esattamente `high`, quindi il profilo obbligatorio non è soddisfatto.
- Repository verificato: `E:/dev/eiopago`; branch `feat/pi-usage-guardian-foundation`; worktree principale; nessun commit; solo `CHECKPOINT.md` non tracciato.
- Confronto checkpoint/stato reale: **nessuna discrepanza**. Non risultano README, ADR o altri file di progetto; non sono stati ripetuti audit, test o ricerche.
- Statistiche disponibili dopo l'analisi del checkpoint: 9 entry JSONL; 2 record usage; input 10.427; output 932; reasoning 150; cache read 0; cache write 0; costo riportato USD 0,080095; contesto stimato 8.251 / 272.000 = 3,03%.
- Statistiche prima della chiusura: 13 entry JSONL; 4 record usage; input 12.613; output 2.035; reasoning 366; cache read 16.384; cache write 0; costo riportato USD 0,132307; contesto stimato 9.650 / 272.000 = 3,55%.
- Soglie di consumo: nessun warning o stop raggiunto. Lo stop deriva esclusivamente dal gate qualitativo del reasoning.
- Modifiche: aggiornato soltanto questo checkpoint; roadmap, decisioni pregresse e prossimo passo restano invariati.
- M0 ancora mancante: intera fase critica (architettura e autorità, TokenSave/TraceDecay, accounting e dati, sicurezza/threat model, budget e hard stop verificabile, compose/fork/rewrite, metodologia benchmark, ADR e documenti canonici minimi). M1 non iniziata.
- Profilo obbligatorio per la prossima sessione: `openai-codex/gpt-5.6-sol`, reasoning effettivo `high`; verificarlo prima di qualsiasi decisione critica.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd2be-9b8c-7c75-900f-662b2ce356f6`.
- Esito: fermato al gate pre-fase critica per profilo non conforme.
- Motivo: provider e modello corretti (`openai-codex/gpt-5.6-sol`), ma reasoning effettivo `medium` anziché `high`.
- Regole canoniche: verificato che nel repository non esiste ancora un file separato; valgono il mandato corrente e questo checkpoint.
- Confronto col repository: checkpoint coerente con branch `feat/pi-usage-guardian-foundation`, worktree principale, assenza di commit e solo `CHECKPOINT.md` non tracciato; nessun README, ADR o altro file di progetto presente.
- Modifiche al progetto: nessuna decisione o implementazione; aggiornato soltanto questo checkpoint.
- Decisioni critiche: nessuna avviata o ratificata.
- Statistiche dopo l'analisi del checkpoint: 11 entry JSONL; input 9.754; output 1.192; reasoning 212; cache read 4.096; cache write 0; costo riportato USD 0,086578; contesto stimato 8.467 / 272.000 = 3,11%.
- Soglie: nessun warning di consumo raggiunto; stop imposto dal gate qualitativo del reasoning.
- Ripresa consigliata: avviare una nuova sessione verificando **prima** delle decisioni che `PI_REASONING_LEVEL=high`; mantenere invariato il prossimo passo già descritto sotto.

## Data

2026-08-05

## Obiettivo

Progetto **eiopago** (nome precedente nel mandato: `pi-usage-guardian`): M0 — fondazione e audit minimo indispensabile. Questa sessione ha completato la verifica ambiente, l'audit documentale di Pi e l'audit ordinario riproducibile dei principali candidati. La fase critica di architettura/sicurezza/accounting non è iniziata perché il contesto ha superato la soglia di stop autorizzata.

## Stato

**Stabile ma M0 non completata. STOP obbligatorio prima della fase critica.**

Non sono iniziate M1 né implementazioni complete di router, TraceDecay/TokenSave, provider, benchmark o dashboard.

## Repository, branch e worktree

- Progetto: `E:/dev/eiopago`
- Remote: `https://github.com/kinderp/eiopago.git`
- Branch: `feat/pi-usage-guardian-foundation`
- Worktree: worktree principale, isolato sul branch sopra
- Commit base: nessuno; repository remoto e locale senza commit
- Modifiche non correlate iniziali: nessuna
- Regole operative canoniche nel repository: `docs/it/00-regole-operative.md` (create dopo l'audit, su richiesta dell'utente)

## Profilo di esecuzione e gate

### Profilo corrente prima del gate

- Provider: `openai-codex`
- Modello: `gpt-5.6-sol`
- Model ID: `gpt-5.6-sol`
- Reasoning effettivo: `medium`
- Profilo operativo: Quality/medium per audit ordinario
- Context window catalogo Pi: 272.000 token
- Fonte accesso: OAuth, coerente con abbonamento OpenAI Codex; nessun segreto letto o registrato
- Prezzo: non esposto dal catalogo CLI per questa fonte; costo per messaggio disponibile nel JSONL Pi

### Statistiche al gate pre-fase critica

Metodo: somma locale degli usage persistiti nel JSONL Pi; contesto stimato dall'ultimo assistant usage come `input + cacheRead + cacheWrite`. Non è stata aperta una seconda istanza RPC.

- Entry JSONL: 86
- Input cumulativo: 224.821
- Output cumulativo: 9.267
- Reasoning cumulativo: 1.886
- Cache read cumulativa: 1.277.952
- Cache write cumulativa: 0
- Costo cumulativo riportato: USD 2,041091
- Contesto stimato: 209.788 / 272.000 = 77,13%
- Esito soglie:
  - cache read: OK (< 3.000.000 warning)
  - costo: WARNING (>= USD 1,50; < USD 3,00 stop)
  - contesto: **STOP** (>= 60%)

### Decisione sul reasoning

L'utente ha autorizzato `high` esclusivamente per architettura, confini di autorità, accounting, precisione monetaria, sicurezza, threat model, budget/stop, reuse/fork/rewrite e benchmark. Il passaggio **non è stato effettuato**, perché il gate di contesto ha imposto lo stop prima della fase critica.

Per la ripresa:

- consigliato: `openai-codex/gpt-5.6-sol`, reasoning `high`, nuova sessione;
- alternativa più economica nello stesso provider: `openai-codex/gpt-5.6-terra`, reasoning `high`, solo se si accetta minore margine sulle decisioni critiche;
- dopo la fase critica: tornare a `medium` per implementazione/test e `low` per fixture, export, documentazione meccanica e checkpoint.

## Profili usati per fase

| Fase | Profilo | Provider/modello | Reasoning | Esito |
| --- | --- | --- | --- | --- |
| Verifica ambiente | Balanced | openai-codex/gpt-5.6-sol | medium | completata |
| Audit documentale Pi | Balanced/Quality | openai-codex/gpt-5.6-sol | medium | completato |
| Audit ordinario componenti terzi | Balanced/Quality | openai-codex/gpt-5.6-sol | medium | completato |
| Gate fase critica | Quality | openai-codex/gpt-5.6-sol | medium | stop per contesto |
| Architettura/sicurezza/accounting | Quality | consigliato Sol | high | non iniziata |

## Ambiente rilevato

- OS: Windows x64, shell MINGW64
- Node.js: 22.19.0
- npm: 10.9.3
- pnpm: non installato
- yarn: non installato
- TypeScript globale: non installato
- Python: 3.10.7
- Rust/Cargo: non installati
- Pi CLI: 0.83.0
- Package installati effettivi:
  - `@earendil-works/pi-coding-agent` 0.83.0
  - `@earendil-works/pi-agent-core` 0.83.0
  - `@earendil-works/pi-ai` 0.83.0
  - `@earendil-works/pi-tui` 0.83.0
- Sessioni Pi: JSONL v3 ad albero con `id`/`parentId`; usage assistant contiene input/output/reasoning/cacheRead/cacheWrite/cost/totalTokens
- Modelli disponibili e autenticati rilevati offline:
  - OpenAI Codex: gpt-5.3-codex-spark, gpt-5.4, gpt-5.4-mini, gpt-5.5, gpt-5.6-luna, gpt-5.6-terra, gpt-5.6-sol
  - Moonshot: catalogo Kimi disponibile tramite API key già configurata; nessun segreto mostrato
- GPT-5.6 Sol/Terra/Luna: contesto Pi 272K, output massimo 128K, reasoning e immagini supportati
- Livelli Pi CLI: off, minimal, low, medium, high, xhigh, max; per GPT-5.6 la documentazione conferma xhigh e max quando supportati

## Audit Pi completato

Documentazione installata 0.83.0 letta senza modificarla:

- README.md
- docs/extensions.md
- docs/models.md
- docs/environment-variables.md
- docs/sdk.md
- docs/tui.md
- docs/rpc.md
- docs/session-format.md
- docs/json.md
- esempi pertinenti: session-name, model-status, preset, shutdown-command, custom-footer, status-line, rpc-demo

Capacità confermate:

- eventi session/agent/turn/message/tool/model/thinking/compaction/provider response;
- usage finale assistant e usage opzionale dei tool;
- input/output/reasoning/cache read/cache write/costo nei JSONL reali;
- `ctx.getContextUsage()`, session naming, model registry e modello/reasoning correnti;
- `tool_call` bloccabile; conferme TUI/RPC; shutdown e abort;
- footer/status/widget/overlay/custom command;
- SDK `AgentSession`, JSON mode e RPC;
- RPC `get_session_stats`, `get_state`, `get_entries`, `get_available_models`, livelli thinking e abort;
- model/thinking changes persistiti nel JSONL.

Limite critico da risolvere in M1: la superficie ExtensionAPI documentata non presenta un evento dedicato `before_llm_call` con risultato bloccabile. `before_provider_request` può sostituire il payload ma non documenta un esito `block`. Il Cost Guard MVP deve dimostrare un vero `block-next-LLM-call`, probabilmente tramite controllo in `input`/`before_agent_start`, stato persistito e arresto/checkpoint prima che la richiesta raggiunga il provider; la soluzione definitiva richiede la fase critica e un test harness senza rete.

## Versioni terze auditate

Clone isolati in `%TEMP%/eiopago-m0-audit`; nessun package globale installato, nessuna configurazione personale modificata.

| Progetto | Versione auditata | SHA | Licenza | Nota |
| --- | --- | --- | --- | --- |
| pi-auto-router | repository 0.2.3; npm pubblicato 0.2.2 | `39f48d994d8abdf7ba1018ac1bffe89f44bee849` | MIT | main avanti rispetto a npm |
| TokenSave/TraceDecay core | Cargo 0.0.73, tag v0.0.73 | `e2c7971c64aa8652ae7f35ec8d3f56be38c3acd5` | MIT | progetto rinominato TraceDecay; README/security mostrano nomenclatura/versioni in transizione |
| pi-tokensaver | 0.0.2, tag v0.0.2 | `65764848f5173b5dac1f4d1dbb73c95f75ca9fa3` | MIT | peer namespace Pi precedente |
| pi-tokensave diretto | 0.1.0 | `64f735bc3286e20a4e5eec7c093bafcea7d455b5` | MIT | adapter diretto più recente e read-only |
| pi-token-usage | 0.2.1, tag v0.2.1 | `774e5fd33b49bce82eadd331cb92c95143e72856` | MIT | parser JSONL riutilizzabile/estraibile |
| pi-usage | clone 0.2.1; npm 0.3.0 | `5f0cc99c00a2668d4d903e74641cb76230426162` | MIT | clone shallow non allineato a npm; usa endpoint quota e credenziali OAuth |
| pi-harness-runtime | 0.10.19 | `68557e59670d143f2c4a65bfdd99addbd73ef005` | MIT | alternativa ampia/beta, fuori dal core M0 |
| pi-powerline-footer | 0.12.1, tag v0.12.1 | `75385f6d750331da1b480f7aceb0f3b1d2b272ff` | licenza non rilevata alla root | pattern TUI pertinente, compatibile Pi 0.83 |

## Test terzi eseguiti in isolamento

Comandi eseguiti con `npm install --ignore-scripts --no-audit --no-fund`, HOME/USERPROFILE sintetici e `PI_OFFLINE=1`.

- pi-auto-router: **429 pass, 3 fail**, 432 totali. Fallimenti riproducibili sullo SHA auditato (`buildMonthlyQuotaWindow`, due casi `formatModelLine`); nessuna chiamata provider reale autorizzata.
- pi-token-usage: **23/23 pass**.
- pi-tokensaver: build TypeScript pass; unit test **20/20 pass**. Test MCP reali non eseguiti perché il binario TokenSave non è installato.
- pi-tokensave diretto: **111 pass, 1 skip**, 112 totali; smoke test reale saltato perché il binario TokenSave non è presente.
- pi-usage: test saltati perché Bun non è installato.
- TraceDecay core: build/test non eseguiti perché Rust/Cargo non sono installati; nessun binario scaricato/installato.

Log locali nelle rispettive directory temporanee (`test.log`, `build.log`, `install.log`).

## Risultati audit ordinario e ipotesi

### pi-auto-router

Confermato/parzialmente confermato:

- routing multi-provider, subscription-first, budget giornaliero/mensile, UVI/quota pacing, shadow mode, circuit breaker, cooldown, decision explanation, JSONL append-only, report script, test e MIT;
- stesso-request failover prima di output sostanziale;
- moduli pubblicamente esportati dai file `src`, ma package senza `exports`/API programmatica stabile dichiarata;
- config e file JSON/JSONL sono contratti de facto, non ancora schema stabile formalizzato;
- legge e può aggiornare auth OAuth per quota; rischio elevato per il confine credenziali;
- a budget esaurito può ricadere sulla lista healthy se tutti i candidati sono bloccati: incompatibile con l'hard stop Guardian;
- non modella direttamente i profili Economy/Balanced/Quality/Critical né un mapping semantico completo dei reasoning level.

Decisione **provvisoria**, da ratificare in high: composizione tramite adapter/event log; nessun fork. Guardian deve imporre candidati/tetto/hard stop, auto-router ordinare candidati e gestire failover della stessa richiesta.

### TokenSave/TraceDecay

Confermato/parzialmente confermato:

- Rust, local-first, libSQL locale, MCP stdio, oltre 70 tool, oltre 50 linguaggi, sync incrementale/on-demand, branch/worktree, dashboard/monitor e metriche di saving;
- core non conserva normalmente sorgente grezzo nel grafo, ma read cache e transcript/session store possono contenere testo sorgente o conversazioni;
- rete opzionale per version check, pricing e contatore aggregato; upload counter disabilitabile con `tracedecay disable-upload-counter`;
- metriche di saving sono stime e non prova di costo monetario evitato;
- nomenclatura `tokensave`/`tracedecay` e versioning documentale sono in transizione;
- nessun test reale locale per assenza Rust/binario.

Decisione **provvisoria**, da ratificare in high: componente esterno opzionale dopo il Cost Guard MVP; adapter read-only, upload disabilitato per default, metriche stimate separate da usage/cache/billing.

### pi-tokensaver

Confermato:

- bridge MCP con lifecycle, schema conversion, sync automatico, modifica automatica `.gitignore`, prompt forte, SIGTERM/SIGKILL e test;
- package giovane 0.0.2, peer dependency su namespace precedente `@mariozechner`/`@sinclair`;
- rischio processi/tool/prompt duplicati e side effect automatici.

Decisione **provvisoria**: non adottare; preferire piccolo adapter diretto/read-only o contribuire upstream. Non attivarlo insieme a integrazione diretta.

### pi-token-usage e pi-usage

- `pi-token-usage`: parser locale semplice e testato; input/output/cache/cost, aggregazioni e TUI/footer. Non conserva reasoning, raw+normalized, accounting preciso o dedup robusta per import incrementale. Candidato per estrazione/adattamento del parser, non dipendenza strategica.
- `pi-usage`: quota live multi-provider tramite endpoint non sempre pubblici/stabili e accesso a credenziali. Utile come riferimento per adapter quota futuro, non per M0/M1 e non da invocare senza consenso/rete.
- pi-powerline-footer: pattern TUI utile; nessuna dipendenza necessaria.
- pi-harness-runtime: scope troppo ampio per il Cost Guard; escluso dal core iniziale.

## Priorità economiche autorizzate da incorporare

Ordine vincolante da riportare in documentazione/ADR/roadmap nella prossima sessione:

1. **P0 Cost Guard + Session Handoff Orchestrator**: identità e Master Task Ledger, telemetria/storage, warning/soglie, vero block-next-LLM-call, checkpoint-and-stop, `confirm` handoff in sessione pulita, prompt automatico e human takeover persistente. La roadmap visuale entra solo col minimo locale necessario e non precede questi controlli.
2. **P1 attribuzione consumo**.
3. **P2 riduzione contesto con TraceDecay/TokenSave**, solo dopo misura+stop.
4. **P3 routing economico con pi-auto-router**, Guardian autorità su budget globale/profilo minimo/autorizzazione chiamata/hard stop/telemetria.
5. **P4 riconciliazione provider**.
6. **P5 forecasting/apprendimento dopo dati reali**.
7. **P6 benchmark/condivisione/dashboard senza ritardare la protezione economica**.

Roadmap vincolante (versione più recente; sostituisce l'ordine precedente):

- M0 — Audit minimo, architettura e verifica API session control
- M1 — Cost Guard + confirm handoff + human takeover; roadmap statica solo minima e non bloccante
- M1.1 — supervised-auto + crash recovery
- M1.2 — Guardian Runner per auto, soltanto se necessario
- M2 — Attribuzione, review budget e roadmap visuale completa
- M3 — TokenSave/TraceDecay
- M4 — pi-auto-router
- M5 — Provider e riconciliazione
- M6 — Forecasting
- M7 — Routing adattivo
- M8 — Benchmark
- M9 — Grafici avanzati, inclusa TUI roadmap interattiva
- M10 — Condivisione opt-in
- M11 — Dashboard

M1 deve includere nello stesso vertical slice Persistent Master Task Ledger, telemetria/fasi/storage, warning/soglie, block-next-LLM-call, checkpoint-and-stop, **confirm handoff**, nuova sessione pulita, prompt automatico di ripresa e **human takeover persistente**. La roadmap locale entra soltanto col minimo necessario e non può ritardare questi gate. `supervised-auto` e crash recovery appartengono a M1.1; `auto` usa M1.2/Guardian Runner solo se le API Extension non risultano robuste. Il ledger canonico e il checkpoint-delta devono evitare doppie fonti di verità; handoff preserva lineage/parent e trasferisce solo pacchetto persistente e Resume Context Manifest.

## Decisioni già prese e limiti

- Nome ufficiale progetto: **eiopago**; `Guardian` resta termine di dominio/compatibilità nel mandato, non nome package definitivo.
- Extension-first per M1 `manual`/`confirm` e takeover, subordinato a verifica API. La precedente esclusione RPC dal core è qualificata dal nuovo mandato: AgentSession/RPC è ammesso in M1.2 esclusivamente per un Guardian Runner opzionale se `auto` robusto non è supportato dall'Extension API.
- SQLite previsto come archivio; denaro in integer minor/micro units o decimal text, mai floating point binario nel modello canonico.
- Raw observations separate dai record normalizzati e dalla riconciliazione.
- Local-first, nessun upload implicito, consenso esplicito.
- Composition before fork.
- Queste decisioni architetturali non sono ancora ratificate con reasoning high e ADR.

## File creati

- `CHECKPOINT.md`
- `docs/it/00-regole-operative.md`

Il file canonico delle regole operative è stato creato dopo lo stop originario, su richiesta esplicita dell'utente e senza avviare la fase critica. Nessun commit creato.

## Attività non iniziate

- fase critica high;
- documentazione obbligatoria e ADR;
- scaffold TypeScript;
- schema/migrazione SQLite;
- vertical slice M0 e fixture;
- test eiopago;
- review indipendente;
- M1 e milestone successive.

## Rischi e problemi aperti

1. Contesto sessione corrente al 77,13%: non riutilizzare per la fase critica.
2. Mancanza di hook Pi pubblico esplicitamente bloccabile immediatamente prima della request: progettare e testare il gate M1 senza affermazioni non verificate.
3. pi-auto-router ha 3 test falliti sul main auditato e può ignorare di fatto un budget quando tutti i candidati risultano bloccati.
4. pi-auto-router accede/aggiorna credenziali per quota: Guardian non deve duplicare o ampliare tale autorità.
5. TraceDecay ha rete opzionale e storage locale che può includere source cache/transcript; privacy da configurare esplicitamente.
6. Rebrand TokenSave→TraceDecay e mismatch versioni/adapter possono rompere schemi e nomi tool.
7. pi-tokensaver usa namespace Pi precedenti e side effect automatici.
8. Nessun test reale TraceDecay disponibile nell'ambiente corrente.
9. Repository senza commit base: prima del primo commit concordare se creare un initial foundation commit.
10. Automatic Session Handoff richiede verifica mirata delle semantiche reali di `waitForIdle()`, `ctx.newSession()`, `withSession`, parent linkage, accodamento del comando post-turno e blocco della chiamata successiva; non assumere che gli hook documentati garantiscano atomicità prima del test E2E.
11. Il profilo `medium` corrente impedisce di ratificare state machine, autorità e failure semantics del nuovo requisito; nessuna progettazione è stata avviata in questa sessione.
12. Il pacchetto di handoff deve evitare duplicazione col checkpoint canonico, contenuti estesi, cronologia, reasoning interno e segreti; schema/versionamento e redazione richiedono una decisione esplicita.
13. Quality Gate, Continuity Check, idempotenza e crash recovery sono confini di sicurezza: una discrepanza Git/checkpoint o un passaggio ambiguo deve bloccare modifiche e ripresa.
14. I risparmi di contesto/cache e la conservazione della qualità restano ipotesi da misurare; non dichiararli dimostrati senza A/B o osservazioni sufficienti.
15. Il task corrente non ha ancora un Master Task Ledger: prima della fase architetturale va creato e popolato in modo conciso dal checkpoint, senza duplicarlo; struttura, task ID e schema version richiedono ratifica `high`.
16. Coerenza obbligatoria: nessun requisito nuovo senza task, nessun `DONE` senza evidenza, nessuna attività attiva legata a requisiti superati e nessuna ripresa quando ledger/checkpoint/Git divergono.
17. La visual roadmap deve essere una proiezione deterministica di fonti canoniche, non una nuova fonte di verità; servono regole di ordinamento, aggregazione, deduplica e gestione dati incompleti.
18. Checkpoint previsti/mancanti e diramazioni operative richiedono entità/eventi espliciti: non dedurli ambiguamente dalla sola cronologia delle sessioni.
19. Rendering terminale stretto, fallback ASCII, output JSON stabile e riconciliazione costi richiedono criteri/test mirati; nessuna chiamata LLM/provider è consentita dal comando.
20. I valori assenti devono restare `unknown`: trattarli come zero falserebbe aggregazioni, costi e gate.
21. Renderer e output devono neutralizzare terminal escape e CSV/formula injection; nomi/messaggi non sono input fidati.
22. La relazione Markdown/SQLite resta aperta: nell'MVP, se Markdown è primario, l'import DB deve essere idempotente e i conflitti visibili; nessuna sincronizzazione silenziosa.
23. La TUI interattiva è fuori dal primo vertical slice e non deve ritardare warning, soglie o block-next-LLM-call.
24. Human takeover deve prevalere anche durante race con HANDOFF_COMMIT: il latch persistito non va perso e la nuova sessione deve restare pausata senza prompt.
25. Hotkey/input interception e steering durante esecuzione dipendono dalle API Pi effettive e dal terminale Windows; preservare Escape e non sovrascrivere binding.
26. Extension e possibile Runner devono condividere database, policy e state machine senza duplicare telemetria o piano.
27. `auto` non è supportata per assunzione: se l'Extension richiede hack fragili, progettare Runner AgentSession/RPC e mantenerla disabilitata per default.
28. Modifiche umane al piano invalidano prompt/checkpoint incoerenti, versionano il ledger e richiedono approvazione prima della ripresa.

## Operazioni da non ripetere

- Non rileggere integralmente la documentazione Pi 0.83.0 elencata sopra.
- Non ripetere inventario toolchain/Pi salvo verifica rapida di eventuali cambi.
- Non riclonare i repository se `%TEMP%/eiopago-m0-audit` esiste con gli SHA indicati.
- Non ripetere i test terzi sopra salvo cambio SHA/dipendenze o necessità mirata.
- Non leggere o mostrare credenziali; non modificare `~/.pi`.
- Non installare globalmente Rust, Bun, TraceDecay o package Pi.
- Non iniziare M1, sub-agent o review automatica.

## File da leggere alla ripresa

1. `docs/it/00-regole-operative.md`
2. `CHECKPOINT.md`
3. Il mandato originale presente nella sessione precedente, solo se necessario per verificare un requisito non riassunto qui
4. Sorgenti terzi mirati nella directory temporanea, solo per domande ancora aperte
5. Documenti di progetto man mano che vengono creati; non esistono ancora README/ADR

## Prossimo passo

Aprire una nuova sessione sullo stesso branch con `openai-codex/gpt-5.6-sol` e reasoning `high`. Verificare rapidamente branch/status e nuove statistiche. Eseguire soltanto la fase critica delimitata:

- priorità P0–P6 e roadmap M0–M11;
- architettura e confini Guardian/auto-router;
- accounting, denaro e riconciliazione;
- credenziali/threat model/privacy;
- budget/stop e fattibilità block-next-LLM-call;
- Persistent Master Task Ledger: convenzione, requisiti/versioni, task/DAG, evidenze, eventi, rapporto col checkpoint e controlli di coerenza; creare il ledger canonico iniziale senza duplicare il checkpoint;
- Visual Task Roadmap/Checkpoint History: comando locale, plan/history/combined, viste/filtri, `checkpoint_message`, `ExpectedCheckpoint`, review/finding/fix/test, DAG e lineage, usage/cost, aggregazioni, rendering sicuro e schema JSON versionato;
- Session Handoff Orchestrator P0: `confirm` + human takeover in M1, supervised-auto/crash recovery in M1.1 e Runner/auto solo se necessario in M1.2;
- comandi di controllo, persistent human-control latch, hotkey/steering deterministici, HANDOFF_ARMED/COMMIT interrompibile, precedenze e tre scenari E2E prioritari;
- verifica mirata Extension API vs AgentSession/RPC e classificazione `confermato`/`da testare`/`non supportato`/`Runner`;
- matrice reuse/composition/fork/rewrite;
- visione, requisiti, casi d'uso, architettura, modello dati, budget/stop, routing, roadmap, sicurezza, benchmark, domande aperte, documento dedicato e ADR non duplicati;
- ADR critici.

Al termine registrare le decisioni e valutare uno stop oppure una nuova sessione `medium` per scaffold/vertical slice/test.

## Comandi di ripresa

```bash
cd E:/dev/eiopago
git status --short --branch
printf '%s/%s reasoning=%s\n' "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"
```

Se i clone temporanei sono ancora presenti:

```bash
for d in "${TEMP:-/tmp}/eiopago-m0-audit"/*; do
  [ -d "$d/.git" ] && printf '%s %s\n' "$(basename "$d")" "$(git -C "$d" rev-parse HEAD)"
done
```

## Ripresa in una nuova sessione

Regola operativa: ogni checkpoint di chiusura deve riportare sia il prompt minimo di ripresa sia un nome breve e descrittivo suggerito per la nuova sessione.

**Nome sessione suggerito:** `eiopago-m0-handoff-takeover-api-high`

### Prompt minimo per la nuova sessione high

> Leggi `docs/it/00-regole-operative.md` e `CHECKPOINT.md`; non ripetere audit/test né ricreare documenti. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`, altrimenti aggiorna checkpoint e fermati. Completa solo M0: crea il Master Task Ledger; verifica API Pi mirate per confirm handoff, new session/parent/prompt, block-next-call, abort, takeover/hotkey/steering e persistence; decidi Extension vs Runner. Ratifica state machine, latch, comandi, precedenze, tre E2E e roadmap M1/M1.1/M1.2; aggiorna requisiti, architettura, modello dati, casi d'uso, test e ADR senza duplicazioni. Non iniziare M1 né modificare `~/.pi`. Chiudi aggiornando ledger/checkpoint e prossimo gate.
