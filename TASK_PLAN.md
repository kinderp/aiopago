# Master Task Ledger — M1-H2 Handoff Threshold Calibration

**Authority:** Markdown canonico standalone
**Schema:** `eiopago.task-ledger/0.1.0`
**Current revision:** `PLAN-M1-H2-0004`
**Requirements version:** `REQ-M1-H2-ISSUE-9-H2-02A-FREEZE-2026-08-08`
**Updated:** 2026-08-08T18:26:14.192Z

```json task-ledger
{
  "schema_version": "0.1.0",
  "task_id": "TASK-EIOPAGO-M1-H2",
  "title": "Handoff Threshold Calibration",
  "objective": "Confrontare in modo riproducibile soglie handoff 40/50/60 rispetto a Cost per Accepted Checkpoint e quality baseline, separando costi charged ed equivalent e senza cambiare il default globale.",
  "requirements_version": "REQ-M1-H2-ISSUE-9-H2-02A-FREEZE-2026-08-08",
  "plan_revision_id": "PLAN-M1-H2-0004",
  "status": "IN_PROGRESS",
  "completion_criteria": [
    "H2-01 telemetry resta la application baseline immutabile 930fc35d03d3f9795fa6402a047b0ded489e2817",
    "H2-02A definisce e congela workload, controlled variables, validità, quality baseline e formule prima degli esperimenti",
    "H2-02B esegue soltanto dopo nuova autorizzazione il pilot 40x1/50x1/60x1 da tre branch aventi lo stesso experiment baseline commit H2-02A",
    "Nessuna soglia vincente è scelta solo per costo e nessuna conclusione x1 viene dichiarata universale",
    "Cost Guard, Advisor adattivo e modifica del default globale restano fuori scope"
  ],
  "risk": "HIGH",
  "created_at": "2026-08-08T16:45:00Z",
  "updated_at": "2026-08-08T18:26:14.192Z",
  "current_item": null,
  "next_item": "ITEM-H2-02B",
  "next_step": "STOP: il commit che contiene PLAN-M1-H2-0004 è l'experiment baseline H2-02A. Registrarene lo SHA nei futuri run record; non creare worktree e non avviare RUN-40/50/60 senza autorizzazione esplicita H2-02B.",
  "evidence": [
    "Application baseline H2-01 930fc35d03d3f9795fa6402a047b0ded489e2817",
    "Experiment baseline definita come il freeze commit contenente questo Ledger e il protocollo, senza SHA circolare nel manifest",
    "docs/m1-h2-threshold-calibration.md",
    "docs/m1-h2-calibration-pilot.json protocol H2-02A-PILOT-1",
    "H2-02A non ha eseguito pilot né cambiato codice/default"
  ],
  "model_policy": "openai-codex/gpt-5.6-sol",
  "reasoning_policy": "high",
  "checkpoint_policy": "controlled_protocol_before_pilot",
  "minimal_reads": [
    "TASK_PLAN.md",
    "CHECKPOINT.md",
    "docs/m1-h1-context-handoff-advisor.md",
    "docs/m1-h2-threshold-calibration.md",
    "docs/m1-h2-calibration-pilot.json"
  ],
  "accepted_prerequisite": {
    "milestone": "H2-01",
    "status": "ACCEPTED_PASS",
    "baseline": "930fc35d03d3f9795fa6402a047b0ded489e2817",
    "note": "Measurement instrumentation accettata e invariata; H2-02A aggiunge soltanto protocollo/documentazione."
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
        "test/metrics.test.mjs",
        "Final gates H2-01: npm run check PASS; npm test 29/29 PASS; git diff --check PASS"
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
      "task_item_id": "ITEM-H2-02A",
      "task_id": "TASK-EIOPAGO-M1-H2",
      "title": "Controlled calibration protocol",
      "description": "Congelare prima degli esperimenti workload, variabili controllate, procedure run, classificazione valid/censored/invalid, metriche, formule e quality baseline.",
      "status": "DONE",
      "depends_on": [
        "ITEM-H2-01"
      ],
      "completion_criteria": [
        "RUN-40/50/60 definiti da un unico experiment baseline commit H2-02A che contiene la application baseline H2-01 e i file di protocollo",
        "Workload reale, offline, non implementato e non Cost Guard con acceptance deterministica",
        "Prompt, modello, reasoning, Pi, confirm, completion e no-history controllati",
        "Valid, censored e invalid run definiti incluso early completion prima soglia",
        "Formule predefinite senza mescolare charged ed equivalent cost",
        "Quality baseline semplice e vincolante, senza Quality Score composito",
        "Pilot limitato a una osservazione per soglia e nessun run eseguito"
      ],
      "evidence": [
        "docs/m1-h2-threshold-calibration.md",
        "docs/m1-h2-calibration-pilot.json schema eiopago.threshold-calibration-protocol/1.0.0",
        "Workload WL-HANDOFF-INCIDENT-INSPECTOR-1 e quattro accepted checkpoints predefiniti",
        "Solo documentazione/protocollo modificati; nessun RUN-40/50/60 avviato"
      ],
      "requirements_refs": [
        "GitHub issue #9",
        "H2-02A Controlled Calibration Protocol"
      ],
      "risk": "MEDIUM",
      "milestone": "M1-H2",
      "last_updated_at": "2026-08-08T18:26:14.192Z",
      "last_updated_by": "Pi session 019fe291-152c-7a16-9b85-7405e964709a"
    },
    {
      "task_item_id": "ITEM-H2-02B",
      "task_id": "TASK-EIOPAGO-M1-H2",
      "title": "Controlled calibration pilot",
      "description": "Eseguire RUN-40 x1, RUN-50 x1 e RUN-60 x1 secondo il protocollo congelato, classificare i run e confrontare soltanto varianti valid/accepted.",
      "status": "PLANNED",
      "depends_on": [
        "ITEM-H2-02A"
      ],
      "completion_criteria": [
        "Protocollo e run-record template presenti nell'experiment baseline commit prima di RUN-40",
        "Tre run avviati dallo stesso experiment baseline commit, con application baseline 930fc35d03d3f9795fa6402a047b0ded489e2817 e unica variabile intenzionale threshold",
        "Telemetry, quality, rework e Cost per Accepted Checkpoint registrati",
        "Run censored/invalid esclusi correttamente dal confronto",
        "Conclusione limitata al pilot e repliche proposte solo se risultati vicini/rumorosi"
      ],
      "evidence": [],
      "requirements_refs": [
        "GitHub issue #9",
        "H2-02B Controlled Calibration Pilot"
      ],
      "risk": "HIGH",
      "milestone": "M1-H2",
      "last_updated_at": "2026-08-08T18:18:32.752Z",
      "last_updated_by": "Pi session 019fe291-152c-7a16-9b85-7405e964709a"
    }
  ]
}
```

## Regole di avanzamento

- H2-01 resta la application baseline accettata e non viene modificata retroattivamente.
- Il commit di freeze che contiene questo Ledger è l'experiment baseline H2-02A; il suo SHA va nei run record, non nel manifest congelato.
- H2-02A è il protocollo corrente completato; H2-02B resta PLANNED.
- Un completamento prima della soglia è censored, non prova una soglia.
- La qualità è un gate; il costo più basso non basta.
- Nessuna soglia ottimale o universalità è dichiarata dal pilot x1.
- Cost Guard, Advisor adattivo, auto-handoff, supervised-auto, routing e integrazioni esterne restano fuori scope.
