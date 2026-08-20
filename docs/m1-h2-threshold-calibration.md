> **Historical pre-rename record.** Names, identifiers, commands, repository/worktree paths and measured protocol references below are retained as immutable provenance. The current product is Aiopago; use `docs/portable-alpha.md` for canonical `aio` usage and `docs/rename-aiopago-migration.md` for compatibility.

# M1-H2 — Controlled Handoff Threshold Calibration

> **F4 feasibility update:** `6847c5cbf260ed4074e5f3846b130ed3e1ad3da3`
> is the H2-02B F2/F3 infrastructure baseline, not a runnable experiment
> baseline. The inspector protocol below is retained as historical design: its
> observed workload ended below 40% and is not authorized for another pilot.
> Issue #14 selects the frozen-ready successor proposal
> `WL-DEVELOPMENT-CHRONICLE-1` in
> [`m1-h2-workload-feasibility.md`](m1-h2-workload-feasibility.md). A later
> accepted successor commit must update and freeze the machine-readable
> protocol before any RUN-40/50/60 worktree is created.

## Stato e vincoli

`H2-01 Measurement instrumentation` è la **application baseline** immutabile
`930fc35d03d3f9795fa6402a047b0ded489e2817`. Il freeze H2-02A precedente era
`d6a4b9cfa1e3c15cc0c9ea9ad9ead89216346254`; il futuro experiment baseline del
pilot deve essere il commit di acceptance **H2-02A-F1** che contiene protocollo
e launcher deterministico. Il suo SHA viene passato esplicitamente al launcher
e registrato nei run record, senza riscrivere il manifest e creare una
dipendenza circolare. Tutti i branch pilot dovranno avere quell'unico commit
come parent iniziale. Il pilot `H2-02B` resta **PLANNED/BLOCKED** dall'acceptance
F1 e il default globale resta 50%.

Sono fuori scope Cost Guard, Advisor adattivo, auto-handoff, routing, provider
esterni e qualsiasi modifica alla logica/default delle soglie.

Protocollo machine-readable canonico: `docs/m1-h2-calibration-pilot.json`,
`protocol_id=H2-02A-PILOT-1`, SHA-256 corrente
`0af31e2ee41061c153d1e7c4cfaaf098db44f58ee41f15333b31b8afeb8bd2c1`. Il
manifest dichiara separatamente `application_baseline_commit` e
`experiment_baseline_commit=null`: quest'ultimo è intenzionalmente valorizzato
soltanto nell'attestation/run record con lo SHA del commit F1 che congela
questi byte.

## Domanda sperimentale e pilot

Il pilot confronta 40%, 50% e 60% sul medesimo workload. La sola variabile
intenzionalmente manipolata è `EIO_CONTEXT_HANDOFF_THRESHOLD_PERCENT`, impostata
dal launcher nell'ambiente del singolo processo Runner e duplicata come opzione
SDK verificata. L'esito riguarda questo workload,
questo modello e questa versione Pi; non dimostra una soglia universale.

Primo ciclo, senza repliche aggiuntive preventive:

- RUN-40: 40% x1;
- RUN-50: 50% x1;
- RUN-60: 60% x1.

## Workload: Read-only Handoff Incident Inspector

Il workload `WL-HANDOFF-INCIDENT-INSPECTOR-1` aggiunge uno strumento locale,
read-only, deterministico e privacy-safe per diagnosticare incidenti del
lifecycle handoff. È utile perché oggi Eiopago conserva autorità, artefatti e
istruzioni fail-closed, ma non possiede un inspector che li confronti e produca
una classificazione stabile. Lo strumento diagnostica: non ripara, non riprende
sessioni e non implementa crash recovery unattended.

Deliverable fissi:

- `src/handoff-inspector.mjs`;
- `bin/eio-inspect.mjs`;
- `test/handoff-inspector.test.mjs`;
- `docs/handoff-incident-inspector.md`;
- `docs/reviews/handoff-incident-inspector-review.md`;
- export in `src/index.mjs` e script `npm run inspect`.

Il contratto completo, le classificazioni, la matrice test e il prompt esatto
sono nel manifest. In sintesi l'inspector deve correlare, senza mutarli, SQLite,
journal, latch, binding, indice/byte degli artefatti sealed e soli header di
lineage Pi disponibili; produrre JSON versionato byte-stabile; classificare
`CONSISTENT_TERMINAL`, `PAUSED_RECOVERABLE`, `FAIL_CLOSED` o `AMBIGUOUS`; e non
raccomandare mai retry/resume automatico quando un'autorità è ignota o
incoerente.

### Checkpoint workload predefiniti

1. `WCP-1 contract-and-core` — contratto, adapter read-only, validazioni,
   classificazione e report stabile;
2. `WCP-2 cli-and-integration` — CLI, export e package integration;
3. `WCP-3 tests-and-documentation` — fixture offline e documentazione; stop
   esatto `READY_FOR_COLD_REVIEW`;
4. `WCP-4 cold-review-and-fix` — nuova sessione senza history, review
   requirement-by-requirement, fix dei finding bloccanti; stop esatto
   `READY_FOR_ACCEPTANCE`.

La sessione di cold review è obbligatoria e identica nei tre run. Viene avviata
come nuova sessione Runner, non come clone/fork, senza trasferire history e con
lo stesso prompt canonico. Le sessioni create dall'Advisor restano invece parte
dell'effetto sperimentale.

### Perché è comparabile

Il workload è congelato in un file con digest, usa solo il repository e fixture
temporanee locali, ha deliverable e acceptance fissi e non dipende da servizi o
dati mutevoli. Ogni variante parte dallo stesso tree e riceve lo stesso prompt
UTF-8 (SHA-256
`d89957e5c3ccae4ad4ac57b5458fc7d45044cb1e8e22da1f4da2b7c22299af58`). I
risultati implementativi possono variare per la naturale non-deterministicità
del modello: questa è varianza sperimentale, non una variabile modificata
dall'operatore.

Il lavoro richiede analisi trasversale di storage, journal, artefatti, lineage,
privacy, CLI, fixture, documentazione e una review fredda. È quindi
ragionevolmente articolato, senza padding. **Non è però possibile garantire**
che una sessione di un modello efficiente occupi il 60% di 272k token. Per
questo l'esposizione effettiva alla soglia è un gate di validità, non
un'assunzione.

## Variabili controllate

Devono restare identiche per tutti i run:

| Variabile | Valore/regola |
|---|---|
| Application baseline | `930fc35d03d3f9795fa6402a047b0ded489e2817` |
| Experiment baseline | stesso commit di freeze H2-02A per tutti i branch; SHA nel run record |
| Workload | `WL-HANDOFF-INCIDENT-INSPECTOR-1`, stesso manifest/digest |
| Prompt | stesso `workload_prompt` e digest; nessuna guida discrezionale |
| Provider/model | `openai-codex/gpt-5.6-sol` |
| Reasoning | `high` |
| Pi | `0.83.0` |
| Node | `v22.19.0` |
| Acceptance | i quattro comandi, nello stesso ordine |
| Confirm | consenso Advisor sì, invio immediato di `/eio handoff confirm`, conferma resume sì |
| Completion | 4 WCP accettati, marker `READY_FOR_ACCEPTANCE`, quality baseline PASS |
| History | nessuna conversation history copiata; replacement da manifest/minimal reads |
| Runner | compaction e retry disabilitati come in H2-01 |
| Rete | nessun servizio esterno; i test bloccano `fetch` |
| Operatore | solo azioni e messaggi previsti; nessun suggerimento/correzione manuale |

Non sono controllabili seed/temperature non esposti e latenza del provider.
Versione, orari ed errori provider vengono registrati; un cambio di modello o
un errore provider invalida il run.

## Worktree, branch e bootstrap F1

Da PowerShell, dopo l'acceptance/commit F1, assegnare lo SHA completo del commit
appena creato a `EXPERIMENT_BASELINE_COMMIT`. Non usare direttamente 930fc35 o
il freeze precedente d6a4b9c: restano rispettivamente baseline applicativa e
baseline sperimentale precedente, non eseguibile dopo il finding F1.

```powershell
$EXPERIMENT_BASELINE_COMMIT='<SHA_DEL_COMMIT_FREEZE_H2-02A-F1>'
git -C F:/dev/eiopago-m1-h2 worktree add -b calibration/h2-02b-run-40 F:/dev/eiopago-h2-run-40 $EXPERIMENT_BASELINE_COMMIT
git -C F:/dev/eiopago-m1-h2 worktree add -b calibration/h2-02b-run-50 F:/dev/eiopago-h2-run-50 $EXPERIMENT_BASELINE_COMMIT
git -C F:/dev/eiopago-m1-h2 worktree add -b calibration/h2-02b-run-60 F:/dev/eiopago-h2-run-60 $EXPERIMENT_BASELINE_COMMIT
```

La copia manuale e il controllo manuale dell'assenza di SQLite sono sostituiti
da `scripts/calibration-run.mjs`. Il launcher esegue prima del Runner processi
Git locali, legge la versione package Pi installata, valida i byte JSON e il
prompt, crea un `run_id` UUID, riserva atomicamente la directory ignored e
materializza:

```text
.guardian/calibration/pilot-protocol.json  # copia compatibile col prompt frozen
.guardian/calibration/<run_id>/
  pilot-protocol.json                      # source of truth run-specific
  preflight-attestation.json
  run-record.json
  runtime/guardian.sqlite                  # creato dopo il PASS dal Runner
```

`pilot-protocol.json` deve essere byte-identico sia al source sia al blob Git
dell'experiment baseline. L'attestation usa schema
`eiopago.calibration-preflight/1.0.0`; contiene identità run/experiment/workload,
baseline, branch/worktree/clean status, versioni, digest protocollo/prompt,
threshold requested/effective, provider/model/reasoning, confirm e identità/path
dello store, senza prompt o history. Il run record nasce con
`status=PREFLIGHT_PASSED`. Qualsiasi mismatch produce FAIL/INVALID e nessun
Runner/provider/workload.

## Procedura esatta dei run

I pilot si eseguono in ordine RUN-40, RUN-50, RUN-60 e, per quanto possibile,
nella stessa finestra senza aggiornare Pi/Node/repository.

### Preflight comune

Il launcher verifica deterministicamente, prima del Runner: root/path worktree,
HEAD completo passato dall'operatore, branch e path congelati nel manifest,
`git status --porcelain` vuoto, Pi/Node, source JSON valido, identità byte del
blob Git, digest completi di protocollo e prompt, threshold della variante e
unicità del `run_id`. Il launcher stesso imposta
`EIO_CONTEXT_HANDOFF_THRESHOLD_PERCENT` e passa la stessa threshold come opzione
SDK al Runner: il testo del prompt non è autorità.

Il criterio precedente “`.guardian/runtime/guardian.sqlite` assente dopo il
Runner” era errato ed è rimosso. `GuardianStorage` supportava già un path
configurabile; F1 lo usa per uno SQLite esclusivo sotto il `run_id`. Prima
dell'apertura il path non esiste; all'apertura viene persistita una tupla
`run_id/runtime_store_id/attestation_sha256`. Uno store preesistente,
contaminato o con identità diversa fallisce chiuso. Nessun runtime esistente
viene cancellato.

Pi 0.83.0 viene fissato tramite SDK pubblica: il launcher risolve il modello con
`ModelRuntime.getModel()`, lo passa a `createAgentSessionFromServices`, passa
`thinkingLevel`, poi verifica `AgentSession.model` e
`AgentSession.thinkingLevel`. Il transport gate ripete il controllo prima di
ogni provider stream; non viene parsato footer/UI. Confirm è l'opzione Runner
esplicita `confirm`: in calibrazione il percorso `manual` è rifiutato e lo
stato viene confrontato con l'attestation.

### Comando futuro RUN-40

Soltanto dopo acceptance F1 e autorizzazione H2-02B:

```powershell
Set-Location F:/dev/eiopago-h2-run-40
npm run calibration -- --variant RUN-40 --experiment-baseline $EXPERIMENT_BASELINE_COMMIT
```

Il comando genera il `run_id`; non accetta una threshold discrezionale. Per la
cold review si riusa esclusivamente l'identità stampata dal primo lancio:

```powershell
npm run calibration -- --resume-run <run_id>
```

La ripresa ricontrolla attestation, protocollo, HEAD/branch, store identity,
threshold, model, reasoning e confirm, ma non pretende un worktree clean dopo
il lavoro previsto. In ciascun TUI l'operatore incolla esattamente
`workload_prompt` dal manifest.
La prima attività sostanziale deve rendere `TASK_PLAN.md` un Ledger workload
valido e aggiungere `.guardian/calibration/pilot-protocol.json` ai
`minimal_reads`. Un handoff avvenuto prima di questa persistenza rende il run
invalido, perché la ripresa non avrebbe una specifica sealed sufficiente.

Quando l'Advisor propone il passaggio, l'operatore esegue sempre e subito:

1. conferma **sì** a “Preparare il passaggio”;
2. invio del comando precompilato `/eio handoff confirm`, senza editarlo;
3. conferma **sì** alla singola resume admission;
4. nessun altro testo, riassunto o history incollato.

Al marker `READY_FOR_COLD_REVIEW` si chiude ordinatamente il Runner, si registra
la sessione e si usa `npm run calibration -- --resume-run <run_id>` nello stesso
worktree. Il launcher ripristina e verifica la stessa soglia process-local e lo
stesso store isolato. Deve risultare un nuovo session ID senza conversation
history; si incolla lo stesso `workload_prompt`. Anche durante la review si
applica lo stesso comportamento Advisor/confirm.

Al marker `READY_FOR_ACCEPTANCE`, l'operatore esegue, in un terminale locale e
nell'ordine fissato:

```text
npm run check
node --test --test-concurrency=1 test/handoff-inspector.test.mjs
npm test
git diff --check
```

Se un gate fallisce, si registra l'output e si fornisce al modello soltanto
l'output macchina necessario alla correzione, senza suggerimenti. Ogni ciclo
failure→fix→rerun incrementa `rework_cycles`. Si ripete l'intero ordine dei gate.
Il run termina alla decisione finale di acceptance e alla chiusura ordinata del
Runner; non si crea un commit prima della cattura delle metriche.

## Finding RUN-40 attempt 1

`RUN-40-ATTEMPT-1 = INVALID_PREFLIGHT`. È stato fermato prima del workload:
il protocollo ignored non era stato materializzato prima del Runner, il test di
assenza SQLite veniva eseguito dopo che il Runner lo aveva inizializzato e
Git/model/reasoning/confirm/digest non erano attestabili dalla sessione. Il
fail-closed osservato è corretto. Questo tentativo **non è una replica
sperimentale**, non va ripreso e non può essere trasformato retroattivamente in
VALID.

## Validità

### VALID RUN

Un run è `VALID` soltanto se tutte le condizioni seguenti sono vere:

- application baseline, experiment baseline, protocollo, prompt, ambiente e azioni operatore sono conformi;
- almeno un sample autorevole della stessa sessione mostra occupancy non-null
  alla/sopra la soglia configurata e sono presenti gli eventi correlati
  `SUGGESTED`, `PREPARED`, `STARTED` e `COMPLETED`;
- ogni handoff usa confirm, ha Continuity PASS, target no-history e nessuna
  copia manuale di contesto;
- telemetry essenziale è completa per tutte le sessioni/call e non contiene
  diagnostici di raccolta non risolti;
- il task arriva al criterio di completamento, i quattro WCP sono accettati e
  la quality baseline finale è PASS; il rework eventuale è registrato.

Il contesto effettivo di handoff è il sample `MetricSample.context` della call
che ha prodotto `SUGGESTED`, correlato per sessione e timestamp; non è la soglia
nominale e non va sostituito con essa.

### CENSORED RUN

Un run conforme che completa workload e quality baseline prima che una sessione
raggiunga la soglia è `CENSORED_EARLY_COMPLETION`. Non è un fallimento del task,
ma **non misura** l'intervento a quella soglia e non entra nel confronto del
costo per scegliere la soglia. Si conservano i dati come evidenza di
insufficiente esposizione del workload. Non si aggiunge lavoro o testo per
forzare la soglia.

### INVALID RUN

È `INVALID` (con reason code) se si verifica almeno uno dei seguenti casi:

- commit/tree iniziale errato, protocollo o workload modificato manualmente;
- modello, provider, reasoning, Pi o acceptance suite diversi;
- errore provider, retry/compaction inatteso o servizio esterno;
- handoff manuale anticipato, proposta rifiutata, conferma ritardata con altro
  lavoro, o modalità diversa da confirm;
- prompt/riassunto/history copiati manualmente o sessione di review non pulita;
- telemetry essenziale mancante, context del crossing unknown, lifecycle non
  correlabile o diagnostic collection failure;
- test/review finali non conformi, task incompleto o finding bloccante aperto.

I run invalidi non vengono “riparati” cambiando il record. Un nuovo tentativo è
una replica distinta, autorizzata dopo il pilot.

## Dati da registrare

Per ogni run il record machine-readable deve includere almeno:

- run ID, threshold, application/experiment baseline commit, protocol digest, branch/worktree;
- provider/model/reasoning, Pi/Node, modalità confirm;
- tutti i session ID, distinguendo handoff replacement e cold-review session;
- context sample per call e crossing effettivi;
- input/output/reasoning/cache-read/cache-write, model calls;
- charged cost e Pi equivalent cost come campi separati;
- handoff count, context effettivo, tempi e byte overhead;
- start/end/durata;
- ogni tentativo test, failure, finding review, regressione e ciclo di rework;
- WCP accettati, acceptance finale, classificazione VALID/CENSORED/INVALID e
  reason code;
- Total Run Cost e Cost per Accepted Checkpoint, senza contenuti conversazionali.

Lo SQLite e gli artefatti `.guardian` restano evidenza locale. Nel record si
salvano identità, aggregati e digest, non JSONL di conversazione.

## Aggregazioni predefinite

Sia `S_r` l'insieme delle sessioni del run (implementazione, replacement e cold
review) e `H_r` l'insieme degli handoff Advisor completati. Una somma è nota
solo se tutti gli addendi richiesti sono disponibili; altrimenti è `unknown`,
non zero.

- **Token Input/Output/Reasoning** = somma del rispettivo totale su `S_r`.
  Reasoning resta parte dell'output e viene anche riportato separatamente: non
  viene sommato una seconda volta nel volume output.
- **Cache Read Total** = `Σ session.totals.cache_read_tokens` su `S_r`.
- **Cache Write Total** = analoga somma cache-write.
- **Calls Total** = `Σ session.model_calls` su `S_r`.
- **Total Run Cost (charged)** = `Σ charged_provider_cost_s` solo se il charged
  cost è disponibile per tutte le sessioni; altrimenti `unknown`.
- **Total Run Cost (equivalent)** = `Σ equivalent_cost_usd_s` solo se tutti i
  valori equivalent sono disponibili. È un model-catalog equivalent Pi, non un
  addebito.
- **Completion Time** = `run_ended_at - run_started_at`, dal primo
  `session_start` alla decisione finale di acceptance. Include attesa umana;
  l'operatore deve confermare subito e questa limitazione va dichiarata.
- **Rework** = numero di cicli distinti avviati da un gate fallito o finding
  bloccante e conclusi da una modifica. Si registrano anche file toccati e gate
  che l'ha causato; non si usa un punteggio pesato.
- **Accepted Checkpoints (`A_r`)** = conteggio dei soli WCP-1..WCP-4 che
  soddisfano il criterio predefinito. Un run eleggibile deve avere `A_r=4`.
- **Cost per Accepted Checkpoint (charged)** = `TotalRunCost_charged / A_r`;
  **equivalent** = `TotalRunCost_equivalent / A_r`. Con `A_r=0` o costo unknown
  il risultato è `not_applicable/unknown`. Le due semantiche non si mescolano.

### Handoff Overhead

Non viene inventato un singolo score. Per ogni run è il vettore:

- `handoff_duration_ms = Σ COMPLETED.duration_ms` su `H_r`;
- `continuity_duration_ms` e `resume_duration_ms`: somme separate degli eventi;
- `artifact_bytes = Σ(task_plan_bytes + checkpoint_sealed_bytes +
  manifest_bytes + resume_prompt_bytes)` prendendo una sola misura completa per
  handoff;
- `minimal_reads_declared_total`: somma dichiarata, distinta dalle reads
  effettive che restano unknown;
- `handoff_token_overhead` e `handoff_cost_overhead`: `unknown` con H2-01,
  perché la call di resume contiene anche lavoro utile e non è attribuibile in
  modo autorevole al solo control-plane.

## Quality baseline

Nessun Quality Score composito. Una soglia è eleggibile soltanto se:

- i quattro comandi di acceptance sono PASS;
- nessuna regressione della suite esistente;
- WCP-1..WCP-4 completi con evidenza;
- report di cold review presente, nessun finding bloccante aperto;
- nessuna perdita di stato/lineage e nessuna history copiata;
- rework e test failure integralmente registrati.

Una variante più economica che non soddisfa questi criteri non può vincere. Fra
run validi e a qualità equivalente si confrontano costi, tempo, rework e
overhead; non il solo costo.

## Interpretazione dopo il pilot

- Differenze nette con qualità equivalente: formulare un'ipotesi locale sulla
  soglia, riportando i tre record e i limiti; non cambiare automaticamente il
  default.
- Risultati vicini, rumorosi, censored o con rework molto diverso: proporre solo
  repliche mirate delle varianti informative.
- Nessun risultato x1 autorizza universalità, Advisor adattivo o Cost Guard.

## Telemetry prima del pilot

Non è necessario cambiare la logica H2-01 per avviare il pilot: sample, token,
cache, equivalent cost, sessioni ed eventi/tempi/byte handoff sono già raccolti.
Il run record esterno deve però integrare deterministicamente dati che H2-01
lascia intenzionalmente `null`: commit/versioni preflight, acceptance, review,
rework, regressioni e charged cost.

Prima di un nuovo RUN-40 sono quindi obbligatori: acceptance/commit F1,
worktree creato da quel commit e PASS reale del launcher. Attestation, run
record e isolamento/identità SQLite sono ora prodotti dal bootstrap minimo;
non costituiscono un orchestratore generale. Charged/provider cost resta `unknown`; non deve essere
sostituito dall'equivalent. Se non si riesce a produrre un record completo senza
modifica telemetry, il pilot resta bloccato e si autorizza separatamente un
collector esterno identico per tutti i run, senza cambiare application o experiment baseline.

## Riferimento H2-01

H2-01 usa schema `eiopago.metrics/1.0.0`, tabelle bounded
`metric_sessions`, `metric_samples`, `metric_handoff_events` e
`metric_diagnostics` nello SQLite Guardian. Le fonti autorevoli sono gli eventi
Pi `session_start`, `session_shutdown`, `turn_end.message.usage`,
`ctx.getContextUsage()` e le autorità locali handoff. Charged cost, subscription
cost, cache-hit rate e minimal reads effettive non sono esposti e restano
`unknown`. Le metriche non salvano prompt, response o conversation history.
