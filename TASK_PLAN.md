# Master Task Ledger — M1-P0-B Runner-owned Portable Launcher e Handoff E2E Esterno

**Authority:** Markdown canonico standalone
**Schema:** `eiopago.task-ledger/0.1.0`
**Current revision:** `PLAN-M1-P0-B-0002`
**Requirements version:** `REQ-GH-17-M1-P0-B-2026-08-09`
**Updated:** 2026-08-09T08:15:00.000Z

```json task-ledger
{
  "schema_version": "0.1.0",
  "task_id": "TASK-EIOPAGO-M1-P0-B",
  "title": "Runner-owned portable launcher e handoff E2E esterno",
  "objective": "Dimostrare da un repository Git esterno che eio avvia Pi sotto ownership del Runner e completa un handoff A→B portabile, senza history transfer e con una sola admission locale.",
  "requirements_version": "REQ-GH-17-M1-P0-B-2026-08-09",
  "plan_revision_id": "PLAN-M1-P0-B-0002",
  "status": "DONE",
  "completion_criteria": [
    "Package Eiopago separato dal target e launcher Runner-owned nel target Git esplicito",
    "External fixture E2E completa handoff A→B, continuity e prosecuzione del secondo item",
    "History transfer zero, model continuity e exactly-one local admission provati",
    "Failure path safety-critical restano fail-closed",
    "npm run check, npm test, git diff --check e npm pack --dry-run passano"
  ],
  "risk": "HIGH",
  "created_at": "2026-08-09T08:00:00.000Z",
  "updated_at": "2026-08-09T08:15:00.000Z",
  "current_item": null,
  "next_item": null,
  "next_step": "STOP SESSION: P0-B PASS; attendere autorizzazione separata prima di P0-C o dogfood su repository reali.",
  "evidence": [
    "Start baseline 57e6a51356924e5f527cf7d8a51184a25b136add; P0-A storico DONE/PASS non riaperto",
    "CLI eio/eio --target risolvono config e target Git espliciti, creano GuardianRunner con repository context e avviano il runtime/TUI Runner-owned",
    "/eio status espone target, branch/HEAD/worktree, task/item, ownership, session/model, latch/takeover/handoff e context bounded",
    "Checkpoint/manifest usano relevant_decisions, relevant_tests ed evidence_references dichiarati dal Ledger target",
    "External fixture E2E PASS: HO-6b9d6c041a51a648c5562243, source 019fe590-f803-75fc-84ae-a76d80d3db9b, replacement 019fe590-fc4c-778c-984e-955e427a2de1",
    "History evidence: replacement paused RESUME_READY con 0 message/custom_message/compaction/branch_summary e nessun SOURCE_PRIVATE_MARKER",
    "Exactly-once locale: doppio /eio handoff confirm più duplicate resume/authorization producono 1 HANDOFF_STARTED, 1 authorization, 1 admission, 1 dispatch intent e 1 acknowledgement",
    "Model continuity E2E: portable-offline/portable-offline + reasoning off dal modello Pi effettivo a manifest e replacement",
    "Failure matrix fail-closed: target/HEAD/Ledger/checkpoint/manifest/model/reasoning/stale binding; replacement ambiguity, dispatch unknown e takeover restano coperti",
    "Package tarball installato in root temporanea separata e eio init eseguito su target temporaneo senza package.json/src Eiopago",
    "Gate finali cold review: npm run check PASS (33 moduli); npm test PASS (93/93); targeted external E2E PASS; git diff --check PASS; npm pack --dry-run PASS (24 file)",
    "Documentazione utente e procedura manuale: docs/portable-alpha.md",
    "Nessun dogfood repo reale, P0-C, H2 RUN, Cost Guard, Chronicle o commit"
  ],
  "model_policy": "openai-codex/gpt-5.6-sol",
  "reasoning_policy": "high",
  "checkpoint_policy": "bounded_items_and_final_gates",
  "minimal_reads": [
    "TASK_PLAN.md",
    "docs/portable-alpha.md"
  ],
  "relevant_decisions": [
    "docs/adr/0015-m0-boundaries-and-contract-freeze.md"
  ],
  "relevant_tests": [
    "npm run check",
    "npm test",
    "git diff --check",
    "npm pack --dry-run"
  ],
  "evidence_references": [
    "docs/portable-alpha.md"
  ],
  "historical_milestones": [
    {
      "milestone": "M1-P0-A",
      "status": "DONE",
      "plan_revision_id": "PLAN-M1-P0-A-0003",
      "task_id": "TASK-EIOPAGO-M1-P0-A",
      "evidence": [
        "Baseline verificata: 9ed10f6148a144179cccce3c9141e4fa61c808e5",
        "Root/config contract e redirect fail-closed: src/repository.mjs e src/runner.mjs",
        "Bootstrap non distruttivo con Ledger ambiguo e .gitignore bounded: src/bootstrap.mjs e bin/src CLI",
        "Package standard con bin/exports/files/engines/peer Pi e npm pack dry-run verificato",
        "Fixture repository temporanei indipendenti in test/portable-alpha.test.mjs",
        "Documentazione operativa: docs/portable-alpha.md",
        "Handoff safety/latch/continuity/resume core non riscritti; soltanto root e model-policy plumbing minimo",
        "Nessun H2 pilot, RUN-40/50/60, Cost Guard o Chronicle avviato"
      ]
    }
  ],
  "task_items": [
    {
      "task_item_id": "P0-B1",
      "task_id": "TASK-EIOPAGO-M1-P0-B",
      "title": "Launcher/runtime ownership audit",
      "description": "Verificare CLI, root resolution, config, prerequisiti, creazione Runner, Pi runtime, extension e TUI senza fallback al source cwd",
      "status": "DONE",
      "depends_on": [],
      "completion_criteria": [
        "Root e ownership flow reali sono tracciati",
        "I gap P0-B sono bounded"
      ],
      "evidence": [
        "Audit completato su src/cli.mjs, repository.mjs, pi-loader.mjs, runner.mjs, extension.mjs e handoff.mjs",
        "Nessun fallback CLI al source cwd; REPOSITORY_NOT_INITIALIZED coperto con istruzione eio init"
      ],
      "requirements_refs": [
        "GitHub #17",
        "M1-P0-B"
      ],
      "risk": "MEDIUM",
      "milestone": "M1-P0-B",
      "last_updated_at": "2026-08-09T08:15:00.000Z",
      "last_updated_by": "Pi session 019fe585-2c75-710c-9329-c9d241446f6f"
    },
    {
      "task_item_id": "P0-B2",
      "task_id": "TASK-EIOPAGO-M1-P0-B",
      "title": "Portable Runner-owned launch",
      "description": "Chiudere i gap di launcher e /eio status per un target esterno esplicito",
      "status": "DONE",
      "depends_on": [
        "P0-B1"
      ],
      "completion_criteria": [
        "eio ed eio --target avviano il Runner nel target inizializzato",
        "status mostra target, Git, task, ownership, latch/session/advisor senza secret"
      ],
      "evidence": [
        "Launcher esterno verificato via runCli con GuardianRunner reale e provider offline; installation root != target root",
        "Status bounded verificato nel target esterno; pause/takeover reali sono alias"
      ],
      "requirements_refs": [
        "GitHub #17",
        "M1-P0-B"
      ],
      "risk": "HIGH",
      "milestone": "M1-P0-B",
      "last_updated_at": "2026-08-09T08:15:00.000Z",
      "last_updated_by": "Pi session 019fe585-2c75-710c-9329-c9d241446f6f"
    },
    {
      "task_item_id": "P0-B3",
      "task_id": "TASK-EIOPAGO-M1-P0-B",
      "title": "Target-agnostic handoff artifacts",
      "description": "Rendere checkpoint e manifest semanticamente riferiti al Ledger e repository target",
      "status": "DONE",
      "depends_on": [
        "P0-B1"
      ],
      "completion_criteria": [
        "Metadata deferred P0-A non puntano implicitamente al source Eiopago",
        "Git, Ledger, model policy e lineage sono verificabili negli artifact"
      ],
      "evidence": [
        "src/handoff.mjs deriva metadata portabili dal Ledger target",
        "Artifact fixture verificati con Git target, branch, HEAD, PLAN-PORTABLE-FIXTURE-2, current ITEM-2, lineage e model policy"
      ],
      "requirements_refs": [
        "GitHub #17",
        "M1-P0-B"
      ],
      "risk": "MEDIUM",
      "milestone": "M1-P0-B",
      "last_updated_at": "2026-08-09T08:15:00.000Z",
      "last_updated_by": "Pi session 019fe585-2c75-710c-9329-c9d241446f6f"
    },
    {
      "task_item_id": "P0-B4",
      "task_id": "TASK-EIOPAGO-M1-P0-B",
      "title": "External-repository handoff E2E",
      "description": "Eseguire su fixture Git temporanea indipendente un handoff A→B con history zero, continuity e exactly-one admission",
      "status": "DONE",
      "depends_on": [
        "P0-B2",
        "P0-B3"
      ],
      "completion_criteria": [
        "Item 1 produce una modifica reale e il Ledger avanza",
        "Replacement paused senza history supera continuity e riprende item 2",
        "Failure path principali restano fail-closed"
      ],
      "evidence": [
        "test/portable-handoff-e2e.test.mjs esegue item 1 via tool write reale, doppio /eio handoff confirm, continuity, singola admission e item 2 in replacement",
        "Paused replacement history entries=0; item 1 scritto una sola volta; nessun network/service esterno",
        "Failure matrix P0-B in test/pi-e2e.test.mjs PASS"
      ],
      "requirements_refs": [
        "GitHub #17",
        "M1-P0-B"
      ],
      "risk": "HIGH",
      "milestone": "M1-P0-B",
      "last_updated_at": "2026-08-09T08:15:00.000Z",
      "last_updated_by": "Pi session 019fe585-2c75-710c-9329-c9d241446f6f"
    },
    {
      "task_item_id": "P0-B5",
      "task_id": "TASK-EIOPAGO-M1-P0-B",
      "title": "Failure paths, docs and review readiness",
      "description": "Completare test, guida manuale e gate finali senza iniziare P0-C",
      "status": "DONE",
      "depends_on": [
        "P0-B4"
      ],
      "completion_criteria": [
        "Documentazione utente copre launcher/handoff/recovery/cleanup",
        "Tutti i gate richiesti passano",
        "Report P0-B contiene evidence riproducibile"
      ],
      "evidence": [
        "docs/portable-alpha.md aggiornata per install/init/launch/status/handoff/confirm/pause/takeover/recovery/storage/history zero/cleanup/manual acceptance",
        "npm run check, npm test, git diff --check e npm pack --dry-run PASS",
        "Tarball locale installato e inizializzato su fixture separata; nessun file applicativo/package target alterato"
      ],
      "requirements_refs": [
        "GitHub #17",
        "M1-P0-B"
      ],
      "risk": "MEDIUM",
      "milestone": "M1-P0-B",
      "last_updated_at": "2026-08-09T08:15:00.000Z",
      "last_updated_by": "Pi session 019fe585-2c75-710c-9329-c9d241446f6f"
    }
  ]
}
```

## Storico milestone

- **M1-P0-A — DONE/PASS** alla revision `PLAN-M1-P0-A-0003` (baseline corrente `57e6a51356924e5f527cf7d8a51184a25b136add`).
- P0-A non viene riaperto salvo regressione direttamente bloccante.

## Regole di avanzamento

- P0-B resta bounded ai cinque item del Ledger.
- Nessun dogfood su Alfred/Durex/FARO.
- Nessun P0-C, H2 RUN-40/50/60, Cost Guard o Chronicle.
- Nessuna modifica a threshold/Advisor o alle semantiche handoff autorevoli salvo blocker dimostrato.
- Nessun commit viene creato in questa sessione.
