# Master Task Ledger — M1-H0 Automatic Session Handoff MVP

**Authority:** Markdown canonico standalone
**Schema:** `eiopago.task-ledger/0.1.0`
**Current revision:** `PLAN-M1-H0-0003`
**Requirements version:** `REQ-M1-H0-ISSUE-6`
**Updated:** 2026-08-08T10:02:40Z

Il blocco JSON seguente è la rappresentazione deterministica importata dal Runner. Il digest della revisione è SHA-256 dei byte completi di questo file e non viene scritto nel file stesso.

```json task-ledger
{
  "schema_version": "0.1.0",
  "task_id": "TASK-EIOPAGO-M1-H0",
  "title": "Automatic Session Handoff MVP",
  "objective": "Consegnare il vertical slice manual/confirm da una sessione Pi a una replacement paused/no-history con checkpoint e resume idempotente.",
  "requirements_version": "REQ-M1-H0-ISSUE-6",
  "plan_revision_id": "PLAN-M1-H0-0003",
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
  "updated_at": "2026-08-08T10:02:40Z",
  "current_item": null,
  "next_item": null,
  "next_step": "M1-H0 accettato; attendere una nuova autorizzazione senza iniziare Cost Guard, M1.1/M1.2 o integrazioni esterne.",
  "evidence": [
    "npm run check: 16 moduli pass (acceptance session 019fe0d1-9320-756b-b429-96e43af51ac4)",
    "npm test: 10/10 pass, inclusi core offline 6/6 ed E2E Pi/provider fake 4/4",
    "git diff --check: pass",
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
    },
    {
      "task_item_id": "ITEM-M1-H0-02",
      "task_id": "TASK-EIOPAGO-M1-H0",
      "title": "Correzione dei tre finding di acceptance M1-H0",
      "description": "Rendere takeover non rilasciabile da conferma pendente, verificare i digest Git index/worktree e modellare il lifecycle Ledger current/next con prova E2E dell'update.",
      "status": "DONE",
      "depends_on": ["ITEM-M1-H0-01"],
      "completion_criteria": [
        "Una conferma pendente non rilascia HUMAN_TAKEOVER né committa admission",
        "Continuity rileva cambi di byte a status porcelain invariato tramite digest index/worktree",
        "Ledger canonico espone current_item/next_item e l'E2E dimostra una revisione lifecycle durante il flusso",
        "Nuova acceptance esterna registrata"
      ],
      "evidence": [
        "test/core.test.mjs: stale confirm/takeover e digest Git a porcelain invariato",
        "test/pi-e2e.test.mjs: update PLAN-E2E-1 → PLAN-E2E-2 durante il flusso",
        "Acceptance session 019fe0d1-9320-756b-b429-96e43af51ac4: PASS sui tre finding; npm run check, npm test e git diff --check pass"
      ],
      "requirements_refs": ["GitHub issue #6 acceptance findings"],
      "risk": "HIGH",
      "milestone": "M1-H0",
      "last_updated_at": "2026-08-08T10:02:40Z",
      "last_updated_by": "Pi session 019fe0d1-9320-756b-b429-96e43af51ac4"
    }
  ]
}
```

## Regole di avanzamento

- `DONE` è vietato senza criteri soddisfatti ed evidenze verificabili.
- Checkpoint e manifest riferiscono sempre questa revisione e il digest ricalcolato dei byte del Ledger.
- Il Runner indicizza il Ledger in SQLite ma non scrive mai modifiche inverse in questo file.
- Il Cost Guard completo resta fuori da questo Ledger M1-H0 e richiede una nuova autorizzazione/milestone.
