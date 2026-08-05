# Piano maestro dell’ecosistema FARO–Durex–Eiopago

**Versione:** 0.1  
**Data:** 2026-08-06  
**Stato:** documento di coordinamento vivo  
**Scopo:** conservare in un unico file tutte le decisioni, le priorità, i repository, i contratti e i passaggi necessari per costruire il sistema di gestione e babysitting degli agenti.

> Questo documento non sostituisce i checkpoint dei singoli repository.  
> È la roadmap comune dell’intero ecosistema e deve essere aggiornato quando cambiano ownership, contratti, priorità o sequenza delle milestone.

---

## 0. Come usare questo documento

Questo file serve per:

- non perdere le decisioni prese nelle chat;
- capire quale progetto deve fare cosa;
- evitare duplicazioni fra Eiopago, Durex, FARO, Raiatea e Alfred;
- mantenere una roadmap comune;
- aprire issue padre e issue figlie nei repository corretti;
- sapere quali contratti devono essere condivisi;
- conservare l’indipendenza dei singoli progetti;
- riprendere il lavoro anche se una chat diventa troppo lunga o non è più disponibile.

### Convenzione degli stati

| Stato | Significato |
|---|---|
| `DECIDED` | decisione già adottata come direzione di lavoro |
| `PROVISIONAL` | ipotesi preferita, ancora da ratificare con ADR o spike |
| `NEEDS_SPIKE` | serve una prova tecnica |
| `DEFERRED` | decisione o implementazione rinviata |
| `NOT_STARTED` | lavoro non iniziato |
| `IN_PROGRESS` | lavoro attivo |
| `DONE` | completato con evidenza |
| `BLOCKED` | serve una decisione, dipendenza o approvazione |

### Regola per marcare una voce `DONE`

Una voce non deve essere segnata `DONE` senza almeno una delle seguenti evidenze:

- file o documento prodotto;
- test passato;
- ADR ratificato;
- contratto validato;
- commit o PR;
- integration test;
- risultato verificabile.

---

# 1. Visione complessiva

L’obiettivo è costruire un sistema federato in cui agenti AI possano svolgere task lunghi, anche per giorni, attraverso più sessioni e più run, mantenendo:

- continuità;
- controllo dei costi;
- controllo del contesto;
- tracciabilità;
- evidenze;
- revisione;
- possibilità di intervento umano;
- rispetto delle regole specifiche di ogni progetto;
- possibilità di usare modelli piccoli per il babysitting e modelli forti solo quando servono.

## 1.1 Formula sintetica

```text
FARO Governance decide cosa fare e governa il progetto
Durex garantisce l’esecuzione durevole dei job e dei run
Eiopago/Guardian controlla come lavora l’agente dentro Pi
Raiatea conserva evidenze e provenienza
Alfred osserva segnali ed eventi
GitHub rappresenta backlog, issue, PR, roadmap e collaborazione umana
```

## 1.2 Principio architetturale centrale

> Il lavoro degli agenti viene gestito come un grafo di commit operativi immutabili e supportati da evidenze.

Corrispondenza concettuale:

| Sistema agentico | Git |
|---|---|
| sessione dell’agente | working tree temporaneo |
| checkpoint candidato | modifiche pronte per essere consolidate |
| checkpoint verificato | commit operativo |
| task lungo | branch |
| lineage dei checkpoint | history/DAG |
| milestone | tag |
| review o esperimento | ramo laterale |
| sessione fallita | evento operativo, non necessariamente commit valido |

Una sessione non produce automaticamente un checkpoint valido.

---

# 2. Principi non negoziabili

## 2.1 Architettura federata

`DECIDED`

- Nessun monolite unico contenente tutto.
- Ogni progetto conserva una propria identità.
- Ogni progetto deve poter funzionare autonomamente.
- Le integrazioni devono essere opzionali.
- Nessun progetto deve leggere direttamente il database interno di un altro.
- La comunicazione avviene tramite contratti pubblici versionati.
- Ogni repository possiede il proprio stato e le proprie release.

## 2.2 Contratti prima dell’accoppiamento

`DECIDED`

- Eventi e payload condivisi devono avere schema e versione.
- I consumer devono validare gli input.
- Major version sconosciute devono essere rifiutate.
- I campi opzionali sconosciuti possono essere ignorati in sicurezza.
- Gli adapter non devono importare moduli interni non pubblici di altri progetti.

## 2.3 Composizione prima del fork

`DECIDED`

Ordine preferito:

1. API pubblica;
2. formato documentato;
3. adapter;
4. contributo upstream;
5. fork;
6. riscrittura.

## 2.4 Human takeover prioritario

`DECIDED`

Precedenza:

1. intervento umano;
2. emergency stop e sicurezza;
3. hard budget;
4. integrità repository/checkpoint;
5. handoff;
6. piano dell’agente;
7. ottimizzazione dei costi.

## 2.5 Evidenza prima dell’affermazione

`DECIDED`

Un agente non può dichiarare completato un checkpoint senza:

- criterio di completamento;
- evidenze;
- stato Git;
- test o motivazione della loro assenza;
- rischi aperti;
- prossimo passo.

## 2.6 Privacy e local-first

`DECIDED`

- Nessun segreto in checkpoint, log, CSV o database in chiaro.
- Nessun upload di metriche senza opt-in.
- Nessun acquisto automatico di crediti.
- Nessun aumento autonomo del budget.
- Telemetria condivisa solo con consenso esplicito.

---

# 3. Stato attuale noto

## 3.1 Eiopago/Guardian

**Repository locale:** `E:/dev/eiopago`  
**Repository GitHub:** `kinderp/eiopago`  
**Branch locale noto:** `feat/pi-usage-guardian-foundation`

Stato rilevato dal report di copertura:

- esistono documentazione, regole operative e checkpoint;
- non esistono ancora sorgenti o test propri di Eiopago;
- nessuna funzionalità è ancora `COMPLETE`;
- gran parte dei requisiti è `PARTIAL` documentale;
- il modello checkpoint e i contratti futuri sono in larga parte `MISSING`;
- la priorità è chiudere M0.1 prima di iniziare M1.

## 3.2 Durex

`IN_PROGRESS / ESISTENTE`

Capacità già presenti o documentate:

- queue SQLite persistente;
- priorità;
- task e run;
- claim atomici;
- lease;
- fencing tramite epoch;
- heartbeat;
- stale recovery;
- retry e resume;
- PTY e subprocess runner;
- cancellazione del process group;
- output persistente e bounded;
- approvazioni Telegram;
- contratti runtime transport-neutral;
- roadmap verso workflow graph, GitHub e multi-agent.

## 3.3 FARO Research

`ATTIVO E AUTONOMO`

Il repository `kinderp/faro` resta dedicato a:

- DS4;
- inferenza frontier su hardware consumer;
- Apple Silicon;
- esperimenti;
- Gate;
- benchmark;
- FARO Autotune.

Non deve diventare il repository del control plane gestionale.

## 3.4 FARO Governance

`NOT_STARTED / NUOVO REPOSITORY PROPOSTO`

Nuovo progetto separato per:

- control plane;
- project steward;
- backlog;
- metodologia;
- policy;
- checkpoint graph;
- assegnazione;
- acceptance;
- GitHub sync;
- roadmap comune;
- contratti iniziali.

## 3.5 Raiatea

`ESISTENTE`

Ruolo previsto:

- EvidenceReference;
- evidence bundle;
- provenance;
- risoluzione e verifica delle evidenze.

## 3.6 Alfred

`ESISTENTE`

Ruolo previsto:

- osservazione di eventi;
- segnali runtime;
- trigger;
- input per policy superiori.

---

# 4. Ownership dei componenti

| Funzione | Owner principale | Note |
|---|---|---|
| Cost Guard e cache accounting | Eiopago | locale alla sessione Pi |
| Session handoff | Eiopago | manual/confirm/supervised-auto/auto |
| Human takeover | Eiopago | latch persistente |
| Master Task Ledger locale | Eiopago | per il task in esecuzione |
| CandidateCheckpoint | Eiopago | output pubblico principale |
| Queue, job e run | Durex | non duplicare in Eiopago |
| Lease, heartbeat, retry | Durex | execution lifecycle |
| Process control e PTY | Durex | execution transport |
| Project backlog globale | FARO Governance | control plane |
| Metodologia e policy | FARO Governance | configurazione per progetto |
| Scelta del prossimo task | FARO Governance | modello piccolo + policy |
| Acceptance checkpoint | FARO Governance | separata da Guardian |
| GitHub synchronization | FARO Governance | tramite adapter |
| Evidence bundle | Raiatea | provenance verificabile |
| Observation/signals | Alfred | eventi e trigger |
| Ricerca LLM/DS4 | FARO Research | identità separata |

---

# 5. Repository: cosa esiste, cosa creare e cosa rinviare

## 5.1 Repository esistenti da mantenere

- [ ] `kinderp/eiopago`
- [ ] `kinderp/durex`
- [ ] `kinderp/faro`
- [ ] `kinderp/raiatea`
- [ ] `kinderp/alfred`

## 5.2 Nuovo repository da creare a breve

### `faro-governance`

`DECIDED COME DIREZIONE, CREAZIONE DA ESEGUIRE DOPO M0.1 EIOPAGO`

Scopo iniziale docs-first:

```text
faro-governance/
├── README.md
├── CHECKPOINT.md
├── docs/
│   ├── ecosystem/
│   ├── adr/
│   ├── rfc/
│   ├── integrations/
│   ├── governance/
│   └── roadmap/
├── contracts/
├── methodologies/
├── integration-tests/
└── src/                  # inizialmente minimo o assente
```

Contenuti iniziali:

- visione comune;
- ownership;
- system context;
- contract map;
- roadmap comune;
- compatibility matrix;
- glossario;
- primi schemi contrattuali;
- ADR sui confini;
- issue padre trasversali.

## 5.3 Repository da non creare ancora

`DEFERRED`

- `agent-governance-contracts`;
- `faro-methodology-packs`;
- `governance-integration-lab`;
- `guardian-dashboard`;
- `faro-profiles`.

Motivo: evitare frammentazione prematura. Inizialmente possono essere directory di `faro-governance`.

## 5.4 Possibile rinomina

Eiopago è il nome scelto per Guardian. Nei documenti comuni usare:

```text
Eiopago (Guardian)
```

finché il nome pubblico definitivo non viene ratificato.

---

# 6. Modalità standalone obbligatorie

## 6.1 Eiopago standalone

```text
Pi → Eiopago → checkpoint locale
```

Deve funzionare senza:

- Durex;
- FARO Governance;
- Raiatea;
- TokenSave;
- pi-auto-router.

## 6.2 Durex standalone

```text
Durex → runner → Codex/Pi/altro agente
```

Deve continuare a funzionare senza Eiopago.

## 6.3 FARO Governance standalone

Può:

- leggere backlog;
- analizzare roadmap;
- proporre azioni;
- eseguire dry-run;
- sincronizzare GitHub con conferma;

anche senza avviare agenti.

## 6.4 Raiatea e Alfred standalone

Devono conservare i propri domini originali e non dipendere dal control plane.

---

# 7. Gerarchia degli oggetti

```text
FARO Project
└── Master Project Graph
    └── CheckpointSpec
        └── Durex Task
            └── Durex Run
                ├── Eiopago Session 1
                ├── Eiopago Handoff
                └── Eiopago Session 2
                    └── CandidateCheckpoint
                        └── CheckpointDecision
```

## 7.1 CheckpointSpec

Owner: FARO Governance.

Descrive:

- risultato richiesto;
- requisiti;
- dipendenze;
- criteri;
- evidenze;
- rischio;
- budget;
- modello minimo;
- approval policy.

## 7.2 Durex Task

Involucro persistente e schedulabile.

## 7.3 Durex Run

Tentativo concreto con:

- run ID;
- lease;
- heartbeat;
- output;
- cancellation;
- stato terminale.

## 7.4 Eiopago Session

Segmento di contesto LLM.

Uno stesso run può usare più sessioni Eiopago.

## 7.5 CandidateCheckpoint

Output dell’esecuzione dell’agente.

## 7.6 CheckpointDecision

Decisione esterna:

- `ACCEPTED`;
- `FIX_REQUIRED`;
- `REJECTED`;
- `HUMAN_REQUIRED`.

---

# 8. Lifecycle separati

## 8.1 Durex Run

```text
PENDING
RUNNING
WAITING_LIMIT
COMPLETED
FAILED
CANCELLED
```

`COMPLETED` indica che il processo è terminato, non che il risultato è stato accettato.

## 8.2 Eiopago Checkpoint

Lifecycle proposto da ratificare in M0.1:

```text
DRAFT
PARTIAL
CANDIDATE
INVALID
VERIFIED
FAILED
SUPERSEDED
```

## 8.3 FARO Decision

```text
VALIDATING
ACCEPTED
FIX_REQUIRED
REJECTED
HUMAN_REQUIRED
SUPERSEDED
```

---

# 9. Fonti di verità

`DECIDED IN E-M0.1 — ADR Eiopago 0015`

È ratificata una strategia ibrida con ownership distinta per categoria, non una sincronizzazione bidirezionale:

| Informazione | Fonte autorevole ratificata |
|---|---|
| file, commit e worktree | Git/repository |
| Master Task Ledger locale MVP | Markdown canonico versionato; indice SQLite solo derivato |
| CandidateCheckpoint | artefatto JSON immutabile/versionato; indice SQLite derivato |
| telemetria, stato handoff e human latch | database Eiopago; raw e normalizzati separati |
| roadmap di prodotto | Markdown; roadmap runtime come projection non mutante |
| costo fatturato | provider billing; stime/Pi/provider response restano fonti distinte |
| task/run lifecycle durevole | Durex |
| project graph, policy e acceptance | FARO Governance |
| issue/PR pubbliche | GitHub |
| evidenze | artefatto originario/repository; Raiatea per provenance futura |
| sessione corrente | Eiopago/Pi |

Principio:

- nessuna correzione silenziosa dei conflitti e nessun last-write-wins;
- fail-closed in caso di divergenze critiche o latch non leggibile;
- projection e indici non scrivono sulla fonte autorevole;
- raw data e normalized data sono conservati separatamente;
- una futura migrazione di autorità richiede ADR e passaggio one-way verificato.

Riferimenti: `docs/adr/0015-m0-boundaries-and-contract-freeze.md` e `docs/contracts/m0-contracts.md`.

---

# 10. Contratti condivisi v0.1

Posizione iniziale proposta:

```text
faro-governance/contracts/
```

## 10.1 EventEnvelope

Campi minimi:

```yaml
event_id:
event_type:
schema_version:
occurred_at:
producer:
correlation_id:
causation_id:
project_id:
task_id:
run_id:
session_id:
checkpoint_id:
payload:
```

## 10.2 CheckpointSpec

```yaml
checkpoint_spec_id:
project_id:
task_id:
objective:
requirements_version:
dependencies:
completion_criteria:
evidence_policy:
risk_level:
budget:
model_policy:
approval_policy:
workdir:
```

## 10.3 RunContext

```yaml
task_id:
run_id:
attempt:
workdir:
checkpoint_spec:
budget:
cancellation_channel:
event_sink:
```

## 10.4 RunEvent

Tipi:

- lifecycle;
- output;
- heartbeat;
- interaction;
- usage;
- failure;
- cancellation.

## 10.5 CandidateCheckpoint

```yaml
checkpoint_id:
parent_checkpoint_id:
checkpoint_spec_id:
run_id:
session_lineage:
plan_revision:
requirements_version:
git_state:
files_changed:
tests:
evidence:
decisions:
unresolved_risks:
usage:
cost:
next_step:
status:
```

## 10.6 CheckpointDecision

```yaml
checkpoint_id:
outcome:
findings:
required_actions:
next_checkpoint_specs:
```

## 10.7 EvidenceReference

```yaml
evidence_id:
kind:
locator:
media_type:
digest:
producer:
created_at:
verification_status:
sensitivity:
provenance_reference:
```

---

# 11. Versionamento dei contratti

`DECIDED`

- SemVer.
- Patch: correzioni senza cambio semantico.
- Minor: campi opzionali.
- Major: rottura.
- Ogni componente dichiara versioni supportate.
- Ogni contratto deve avere fixture valide e non valide.
- Ogni repository deve eseguire conformance test.

Esempio:

```yaml
contracts: 0.1

components:
  eiopago:
    versions: ">=0.1 <0.3"
    checkpoint_contract: "0.1"

  durex:
    versions: ">=0.3 <0.5"
    execution_contract: "0.1"
```

---

# 12. Eiopago: roadmap completa

## E-M0.1 — Contract and Boundary Freeze

`DONE DOCUMENTALE — 2026-08-05; NESSUNA IMPLEMENTAZIONE M1`

- [x] decidere source of truth — ADR-0015 § D1;
- [x] formalizzare checkpoint-as-commit — ADR-0015 § D2;
- [x] definire parent checkpoint — contratti § 3;
- [x] definire lifecycle checkpoint — contratti § 3.4–3.8;
- [x] separare CandidateCheckpoint e acceptance esterna — contratti § 4–5;
- [x] formalizzare handoff state machine — ADR-0015 § D4;
- [x] formalizzare human latch — ADR-0015 § D4 e contratti § 6;
- [x] classificare API Pi — ADR-0015 § 3;
- [x] definire contratti minimi futuri — `docs/contracts/m0-contracts.md`;
- [x] ratificare modalità standalone — ADR-0015 § D6;
- [x] ratificare confini con Durex/FARO/Raiatea — ADR-0015 § D6;
- [x] aggiornare roadmap — `docs/roadmap.md`;
- [x] aggiornare report coverage — `docs/audit/guardian-requirements-coverage.md`;
- [x] checkpoint finale — `CHECKPOINT.md`.

**Gate:** i confini architetturali sono congelati; M1 resta subordinata agli spike SP-01…SP-10 e a codice/test, senza i quali nessuna funzionalità è COMPLETE.

## E-M1 — Cost Guard + confirm handoff + takeover

Priorità assoluta.

- [ ] progetto TypeScript/scaffold;
- [ ] estensione Pi caricabile;
- [ ] session naming;
- [ ] phase tracking;
- [ ] telemetria input/output/reasoning/cache;
- [ ] accounting preciso;
- [ ] storage SQLite e migrazioni;
- [ ] warning;
- [ ] soglie configurabili;
- [ ] vero block-next-LLM-call o fallback provato;
- [ ] checkpoint-and-stop;
- [ ] Master Task Ledger minimo;
- [ ] checkpoint model minimo;
- [ ] human-control latch;
- [ ] `/eiopago pause`;
- [ ] `/eiopago takeover`;
- [ ] `/eiopago resume`;
- [ ] `/eiopago handoff cancel`;
- [ ] handoff `manual`;
- [ ] handoff `confirm`;
- [ ] nuova sessione pulita;
- [ ] parent session;
- [ ] prompt minimo;
- [ ] Resume Context Manifest;
- [ ] Handoff Quality Gate;
- [ ] Continuity Check;
- [ ] roadmap `--oneline`;
- [ ] export CSV/JSON;
- [ ] TUI minima;
- [ ] test end-to-end.

**Gate:** un task passa fra due sessioni con una sola conferma, senza copiare la history.

## E-M1.1 — supervised-auto e crash recovery

- [ ] handoff `supervised-auto`;
- [ ] grace period;
- [ ] crash journal;
- [ ] recovery idempotente;
- [ ] max handoff/session;
- [ ] takeover durante commit;
- [ ] NEW_SESSION_PAUSED;
- [ ] persistenza latch attraverso reload/crash;
- [ ] watchdog interno.

**Gate:** handoff ordinario automatico, escalation umana per cambi critici.

## E-M1.2 — Guardian/Eiopago Runner opzionale

Solo se l’Extension API non è sufficiente.

- [ ] AgentSession o RPC;
- [ ] orchestrazione processo;
- [ ] restart dopo crash;
- [ ] auto mode;
- [ ] stesso database e state machine dell’estensione;
- [ ] evitare duplicazione di telemetria/policy.

## E-M2 — Diagnostica e review budget

- [ ] attribuzione per task/PR/round;
- [ ] review full/incremental;
- [ ] due round puliti;
- [ ] massimo quattro round;
- [ ] finding;
- [ ] SHA tracking;
- [ ] loop detection;
- [ ] cost per round;
- [ ] roadmap tree/DAG completa;
- [ ] filtri;
- [ ] history combined.

## E-M3 — TokenSave/TraceDecay

- [ ] adapter read-only;
- [ ] health;
- [ ] staleness;
- [ ] branch/worktree;
- [ ] context selection;
- [ ] misure A/B;
- [ ] separazione saving stimato/consumo reale;
- [ ] privacy opt-in.

## E-M4 — pi-auto-router

- [ ] adapter;
- [ ] authority boundary;
- [ ] advisory;
- [ ] shadow;
- [ ] quota/failover;
- [ ] routing per fase;
- [ ] no aumento budget autonomo.

## E-M5 — Provider e reconciliation

- [ ] OpenRouter;
- [ ] Moonshot;
- [ ] pricing snapshot;
- [ ] provider response usage;
- [ ] billing import;
- [ ] API key alias;
- [ ] secret store;
- [ ] subscription vs API;
- [ ] reconciliation states.

## E-M6 — Task profiler e forecast

- [ ] difficulty;
- [ ] risk;
- [ ] task plan/DAG;
- [ ] p50/p80/p95;
- [ ] cost to acceptance;
- [ ] aggiornamento live.

## E-M7 — Adaptive routing

- [ ] escalation/downgrade;
- [ ] reasoning per fase;
- [ ] conferma;
- [ ] rollback;
- [ ] mapping non OpenAI.

## E-M8 — Benchmark privati

## E-M9 — Grafici e report avanzati

## E-M10 — Condivisione opt-in

## E-M11 — Dashboard

---

# 13. Durex: roadmap di integrazione

Durex resta un prodotto autonomo.

## D-M0 — Contract audit

- [ ] mappare Task/Run/Claim agli schemi comuni;
- [ ] evitare modifiche invasive;
- [ ] decidere ownership del runner;
- [ ] definire mapping EventEnvelope.

## D-M1 — PiEiopagoRunner

Nome da ratificare:

- `PiGuardianRunner`;
- `PiEiopagoRunner`;
- `EiopagoExecutor`.

Funzioni:

- [ ] avviare Pi con Eiopago;
- [ ] passare RunContext;
- [ ] ricevere RunEvent;
- [ ] inoltrare cancellation;
- [ ] associare session lineage al run;
- [ ] ricevere CandidateCheckpoint;
- [ ] salvare risultato;
- [ ] mantenere modalità Durex standalone.

## D-M2 — Resume durevole

- [ ] ripresa dopo quota;
- [ ] ripresa dopo crash;
- [ ] run nuovo vs sessione nuova;
- [ ] lease fencing;
- [ ] evitare doppia esecuzione;
- [ ] recovery manuale per effetti non idempotenti.

## D-M3 — Workflow graph

- [ ] dipendenze;
- [ ] condizioni;
- [ ] task chaining;
- [ ] output→input;
- [ ] checkpoint nodes.

## D-M4 — GitHub execution hooks

In coordinamento con FARO Governance.

## D-M5 — Multi-agent/fleet

Solo dopo percorso single-host affidabile.

---

# 14. FARO Governance: roadmap

## F-M0 — Repository docs-first

- [ ] creare repository;
- [ ] README;
- [ ] ownership;
- [ ] system context;
- [ ] common roadmap;
- [ ] contract map;
- [ ] compatibility;
- [ ] glossary;
- [ ] ADR indipendenza dei progetti;
- [ ] ADR control plane/execution plane.

## F-M1 — Contracts v0.1

- [ ] EventEnvelope;
- [ ] CheckpointSpec;
- [ ] RunContext;
- [ ] RunEvent;
- [ ] CandidateCheckpoint;
- [ ] CheckpointDecision;
- [ ] EvidenceReference;
- [ ] fixture;
- [ ] conformance tests.

## F-M2 — Project Steward read-only

- [ ] leggere issue e PR;
- [ ] costruire backlog graph;
- [ ] rilevare parent/child;
- [ ] rilevare incoerenze;
- [ ] proporre priorità;
- [ ] proporre prossimo task;
- [ ] nessuna scrittura GitHub.

## F-M3 — Governance Profile e Policy Engine

- [ ] schema policy;
- [ ] primitive deterministiche;
- [ ] state machine;
- [ ] permission levels;
- [ ] methodology pack;
- [ ] validator;
- [ ] dry-run;
- [ ] explain.

## F-M4 — Onboarding conversazionale

Il modello piccolo:

- [ ] intervista l’utente;
- [ ] inferisce convenzioni;
- [ ] chiede chiarimenti;
- [ ] genera YAML;
- [ ] genera test policy;
- [ ] mostra impatto;
- [ ] chiede approvazione;
- [ ] versiona la policy.

## F-M5 — GitHub write con conferma

- [ ] proposed action;
- [ ] policy evaluation;
- [ ] confirm;
- [ ] issue update;
- [ ] label;
- [ ] comment;
- [ ] reviewer request;
- [ ] roadmap sync;
- [ ] post-action verification;
- [ ] audit trail.

## F-M6 — Checkpoint acceptance

- [ ] validazione deterministica;
- [ ] evidence policy;
- [ ] review;
- [ ] acceptance;
- [ ] fix required;
- [ ] sblocco del prossimo nodo.

## F-M7 — Babysitter economico

- [ ] scegliere task;
- [ ] assegnare a Durex;
- [ ] scegliere modello/reasoning;
- [ ] budget;
- [ ] loop detection;
- [ ] escalation;
- [ ] human gate.

## F-M8 — Multi-project

## F-M9 — Multi-agent e parallelizzazione

---

# 15. Raiatea: roadmap di integrazione

## R-M0 — Evidence contract

- [ ] mappare modello attuale a EvidenceReference;
- [ ] locator;
- [ ] digest;
- [ ] media type;
- [ ] sensitivity;
- [ ] verification status.

## R-M1 — Evidence bundle

- [ ] test output;
- [ ] artifact;
- [ ] report;
- [ ] Git reference;
- [ ] provider billing;
- [ ] provenance chain.

## R-M2 — Verification API

- [ ] resolve;
- [ ] verify digest;
- [ ] classify stale/missing;
- [ ] access control.

Raiatea resta autonomo.

---

# 16. Alfred: roadmap di integrazione

## A-M0 — Event compatibility

- [ ] Common Event Envelope;
- [ ] signal mapping;
- [ ] correlation/causation IDs.

## A-M1 — Observation signals

Possibili segnali:

- agent loop;
- budget warning;
- checkpoint ready;
- worker stale;
- issue blocked;
- review non convergente;
- provider quota.

Alfred osserva e segnala; non assume il project control plane.

---

# 17. FARO Research: confine

`DECIDED`

FARO Research:

- resta in `kinderp/faro`;
- non dipende da FARO Governance;
- può usare il Governance Runtime opzionalmente;
- può fornire un methodology pack `research-gates`;
- conserva roadmap e identità scientifica proprie.

Possibile integrazione futura:

```text
Gate scientifico FARO Research
→ CheckpointSpec
→ Durex Run
→ Eiopago Session(s)
→ EvidenceReference
→ GO/PIVOT/STOP
```

---

# 18. Methodology Pack e Project Governance Profile

## 18.1 Methodology pack

Template riutilizzabili:

- Kanban;
- Scrum;
- Unified Process;
- Shape Up;
- GitHub Flow;
- Trunk Based;
- Research Gates;
- Solo Developer.

## 18.2 Project Governance Profile

Ogni repository possiede:

```text
.faro/
├── governance.yaml
├── workflow.yaml
├── approvals.yaml
├── github-mapping.yaml
└── templates/
```

## 18.3 Regole specifiche del progetto

Esempi:

- issue padre e figlie;
- PR obbligatoria per issue figlia;
- due round consecutivi puliti;
- merge squash;
- conferma umana;
- checkpoint accettato;
- chiusura padre dopo tutte le figlie.

## 18.4 Autonomia delle azioni

Valori:

- `automatic`;
- `automatic_if_policy_passes`;
- `confirm`;
- `human_only`;
- `forbidden`.

## 18.5 Policy conversazionale

Flusso:

```text
dialogo
→ proposta YAML
→ schema validation
→ contradiction check
→ dry-run
→ impact preview
→ approval
→ versioned policy
```

---

# 19. Project Steward con modello piccolo

## 19.1 Compiti adatti

- triage issue;
- classificazione;
- priorità;
- duplicati;
- dipendenze;
- scelta del prossimo task;
- aggiornamento roadmap;
- sintesi;
- proposta di label;
- proposta di stato;
- preparazione Discussion;
- proposta di assegnazione;
- verifica formale dei checkpoint.

## 19.2 Compiti non delegati senza gate

- cambi di prodotto;
- architettura critica;
- sicurezza;
- pagamenti;
- privacy;
- migrazioni;
- merge critici;
- aumento budget;
- pubblicazione vulnerabilità.

## 19.3 Gerarchia

```text
regole deterministiche
→ modello piccolo/steward
→ agente esecutore
→ revisore forte
→ essere umano
```

---

# 20. GitHub: organizzazione comune

## 20.1 Issue padre trasversale

Creare nel repository `faro-governance`.

Esempio:

```text
Epic: Session handoff durevole Eiopago–Durex
```

## 20.2 Issue figlie nei repository owner

Esempio:

```text
eiopago#...  CandidateCheckpoint
durex#...    PiEiopagoRunner
faro-governance#... CheckpointSpec
raiatea#...  EvidenceReference
```

## 20.3 GitHub Project comune

Campi suggeriti:

- componente;
- epic;
- fase;
- priorità;
- rischio;
- stato;
- contract version;
- integration gate;
- owner;
- modello consigliato;
- costo previsto.

## 20.4 Roadmap locale e comune

Roadmap comune:

```text
faro-governance/docs/ecosystem/COMMON_ROADMAP.md
```

Roadmap locali:

```text
eiopago/docs/ROADMAP.md
durex/docs/ROADMAP.md
faro/docs/research/RESEARCH_ROADMAP.md
raiatea/docs/ROADMAP.md
```

---

# 21. Processo per cambiare un contratto

```text
1. RFC in faro-governance
2. discussione
3. ADR/decisione
4. PR sul contratto
5. fixture e conformance test
6. PR nei consumer
7. compatibility matrix verde
8. release contratto
9. aggiornamento roadmap comune
```

Divieti:

- nessuna copia manuale divergente degli schemi;
- nessuna dipendenza dal `main` di un altro repository;
- nessuna modifica cross-repo non versionata.

---

# 22. Test di conformità e integrazione

Ogni schema deve avere:

```text
valid-minimal.json
valid-complete.json
invalid-missing-id.json
invalid-unsupported-state.json
invalid-secret-leak.json
```

Test per repository:

## Eiopago

- produce CandidateCheckpoint valido;
- produce RunEvent usage valido;
- rifiuta schema sconosciuto;
- non salva segreti.

## Durex

- accetta RunContext valido;
- produce lifecycle events;
- conserva run ID e fencing.

## FARO Governance

- produce CheckpointSpec;
- valuta CandidateCheckpoint;
- produce CheckpointDecision.

## Raiatea

- risolve e verifica EvidenceReference.

## Integration test comune

```text
CheckpointSpec
→ Durex fake task/run
→ Eiopago fixture
→ CandidateCheckpoint
→ evidence
→ FARO decision
```

---

# 23. Modelli e reasoning per fasi

Baseline concettuale:

| Tipo lavoro | Profilo |
|---|---|
| meccanico | Economy / low |
| implementazione ordinaria | Balanced / medium |
| debugging difficile | Balanced-high o Quality-high |
| architettura/contratti | Quality / high |
| review critica | Quality / high o xhigh |
| checkpoint/report | Economy / low |
| project babysitting | modello piccolo con policy deterministiche |

Se il provider non è OpenAI:

- cercare equivalenza funzionale;
- non dichiarare equivalenza assoluta;
- registrare confidenza;
- usare dati reali del progetto per calibrare.

---

# 24. Priorità globale dell’ecosistema

## P0 — Chiudere Eiopago M0.1

Nessun altro fronte di implementazione deve precederlo.

## P1 — Cost Guard e handoff confirm

Primo valore economico reale.

## P2 — Human takeover e supervised-auto

Ridurre lavoro manuale mantenendo controllo.

## P3 — Durex + Eiopago end-to-end

Rendere il task durevole oltre processo, crash e quota.

## P4 — Contratti v0.1 e conformance

Stabilizzare integrazione.

## P5 — FARO Steward read-only

Capire backlog senza scritture.

## P6 — Policy conversazionale

Tradurre metodologie e regole in YAML.

## P7 — GitHub write con conferma

Azioni controllate.

## P8 — Acceptance ed evidenze

Chiudere il ciclo.

## P9 — Babysitter economico

Gestione semi-autonoma.

## P10 — Multi-agent e fleet

Soltanto dopo stabilità single-agent.

---

# 25. Passaggi immediati

## Step 1 — Eiopago M0.1

`DONE DOCUMENTALE — evidenze in ADR-0015, contratti M0, roadmap, coverage e CHECKPOINT.md`

- [x] eseguire il prompt Contract and Boundary Freeze;
- [x] leggere il report finale;
- [x] aggiornare questo documento;
- [x] ratificare source of truth;
- [x] ratificare checkpoint lifecycle;
- [x] ratificare confini.

## Step 2 — Rendere persistente la fondazione

- [ ] creare almeno un commit nel branch Eiopago;
- [ ] pubblicare branch remoto;
- [ ] aprire PR M0.1 oppure issue padre M1;
- [ ] evitare che tutto resti soltanto nel worktree.

## Step 3 — Aprire Eiopago M1

Issue padre suggerita:

```text
M1 — Cost Guard, confirm handoff e human takeover
```

Issue figlie:

- telemetria;
- SQLite;
- accounting;
- block-next-call spike;
- checkpoint model;
- Master Task Ledger;
- latch;
- handoff confirm;
- new session;
- continuity check;
- CSV/JSON;
- roadmap oneline;
- test E2E.

## Step 4 — Creare `faro-governance` docs-first

Da fare solo dopo M0.1 ratificata.

## Step 5 — Prima integrazione Durex

Da iniziare dopo il primo handoff end-to-end di Eiopago.

---

# 26. Cose da non fare subito

- [ ] non creare dashboard;
- [ ] non creare tutti i repository futuri;
- [ ] non implementare multi-agent;
- [ ] non automatizzare merge critici;
- [ ] non acquistare crediti automaticamente;
- [ ] non integrare provider prima del Cost Guard;
- [ ] non duplicare queue/lease/heartbeat dentro Eiopago;
- [ ] non spostare FARO Research nel control plane;
- [ ] non creare un policy engine arbitrario basato solo su LLM;
- [ ] non marcare complete funzionalità solo documentate.

---

# 27. Open questions da risolvere

## Eiopago

- [ ] `NEEDS_SPIKE SP-01`: l'Extension non espone un hook block diretto; provare il fallback prima di richiedere Runner.
- [ ] `NEEDS_SPIKE SP-08`: `newSession()` esiste, ma failure dopo teardown e recovery journal vanno provati.
- [ ] `PROVISIONAL`: Runner solo se SP-01/SP-04 o crash unattended lo richiedono; M1.2 resta condizionale.
- [x] `DECIDED ADR-0015`: ownership ibrida; Ledger Markdown, runtime state SQLite, checkpoint JSON immutabile.
- [x] `DECIDED contracts § 3`: sealing/digest append-only; correzione con checkpoint figlio.
- [x] `DECIDED contracts § 3.3`: zero/uno/più commit tramite `GitState.commit_shas[]`.

## Durex

- [ ] un run contiene più sessioni o ogni handoff crea un nuovo run?
- [ ] come gestire effetti esterni non idempotenti?
- [ ] quale runner è owner del lifecycle Pi?

## FARO Governance

- [ ] repository pubblico o privato?
- [ ] linguaggio iniziale: TypeScript?
- [ ] GitHub Projects come vista o source of truth?
- [ ] quali primitive policy implementare per prime?

## Raiatea

- [ ] EvidenceReference può mappare direttamente il modello esistente?
- [ ] come gestire dati sensibili?

## Ecosistema

- [ ] dove pubblicare i contratti quando maturano?
- [ ] quale organizzazione GitHub usare?
- [ ] quali nomi pubblici definitivi usare?
- [ ] come gestire compatibility matrix in CI?

---

# 28. Definition of Done del primo ciclo comune

Il primo ciclo dell’ecosistema è completato quando:

1. Eiopago misura e blocca il consumo;
2. Eiopago crea una nuova sessione con conferma;
3. il takeover umano funziona;
4. il task riprende dal checkpoint;
5. Durex esegue Eiopago come runner durevole;
6. CandidateCheckpoint viene prodotto;
7. FARO Governance lo valuta con regole minime;
8. un’evidenza viene referenziata;
9. il task successivo viene sbloccato;
10. il percorso è verificato end-to-end.

---

# 29. Registro delle decisioni

## 2026-08-06 — v0.1

- adottata architettura federata;
- Eiopago è il nome del progetto Guardian;
- FARO Research resta separato;
- proposto nuovo repository `faro-governance`;
- Durex mantiene execution lifecycle;
- checkpoint definito come commit operativo;
- acceptance separata dall’esecuzione;
- roadmap comune localizzata in FARO Governance;
- priorità immediata: Eiopago M0.1 e poi M1.

---

# 30. Informazioni da allegare quando si riprende il lavoro

Quando questo documento viene passato in una nuova chat o a un nuovo agente, allegare anche:

1. questo file;
2. ultimo `CHECKPOINT.md` di Eiopago;
3. `guardian-requirements-coverage.md`;
4. ultimo report M0.1;
5. branch e SHA correnti;
6. eventuale roadmap comune aggiornata;
7. link alle issue padre attive.

Prompt minimo:

```text
Leggi il Piano maestro dell’ecosistema e i checkpoint allegati.
Verifica stato reale dei repository e non assumere complete le attività
segnate soltanto come progettate. Identifica il prossimo step non bloccato
nella sezione “Passaggi immediati” e proponi il più piccolo task coerente.
```
