# Master Task Ledger — M1-H0 Automatic Session Handoff MVP

**Authority:** Markdown canonico standalone
**Schema:** `eiopago.task-ledger/0.1.0`
**Current revision:** `PLAN-M1-H0-0001`
**Requirements version:** `REQ-M1-H0-ISSUE-6`
**Updated:** 2026-08-08T07:15:00Z

Il blocco JSON seguente è la rappresentazione deterministica importata dal Runner. Il digest della revisione è SHA-256 dei byte completi di questo file e non viene scritto nel file stesso.

```json task-ledger
{
  "schema_version": "0.1.0",
  "task_id": "TASK-EIOPAGO-M1-H0",
  "title": "Automatic Session Handoff MVP",
  "objective": "Consegnare il vertical slice manual/confirm da una sessione Pi a una replacement paused/no-history con checkpoint e resume idempotente.",
  "requirements_version": "REQ-M1-H0-ISSUE-6",
  "plan_revision_id": "PLAN-M1-H0-0001",
  "status": "DONE",
  "completion_criteria": [
    "Ledger Markdown importato senza sync inversa silenziosa",
    "SQLite versionato e journal append-only con vincoli di idempotenza",
    "Checkpoint e manifest sealed, content-addressed e verificati",
    "SAFE_TO_HANDOFF applica FINISH CURRENT ATOMIC OPERATION e fallisce chiuso sugli outcome unknown",
    "Runner possiede transport admission, queue e replacement session",
    "/eio handoff supporta manual e confirm",
    "Replacement Pi nasce paused, conserva parent lineage e non copia history",
    "Continuity Check blocca ogni mismatch",
    "Resume authorization/admission è idempotente e dispatch unknown non viene ritentato",
    "Test offline e E2E con runtime Pi reale passano senza rete"
  ],
  "risk": "MEDIUM",
  "created_at": "2026-08-08T06:35:45Z",
  "updated_at": "2026-08-08T07:15:00Z",
  "next_step": "M1-H0 consolidato: attendere review/acceptance esterna; non iniziare M1 o il Cost Guard senza nuova autorizzazione.",
  "evidence": [
    "test/core.test.mjs: 4/4 pass",
    "test/pi-e2e.test.mjs: 4/4 pass con runtime Pi reale e provider fake",
    "docs/m1-h0-handoff-mvp.md"
  ],
  "model_policy": "openai-codex/gpt-5.6-sol",
  "reasoning_policy": "high",
  "checkpoint_policy": "manual_or_confirm_fail_closed",
  "minimal_reads": [
    "TASK_PLAN.md",
    "CHECKPOINT.md",
    "docs/adr/0015-m0-boundaries-and-contract-freeze.md",
    "docs/contracts/m0-contracts.md",
    "docs/m1-h0-handoff-mvp.md"
  ],
  "task_items": [
    {
      "task_item_id": "ITEM-M1-H0-01",
      "task_id": "TASK-EIOPAGO-M1-H0",
      "title": "Vertical slice handoff owner-controlled",
      "description": "Ledger, storage, checkpoint/manifest, safe point, Runner, command, continuity e resume.",
      "status": "DONE",
      "depends_on": [],
      "completion_criteria": ["Tutti i criteri task M1-H0 verificati"],
      "evidence": [
        "src/runner.mjs",
        "src/handoff.mjs",
        "src/storage.mjs",
        "test/core.test.mjs",
        "test/pi-e2e.test.mjs"
      ],
      "requirements_refs": ["GitHub issue #6", "ADR-0015 D1-D5", "SP-01", "SP-02", "SP-03", "SP-04"],
      "risk": "HIGH",
      "milestone": "M1-H0",
      "last_updated_at": "2026-08-08T07:15:00Z",
      "last_updated_by": "Pi session 019fe02e-522e-714d-b0e2-8cd1ff15d3b9"
    }
  ]
}
```

## Regole di avanzamento

- `DONE` è vietato senza criteri soddisfatti ed evidenze verificabili.
- Checkpoint e manifest riferiscono sempre questa revisione e il digest ricalcolato dei byte del Ledger.
- Il Runner indicizza il Ledger in SQLite ma non scrive mai modifiche inverse in questo file.
- Il Cost Guard completo resta fuori da questo Ledger M1-H0 e richiede una nuova autorizzazione/milestone.
