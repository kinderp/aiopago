# M0 contracts — Aiopago/Guardian

- **Contract set:** `aiopago.m0`
- **Schema version:** `0.1.0`
- **Status:** DECIDED for field semantics; serialization schemas and fixtures DEFERRED to M1
- **ADR:** [`../adr/0015-m0-boundaries-and-contract-freeze.md`](../adr/0015-m0-boundaries-and-contract-freeze.md)

Questo documento congela i contratti minimi provider-neutral. Non è codice, non prescrive un database condiviso e non rende implementata alcuna funzione.

## 1. Regole comuni

### 1.1 Versionamento

- SemVer per ogni schema.
- Patch: chiarimento/correzione senza cambio semantico.
- Minor: campi opzionali compatibili.
- Major: rimozione, obbligatorietà nuova o cambio semantico.
- Il consumer rifiuta major sconosciute; conserva l'evento originale e fallisce chiuso per azioni critiche.
- Timestamp: RFC 3339 UTC.
- Denaro: integer micro/minor units con currency esplicita oppure decimal string; mai floating point canonico.
- Campo assente: `null`/`unknown` secondo schema, mai zero inventato.
- Gli oggetti attraversano i confini come JSON validato; nessun consumer importa classi interne o database di un altro progetto.

### 1.2 Identità minime

Gli ID sono stringhe opache, uniche e immutabili. Il formato raccomandato è prefisso + UUIDv7; il consumer non deduce semantica dal prefisso.

| Entità | Campo | Prefisso raccomandato |
|---|---|---|
| Project | `project_id` | `PRJ-` |
| Task | `task_id` | `TASK-` |
| Task item | `task_item_id` | `ITEM-` |
| Plan revision | `plan_revision_id` | `PLAN-` |
| Requirement version | `requirements_version` | valore/version ID opaco |
| Session | `session_id` | ID Pi originale o `SES-` aliasato |
| Run futuro | `run_id` | `RUN-` |
| Checkpoint spec | `checkpoint_spec_id` | `CPS-` |
| Checkpoint | `checkpoint_id` | `CP-` |
| Event | `event_id` | `EVT-` |
| Evidence | `evidence_id` | `EVD-` |
| External decision | `checkpoint_decision_id` | `CPD-` |
| Correlation | `correlation_id` | opaco, stabile per flusso logico |
| Causation | `causation_id` | ID dell'evento/comando causante |

### 1.3 Provenance, redazione e digest

- I payload non contengono credenziali, token di accesso, reasoning interno o cronologia completa.
- Locator sensibili sono redatti o relativi al workdir quando possibile.
- Digest raccomandato: `sha256:<hex>` sul byte stream canonico dell'artefatto.
- La canonicalizzazione JSON deve essere scelta nello schema M1; fino ad allora il digest dell'artefatto serializzato include encoding e bytes esatti.
- Un digest non verificato non diventa implicitamente valido.

## 2. Master Task Ledger minimo

Il Ledger non viene creato in M0.1; lo schema seguente lo rende implementabile e testabile.

### 2.1 `Task`

Campi obbligatori:

```text
task_id
schema_version
title
objective
requirements_version
plan_revision_id
status
completion_criteria[]
risk
created_at
updated_at
next_step
task_items[]
```

Campi opzionali: `project_id`, `budget`, `model_policy`, `checkpoint_policy`, `external_refs[]`.

Stati: `PLANNED | IN_PROGRESS | BLOCKED | DONE | DROPPED | SUPERSEDED`.

Invarianti:

- `DONE` richiede tutti i criteri obbligatori soddisfatti e `evidence[]` verificabile.
- `DROPPED` e `SUPERSEDED` conservano motivo, actor, timestamp e replacement ID se esiste.
- Una nuova revisione non cancella revisioni precedenti.

### 2.2 `TaskItem`

```text
task_item_id
task_id
title
description
status
depends_on[]
completion_criteria[]
evidence[]
requirements_refs[]
risk
milestone
last_updated_at
last_updated_by
last_session_id?
last_checkpoint_id?
supersedes?
superseded_by?
```

- `depends_on` forma un DAG; cicli bloccano la revisione.
- Stato `DONE` senza evidenza richiesta è invalido.
- Un requisito superseded non mantiene task attivi senza rivalutazione esplicita.

### 2.3 `PlanRevision`

```text
plan_revision_id
task_id
previous_revision_id?
requirements_version
content_digest
created_at
producer
change_reason
approved_by?
```

Il checkpoint riferisce una revisione esatta; un update compare-and-swap usa `previous_revision_id` e `content_digest`.

## 3. Checkpoint come commit operativo

### 3.1 Concetti

- `DraftCheckpoint`: workspace mutabile e non riprendibile garantito.
- `CandidateCheckpoint`: snapshot pubblico immutabile prodotto da Aiopago.
- `VerifiedCheckpoint`: lo stesso candidato con evento Guardian `VERIFIED`; il payload non cambia.
- `ExternalDecision`: valutazione separata, futura, che non modifica il candidato.

### 3.2 Campi minimi del checkpoint

La forma canonica snake_case soddisfa i nomi logici richiesti:

| Nome logico | Campo | Regola |
|---|---|---|
| CheckpointId | `checkpoint_id` | Unico; cambia a ogni retry/correzione |
| ParentCheckpointId | `parent_checkpoint_id` | Null per root; parent primario |
| Merge parents | `merge_parent_checkpoint_ids[]` | Opzionali; rendono la history un DAG |
| TaskId | `task_id` | Obbligatorio |
| SessionLineage | `session_lineage[]` | Ordinata, almeno una sessione salvo import esplicito |
| Future run lineage | `run_lineage[]` | Opzionale in standalone |
| PlanRevision | `plan_revision_id` | Revisione esatta |
| RequirementsVersion | `requirements_version` | Versione esatta |
| CheckpointMessage | `checkpoint_message` | Una riga sintetica; target 72–100 caratteri, non hard limit di schema |
| CreatedAt | `created_at` | UTC |
| Producer | `producer` | ID/versione componente e actor type |
| GitState | `git_state` | Vedi §3.3 |
| CompletionCriteria | `completion_criteria[]` | Esito per criterio, non sola lista |
| Evidence | `evidence[]` | `EvidenceReference` |
| Usage | `usage` | Categorie separate, unknown preservato |
| Cost | `cost` | Fonti separate, currency e precisione |
| Risks | `risks[]` | Stato e mitigazione/owner se noti |
| NextStep | `next_step` | Azione concreta o blocco esplicito |
| Status | `status` | Stato interno Guardian |

Campi pubblici aggiuntivi obbligatori per `CandidateCheckpoint`:

```text
schema_version
checkpoint_spec_id?
task_item_ids[]
changes[]
tests[]
decisions[]
content_digest
idempotency_key
```

### 3.3 `GitState`

```text
repository_id
workdir
branch
head_sha?                 # null ammesso in repository senza commit
base_sha?
commit_shas[]             # zero, uno o più commit riferiti
index_digest?
worktree_digest?
status_entries[]
observed_at
```

- Zero commit Git è valido se dichiarato.
- Nessuna modifica Git è valida per checkpoint di decisione, audit o verifica, se i criteri lo consentono.
- Più commit sono validi se il checkpoint ne delimita il range e le evidenze.
- Il checkpoint non crea commit automaticamente.

### 3.4 Stati interni Guardian

```text
DRAFT | PARTIAL | CANDIDATE | INVALID | VERIFIED | FAILED | SUPERSEDED
```

Semantica:

- `DRAFT`: oggetto di lavoro incompleto, non promette riprendibilità.
- `PARTIAL`: snapshot immutabile e riprendibile solo per continuare lavoro incompleto; non soddisfa i criteri globali.
- `CANDIDATE`: snapshot immutabile completo rispetto alla spec, in attesa di verifica Guardian.
- `INVALID`: candidato/snapshot non conforme a schema, integrità, segreti, parent o Git.
- `VERIFIED`: schema, integrità, criteri Guardian, evidenze richieste e Git sono coerenti; non significa acceptance esterna.
- `FAILED`: la produzione/verifica non ha potuto concludersi; conserva diagnosi/evidenze disponibili.
- `SUPERSEDED`: un checkpoint successore lo sostituisce senza cancellarlo.

### 3.5 Transizioni valide

| Da | A | Requisiti |
|---|---|---|
| nessuno | DRAFT | ID/idempotency key allocati; task noto |
| DRAFT | PARTIAL | payload minimo di ripresa, Git snapshot, rischi e next step; sealing/digest |
| DRAFT | CANDIDATE | schema completo, spec/criteri valutati, evidence policy, secret scan, sealing/digest |
| DRAFT | FAILED | errore registrato e nessuna candidatura sicura possibile |
| CANDIDATE | VERIFIED | validazione schema, digest, parent DAG, Ledger revision, GitState, secret scan ed evidenze obbligatorie positive |
| CANDIDATE | INVALID | una validazione deterministica fallisce |
| CANDIDATE | FAILED | verificatore non completa per errore operativo distinguibile da invalidità dati |
| PARTIAL | SUPERSEDED | esiste un nuovo checkpoint figlio che riprende/corregge il lavoro |
| VERIFIED | SUPERSEDED | esiste un figlio `VERIFIED` che sostituisce esplicitamente il risultato |
| INVALID | SUPERSEDED | esiste un nuovo checkpoint che registra la correzione |
| FAILED | SUPERSEDED | esiste un retry con nuovo checkpoint ID |

Le transizioni sono eventi append-only. Il campo `status` nella projection è l'ultimo stato valido; il payload sealed non viene riscritto.

### 3.6 Transizioni vietate

- Qualsiasi terminale/sealed → `DRAFT`.
- `INVALID` o `FAILED` → `VERIFIED` sullo stesso checkpoint ID.
- `PARTIAL` → `CANDIDATE` sullo stesso ID: completare significa produrre un figlio nuovo.
- `VERIFIED` → stato meno forte sullo stesso ID.
- Stato interno → `ACCEPTED/FIX_REQUIRED/REJECTED/HUMAN_REQUIRED`: sono decisioni esterne, non stati Guardian.
- Cambio payload/digest dopo `PARTIAL` o `CANDIDATE`.
- Parent che crea un ciclo o punta al checkpoint stesso.

### 3.7 Parentage e retry

- Root: `parent_checkpoint_id = null`.
- Proseguimento lineare: un parent primario.
- Merge: parent primario + `merge_parent_checkpoint_ids`; tutti devono esistere e appartenere al task o dichiarare relazione cross-task autorizzata.
- Retry/correzione: nuovo `checkpoint_id`, parent al tentativo precedente, nuova idempotency key o attempt incrementato.
- Duplicato della stessa idempotency key e stesso digest: restituisce il checkpoint esistente.
- Stessa key con digest diverso: conflitto fail-closed.

### 3.8 Casi limite normativi

- **Sessione fallita:** può produrre `PARTIAL` solo se GitState, parent, redazione, rischi e next step sono verificabili; altrimenti `FAILED` o `INVALID`.
- **Checkpoint parziale:** è sealed e può essere usato solo per ripresa controllata; non può sbloccare completion/acceptance.
- **Nessuna modifica Git:** ammessa; `changes=[]`, GitState esatto ed evidenza non-Git richiesta dai criteri.
- **Più sessioni:** `session_lineage` ordinata registra parentage/ruolo; una sola candidatura consolida il delta.
- **Più run futuri:** `run_lineage` distingue tentativi Durex; il checkpoint dichiara producer run finale e contributi precedenti.
- **Sessione senza checkpoint:** resta evento operativo; non entra nel checkpoint DAG come risultato valido.

## 4. Decisioni esterne future

### 4.1 `CheckpointDecision`

Produttore previsto: FARO Governance o umano/governance adapter autorizzato. Aiopago può consumarlo e visualizzarlo, non produrre acceptance globale.

```text
checkpoint_decision_id
decision                 # ACCEPTED | FIX_REQUIRED | REJECTED | HUMAN_REQUIRED
schema_version
checkpoint_id
checkpoint_digest
occurred_at
producer
policy_version?
findings[]
actions_required[]
next_checkpoint_specs[]  # CheckpointSpec references or embedded provider-neutral specs
evidence[]
correlation_id
causation_id
```

- `ACCEPTED` non modifica `CandidateCheckpoint`/`VERIFIED`.
- `FIX_REQUIRED` produce nuove spec/azioni e un futuro checkpoint figlio.
- Decisione su digest diverso o checkpoint superseded è invalida/pending human review.
- Più decisioni sono append-only; una decisione sostitutiva riferisce la precedente.

## 5. Contratti di confine

### 5.1 `EventEnvelope`

Campi minimi obbligatori:

```text
event_id
event_type
schema_version
occurred_at
producer
correlation_id
causation_id?
project_id?
task_id?
run_id?
session_id?
checkpoint_id?
payload
```

Regole:

- `event_id` deduplica; stesso ID con payload/digest diverso è conflitto.
- `correlation_id` segue il flusso logico task/run/handoff.
- `causation_id` riferisce evento o comando diretto; null solo per root event.
- Gli ID assenti restano null, non stringhe vuote.
- `payload` è discriminato da `event_type` e versionato.
- Ordering globale non è assunto; producer sequence opzionale può ordinare un singolo stream.

### 5.2 `CheckpointSpec`

Descrive il risultato richiesto, non il risultato ottenuto.

```text
checkpoint_spec_id
schema_version
project_id?
task_id
objective
requirements_version
dependencies[]
completion_criteria[]
evidence_policy
risk
budget
model_policy
approval_policy
workdir
created_at
producer
```

Minimi annidati:

- `evidence_policy`: kind richiesti, verification minima, sensitivity ammessa.
- `budget`: currency, hard/soft limits, scope, unknown behavior.
- `model_policy`: profilo/capacità minima, reasoning range, conferme richieste.
- `approval_policy`: chi può verificare/accettare e quando serve umano.
- `workdir`: path/URI normalizzato e repository identity.

### 5.3 `RunContext`

Contesto ricevibile da un execution orchestrator futuro; tutti i campi restano provider-neutral.

```text
schema_version
project_id?
task_id
run_id
attempt
workdir
checkpoint_spec
budget
cancellation_channel
event_sink
correlation_id
parent_run_id?
resume_checkpoint_id?
```

- `cancellation_channel`: endpoint/capability opaca con semantics idempotenti; non contiene segreto persistito nel checkpoint.
- `event_sink`: endpoint/callback descriptor e versione envelope.
- In standalone Aiopago crea un run locale effimero o lascia `run_id` null nei soli contratti che lo consentono; non implementa queue/lease.

### 5.4 `RunEvent`

È un `EventEnvelope` il cui payload appartiene a una categoria:

```text
lifecycle     # requested, started, paused, resumed, completed
output        # bounded output/reference, mai log illimitato obbligatorio
heartbeat     # liveness/lease metadata posseduta da Durex
interaction   # prompt/confirmation/takeover request e response reference
usage         # input/output/reasoning/cache/cost source-labelled
failure       # code, category, retryable, diagnostics/evidence refs
cancellation  # requested, acknowledged, completed, actor/reason
```

Aiopago può produrre eventi session/usage/checkpoint; Durex possiede heartbeat/lease e durable run lifecycle. Un `completed` non equivale a checkpoint `VERIFIED` o decisione `ACCEPTED`.

### 5.5 `CandidateCheckpoint`

Output pubblico principale di Aiopago. Include:

```text
checkpoint identity e digest
parent e merge parents
task/spec identity
run_lineage[] e session_lineage[]
plan_revision_id e requirements_version
GitState
changes[]
tests[]
EvidenceReference[]
decisions[]          # decisioni tecniche interne, non acceptance
risks[]
usage
cost
next_step
status               # PARTIAL o CANDIDATE all'emissione pubblica
```

Deve validare contro §3. Non contiene cronologia chat completa, reasoning interno o segreti.

### 5.6 `EvidenceReference`

```text
evidence_id
schema_version
kind
locator
media_type
digest
producer
created_at
verification_status   # UNVERIFIED | VERIFIED | FAILED | UNAVAILABLE
sensitivity           # PUBLIC | INTERNAL | CONFIDENTIAL | SECRET_BLOCKED
provenance_reference?
```

Regole:

- `SECRET_BLOCKED` non espone il segreto e non è esportabile.
- `VERIFIED` richiede resolver appropriato al kind e digest coerente.
- Il locator non è prova sufficiente senza digest o giustificazione per fonti mutabili.
- Il repository/Git può risolvere evidenze locali; Raiatea è resolver/provenance futuro opzionale.

## 6. Handoff e human-control contracts

### 6.1 `HumanControlLatch`

```text
task_id
state                  # ENGAGED | RELEASED
generation
reason                 # HUMAN_TAKEOVER | SAFETY | HARD_BUDGET | INTEGRITY | RECOVERY
engaged_at
engaged_by
released_at?
released_by?           # deve essere actor umano
correlation_id
last_event_id
```

- `generation` cresce monotonicamente.
- Un consumer che non può leggere/validare il latch assume `ENGAGED`.
- `RELEASED` con actor non umano è invalido.
- Cache in memoria con generation vecchia non autorizza azioni.

### 6.2 `HandoffTransaction`

```text
handoff_id
schema_version
task_id
source_session_id
target_session_id?
parent_session_ref
checkpoint_id
checkpoint_digest
state
idempotency_key
latch_generation
created_at
updated_at
commit_intent_event_id?
commit_applied_event_id?
prompt_armed_event_id?
prompt_sent_event_id?
failure?
```

Gli stati sono quelli congelati nell'ADR. Il journal è append-only; la projection `state` deriva dall'ultimo evento valido.

Invarianti:

- `HANDOFF_ARMED` richiede checkpoint candidato valido, Git coerente, budget sufficiente e latch rilasciato alla generation registrata.
- `HANDOFF_COMMIT` crea al massimo una target session per idempotency key.
- `NEW_SESSION_PAUSED` precede sempre continuity/prompt.
- `PROMPT_SENT` al massimo una volta per target/checkpoint digest.
- Takeover concorrente prevale e impedisce `PROMPT_ARMED`.

## 7. Ownership dei contratti

| Contratto | Producer principale | Consumer | Owner semantico |
|---|---|---|---|
| EventEnvelope | Tutti | Tutti | Contratti comuni futuri; copia locale congelata M0.1 |
| CheckpointSpec | FARO/utente standalone | Durex/Guardian | FARO Governance futuro; subset standalone Aiopago |
| RunContext | Durex/runner | Guardian | Durex |
| RunEvent | Durex/Guardian | FARO/Alfred | Producer per payload, envelope comune |
| CandidateCheckpoint | Guardian | FARO/Durex/utente | Aiopago |
| CheckpointDecision | FARO/umano | Guardian/Durex/GitHub adapter | FARO Governance |
| EvidenceReference | Producer/Raiatea | Guardian/FARO | Raiatea per provenance generale; producer per artefatto |

Nessun contratto autorizza Aiopago a implementare queue durevole, worker lease, backlog globale, GitHub writes, metodologia, acceptance globale o repository generale delle evidenze.

## 8. Conformance rinviata a M1

M1 deve aggiungere, senza cambiare queste semantiche:

1. JSON Schema/versioni per i contratti usati nel vertical slice.
2. Fixture valide e invalide.
3. Test digest/immutabilità/parent DAG.
4. Test idempotency e conflict detection.
5. Test secret redaction e unknown handling.
6. Round-trip projection senza scrittura inversa.
7. Test che `VERIFIED` non venga presentato come `ACCEPTED`.

Contratti Durex/FARO/Raiatea completi e test cross-repository restano futuri; M1 implementa solo il subset standalone necessario.
