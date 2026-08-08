# M1-H2 — Handoff Threshold Calibration

## Stato e perimetro

`H2-01 Measurement instrumentation` è implementato. `H2-02 Controlled calibration` resta **PLANNED**: non sono stati eseguiti esperimenti 40/50/60 e la soglia operativa H1 non è stata cambiata.

Obiettivo futuro: misurare **Cost per Accepted Checkpoint** con vincolo **Quality >= baseline**. H2-01 raccoglie i dati; non definisce una soglia ottimale né un Quality Score composito.

## Schema metriche

Schema applicativo: `eiopago.metrics/1.0.0` (`schema_version = 1.0.0`).

### SessionMetrics

Una summary per sessione contiene:

- `session_id`, `runner_instance_id`, `task_id`, `item_id`, `checkpoint_id`, `handoff_id` quando noti;
- `started_at`, `ended_at`, `duration_ms` e motivo lifecycle;
- `model_calls` e totali input/output/reasoning/cache-read/cache-write;
- ultimo context `{tokens, context_window, occupancy_percent, status}`;
- costo equivalente Pi separato da charged/provider e subscription cost;
- associazioni qualità inizialmente `null`: acceptance, review findings, test failures, regressions, rework e FIX_REQUIRED.

### MetricSample

Uno snapshot per `turn_end` assistant osservato contiene identità/correlazione, timestamp del messaggio e timestamp di cattura, indice call, modello, context runtime, usage normalizzata Pi e le tre semantiche di costo. Un valore non esposto è sempre `null` con status `unknown`; zero è registrato soltanto se la superficie autorevole espone realmente zero.

Il conteggio call riguarda le call terminali osservate mentre H2 è attiva. Non viene fatto backfill leggendo conversation history su reload.

### HandoffMetricEvent

Eventi misurati: `SUGGESTED`, `PREPARED`, `STARTED`, `CHECKPOINT_SEALED`, `REPLACEMENT_STARTED`, `RESUME_READY`, `RESUME_STARTED`, `COMPLETED`. Ogni record include soglia configurata al momento dell'evento, motivo, correlazione nota, tempi monotoni locali disponibili e dimensioni esatte disponibili.

`minimal_reads_declared_count` è il numero di path sealed nel manifest. `minimal_reads_count` resta `null`: Pi 0.83.0 non espone una superficie autorevole che attesti le letture di continuity realmente eseguite. I due concetti non vengono confusi.

## Superfici Pi/runtime 0.83.0

| Metrica | Source | Authoritative? | Availability | Note |
|---|---|---:|---|---|
| Session identity | `ctx.sessionManager.getSessionId()` | Sì, runtime Pi | Available | Nessun parsing UI/JSONL |
| Session start/end | `session_start` / `session_shutdown` | Sì, evento runtime | Available quando l'evento è osservato | Durata locale tra ricezione eventi |
| Task/item | `TaskLedger.read()` | Sì, Ledger Eiopago | Available | Snapshot al momento dell'evento |
| Checkpoint/handoff | relazione SQLite Eiopago source/target | Sì, runtime Eiopago | Available quando la relazione esiste | Prima dell'handoff può essere unknown |
| Context occupancy | `ctx.getContextUsage()` | Sì come stima runtime Pi | Condizionale | Pi usa usage recente e stima trailing messages; dopo compaction può restituire token/percent null |
| Input/output/cache tokens | `turn_end.message.usage` | Sì, usage normalizzata Pi/provider | Available per assistant terminale | Nessuna lettura/parsing della UI |
| Reasoning tokens | `turn_end.message.usage.reasoning` | Sì quando il provider lo espone | Condizionale | È subset dell'output; undefined diventa null |
| Model calls | un `MetricSample` persistito per assistant `turn_end` | Sì per il periodo osservato | Available | Failure di persistenza non incrementa falsamente la summary |
| Cache hit / hit rate | Nessuna API esplicita | No | Unknown | La UI deriva un rapporto; H2 non ne parsa né replica la stringa |
| Pi equivalent cost | `turn_end.message.usage.cost.total` | Sì per il calcolo Pi | Condizionale | USD model-catalog equivalent; **non** prova un addebito provider |
| Charged/provider cost | Non esposto da Pi | No | Unknown | Nessuna dipendenza billing |
| Subscription-equivalent cost | Non esposto da Pi | No | Unknown | Nessuna stima introdotta |
| Artifact bytes | `fs.statSync(TASK_PLAN.md).size`, byte buffer sealed, `Buffer.byteLength` | Sì, misura locale diretta | Available quando l'artefatto esiste | Nessuna stima e nessuna history letta |
| Continuity/resume time | `performance.now()` intorno alle operazioni locali | Sì per elapsed locale | Available nel processo corrente | Non è latenza di billing/provider |
| Minimal reads osservate | Nessuna API Pi autorevole | No | Unknown | Separato dal count dichiarato nel manifest |
| Quality/rework | Associazione futura | Non ancora | Unknown | Campi null, nessun Quality Score inventato |

`AgentSession.getSessionStats()` esiste nel runtime Pi e aggrega token/costo scorrendo tutte le entry, ma H2 usa l'evento per-call `turn_end.message.usage`: conserva granularità sperimentale, include `reasoning` quando presente e non richiede di importare conversation history nei record.

## Storage e autorità

Non è stato creato un nuovo database. Lo SQLite esistente `.guardian/runtime/guardian.sqlite` contiene:

- `metric_sessions`: summary bounded;
- `metric_samples`: sample per call bounded;
- `metric_handoff_events`: misure handoff bounded;
- `metric_diagnostics`: failure di raccolta bounded.

Il `journal` esistente resta l'autorità append-only del lifecycle **operativo** H1. `metric_handoff_events` è autorità soltanto per misure/tempi/soglia/overhead e non guida transizioni, latch, admission o dispatch. Checkpoint e manifest sealed restano autorevoli per i propri byte/contenuti; SQLite ne conserva l'indice.

Retention default globale:

- 100 session summary;
- 2.000 sample call;
- 1.000 eventi handoff metrici;
- 100 diagnostici.

I limiti sono configurabili dal costruttore Runner/test e validati come interi positivi. L'eliminazione dei sample non altera i totali già consolidati nella session summary. La failure di telemetry viene assorbita: non cambia il comportamento H1, non sostituisce valori con zero e tenta un diagnostico minimale senza testo sensibile; se anche il diagnostico non è persistibile, viene emesso soltanto un messaggio locale generico.

## Privacy e limiti

I record sono costruiti con allowlist e rifiutano chiavi conversation/history/messages/prompt/response/content/transcript. Non vengono salvati prompt completi, response complete, tool output o conversation history. Il resume prompt non viene salvato nelle metriche: viene registrata soltanto la sua lunghezza UTF-8.

Limiti prima di H2-02:

- acceptance/review/rework devono essere associati ai run di calibrazione;
- serve un protocollo controllato con baseline qualità e workload comparabile;
- charged cost, subscription cost, cache-hit rate e reads realmente osservate restano unknown;
- nessuna soglia può essere scelta finché non esistono run accettati sufficienti.
