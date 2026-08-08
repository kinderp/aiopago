# Master Task Ledger — M1-H2 Handoff Threshold Calibration

**Authority:** Markdown canonico standalone
**Schema:** `eiopago.task-ledger/0.1.0`
**Current revision:** `PLAN-M1-H2-0002`
**Requirements version:** `REQ-M1-H2-ISSUE-9-H2-01-2026-08-08`
**Updated:** 2026-08-08T17:50:44.192Z

```json task-ledger
{
  "schema_version": "0.1.0",
  "task_id": "TASK-EIOPAGO-M1-H2",
  "title": "Handoff Threshold Calibration",
  "objective": "Rendere scientificamente affidabile la raccolta provider-neutral necessaria a misurare in H2-02 Cost per Accepted Checkpoint con Quality almeno pari alla baseline, senza cambiare ancora le soglie operative.",
  "requirements_version": "REQ-M1-H2-ISSUE-9-H2-01-2026-08-08",
  "plan_revision_id": "PLAN-M1-H2-0002",
  "status": "IN_PROGRESS",
  "completion_criteria": [
    "H2-01 raccoglie automaticamente le metriche runtime realmente disponibili e usa null/unknown per le altre",
    "Schema metriche versionato, provider-neutral, correlato e senza conversation history",
    "Persistenza bounded nello SQLite esistente e failure di telemetry non falsificante",
    "Lifecycle e overhead handoff misurabili senza cambiare il comportamento M1-H1",
    "Superfici Pi 0.83.0 e autorità storage documentate",
    "H2-02 resta PLANNED senza esperimenti o modifica soglie"
  ],
  "risk": "HIGH",
  "created_at": "2026-08-08T16:45:00Z",
  "updated_at": "2026-08-08T17:50:44.192Z",
  "current_item": null,
  "next_item": "ITEM-H2-02",
  "next_step": "STOP: H2-01 è completato; non avviare H2-02, dogfood 40/50/60 o modifica soglie senza nuova autorizzazione esplicita.",
  "evidence": [
    "Baseline M1-H1 accettata b317f79c9723136203e24d216467ef80601cb64a preservata e non rifatta",
    "src/metrics.mjs e migrazione SQLite v3 implementano SessionMetrics, MetricSample, HandoffMetricEvent e diagnostici bounded",
    "Pi 0.83.0: session lifecycle, turn_end.message.usage e ctx.getContextUsage ispezionati sulle API/tipi installati",
    "Test H2 deterministici coprono complete/unknown/correlazione/call/lifecycle/threshold/byte/privacy/retention/failure",
    "E2E Pi reale/provider fake preserva ownership, continuity, paused/no-history e resume idempotente M1-H1",
    "docs/m1-h2-threshold-calibration.md documenta schema, semantiche costo, fonti e unknown"
  ],
  "model_policy": "openai-codex/gpt-5.6-sol",
  "reasoning_policy": "high",
  "checkpoint_policy": "measurement_before_calibration",
  "minimal_reads": [
    "TASK_PLAN.md",
    "CHECKPOINT.md",
    "docs/m1-h1-context-handoff-advisor.md",
    "docs/m1-h2-threshold-calibration.md"
  ],
  "accepted_prerequisite": {
    "milestone": "M1-H1",
    "status": "ACCEPTED_PASS",
    "baseline": "b317f79c9723136203e24d216467ef80601cb64a",
    "note": "Stato storico accettato invariato; H1 non è stato rieseguito come task."
  },
  "task_items": [
    {
      "task_item_id": "ITEM-H2-01",
      "task_id": "TASK-EIOPAGO-M1-H2",
      "title": "Measurement instrumentation",
      "description": "Raccogliere sample per model call, summary sessione ed eventi handoff correlati, versionati, bounded e privacy-safe usando soltanto superfici runtime autorevoli.",
      "status": "DONE",
      "depends_on": [],
      "completion_criteria": [
        "Metriche disponibili automatiche e unavailable esplicitamente null/unknown",
        "Session/task/item/checkpoint/handoff correlati quando noti",
        "Conteggio call, lifecycle, threshold e byte artefatti misurati",
        "Charged, equivalent e subscription cost semanticamente distinti",
        "Quality/rework predisposti senza score inventato",
        "Retention bounded e diagnostici bounded senza dati falsi",
        "Nessuna conversation history nei record",
        "Test H2 e regressioni H1 verdi"
      ],
      "evidence": [
        "src/metrics.mjs",
        "src/storage.mjs schema migration 3",
        "src/extension.mjs e src/handoff.mjs instrumentation non decisionale",
        "test/metrics.test.mjs",
        "test/pi-e2e.test.mjs measurement assertions e regressioni H1",
        "docs/m1-h2-threshold-calibration.md",
        "Final gates: H2 targeted 7/7; npm run check 20 modules; npm test 29/29 (22 top-level, E2E 6/6); git diff --check PASS"
      ],
      "requirements_refs": [
        "GitHub issue #9",
        "H2-01 Measurement Instrumentation"
      ],
      "risk": "MEDIUM",
      "milestone": "M1-H2",
      "last_updated_at": "2026-08-08T17:50:44.192Z",
      "last_updated_by": "Pi session 019fe274-fad4-7778-8553-8792b21f9590"
    },
    {
      "task_item_id": "ITEM-H2-02",
      "task_id": "TASK-EIOPAGO-M1-H2",
      "title": "Controlled calibration",
      "description": "Eseguire in una sessione futura autorizzata esperimenti controllati e confrontare Cost per Accepted Checkpoint con Quality almeno baseline.",
      "status": "PLANNED",
      "depends_on": [
        "ITEM-H2-01"
      ],
      "completion_criteria": [
        "Protocollo controllato autorizzato",
        "Run comparabili con acceptance e quality baseline associate",
        "Analisi senza confondere equivalent cost e charged cost"
      ],
      "evidence": [],
      "requirements_refs": [
        "GitHub issue #9",
        "H2-02 Controlled Calibration"
      ],
      "risk": "HIGH",
      "milestone": "M1-H2",
      "last_updated_at": "2026-08-08T17:50:44.192Z",
      "last_updated_by": "Pi session 019fe274-fad4-7778-8553-8792b21f9590"
    }
  ]
}
```

## Regole di avanzamento

- M1-H1 resta accettata e non viene modificata retroattivamente.
- H2-02 richiede una nuova autorizzazione esplicita.
- Nessuna soglia ottimale è dichiarata in H2-01.
- Cost Guard, auto-handoff, supervised-auto, routing e integrazioni esterne restano fuori scope.
