# Master Task Ledger — M1-P0-A Portable Bootstrap, Packaging e Config

**Authority:** Markdown canonico standalone
**Schema:** `eiopago.task-ledger/0.1.0`
**Current revision:** `PLAN-M1-P0-A-0003`
**Requirements version:** `REQ-GH-16-M1-P0-A-2026-08-09`
**Updated:** 2026-08-09T07:44:24.045Z

```json task-ledger
{
  "schema_version": "0.1.0",
  "task_id": "TASK-EIOPAGO-M1-P0-A",
  "title": "Portable bootstrap, packaging e config",
  "objective": "Rendere Eiopago installabile separatamente e inizializzabile in modo non distruttivo in un Git worktree esterno, con root e stato locale espliciti.",
  "requirements_version": "REQ-GH-16-M1-P0-A-2026-08-09",
  "plan_revision_id": "PLAN-M1-P0-A-0003",
  "status": "DONE",
  "completion_criteria": [
    "Packaging e CLI alpha sono definiti e testabili da un repository esterno",
    "eio init valida prerequisiti e Git target, crea solo stato minimo ed è idempotente",
    "Installation root, target root, config root, runtime root e artifact root sono espliciti",
    "TASK_PLAN.md e .gitignore sono gestiti con policy fail-closed e non distruttiva",
    "Test P0-A, npm run check, npm test e git diff --check passano",
    "Documentazione alpha per installazione, init, layout, re-init e cleanup è disponibile"
  ],
  "risk": "HIGH",
  "created_at": "2026-08-09T06:51:10.516Z",
  "updated_at": "2026-08-09T07:44:24.045Z",
  "current_item": null,
  "next_item": null,
  "next_step": "STOP SESSION: P0-A chiuso; non iniziare P0-B o dogfood su repository esterni senza autorizzazione separata.",
  "evidence": [
    "Baseline verificata: 9ed10f6148a144179cccce3c9141e4fa61c808e5",
    "Root/config contract e redirect fail-closed: src/repository.mjs e src/runner.mjs",
    "Bootstrap non distruttivo con Ledger ambiguo e .gitignore bounded: src/bootstrap.mjs e bin/src CLI",
    "Package standard con bin/exports/files/engines/peer Pi e npm pack dry-run verificato",
    "Fixture repository temporanei indipendenti in test/portable-alpha.test.mjs",
    "Documentazione operativa: docs/portable-alpha.md",
    "Handoff safety/latch/continuity/resume core non riscritti; soltanto root e model-policy plumbing minimo",
    "Nessun H2 pilot, RUN-40/50/60, Cost Guard o Chronicle avviato"
  ],
  "model_policy": "openai-codex/gpt-5.6-sol",
  "reasoning_policy": "high",
  "checkpoint_policy": "bounded_items_and_final_gates",
  "minimal_reads": [
    "TASK_PLAN.md",
    "docs/portable-alpha.md"
  ],
  "task_items": [
    {
      "task_item_id": "P0-A1",
      "task_id": "TASK-EIOPAGO-M1-P0-A",
      "title": "Portability and packaging audit",
      "description": "Inventariare entrypoint, packaging, Pi loading, root/path assumptions, config, storage e artifact boundaries sul codice reale.",
      "status": "DONE",
      "depends_on": [],
      "completion_criteria": [
        "I blocker per eio init/eio da repository esterno sono identificati sul codice corrente",
        "Le invarianti handoff da non modificare sono delimitate"
      ],
      "evidence": [
        "Audit file e ricerca process.cwd/path eseguiti sulla baseline",
        "Pi installato rilevato come @earendil-works/pi-coding-agent 0.83.0; Node v22.19.0; Git 2.51.0.windows.1"
      ],
      "requirements_refs": [
        "GitHub #16",
        "FASE 0"
      ],
      "risk": "MEDIUM",
      "milestone": "M1-P0-A",
      "last_updated_at": "2026-08-09T07:04:19.132Z",
      "last_updated_by": "Pi session 019fe548-2235-7018-8c05-3c0a638d01e2"
    },
    {
      "task_item_id": "P0-A2",
      "task_id": "TASK-EIOPAGO-M1-P0-A",
      "title": "Target repository discovery and config contract",
      "description": "Separare installation, target, config, runtime e artifact root; normalizzare e validare un Git worktree anche da path nested.",
      "status": "DONE",
      "depends_on": [
        "P0-A1"
      ],
      "completion_criteria": [
        "Root contract esplicito e config per-repository minimo/versionato",
        "Target mancante, non-Git o incompatibile fallisce con diagnostica utile",
        "Path Windows, spazi e linked worktree sono coperti senza design Windows-only"
      ],
      "evidence": [
        "src/repository.mjs separa installation/target/config/runtime/artifact root e valida Git top-level reale",
        "Config eiopago.repository/1.0.0 strict, relativa, senza campi extra/secret e senza escape dal target",
        "Symlink/junction e tipi incompatibili sui path riservati falliscono chiuso",
        "Test nested path, linked worktree, spazi, target errato/non-Git e config escape"
      ],
      "requirements_refs": [
        "GitHub #16",
        "TARGET REPOSITORY CONTRACT",
        "CONFIG"
      ],
      "risk": "HIGH",
      "milestone": "M1-P0-A",
      "last_updated_at": "2026-08-09T07:04:19.132Z",
      "last_updated_by": "Pi session 019fe548-2235-7018-8c05-3c0a638d01e2"
    },
    {
      "task_item_id": "P0-A3",
      "task_id": "TASK-EIOPAGO-M1-P0-A",
      "title": "Non-destructive init",
      "description": "Implementare eio init idempotente con policy sicure per config, Ledger, runtime path e .gitignore.",
      "status": "DONE",
      "depends_on": [
        "P0-A2"
      ],
      "completion_criteria": [
        "Init crea gli elementi mancanti e preserva config/runtime/Ledger validi",
        "Ledger non riconosciuto fallisce chiuso e non viene sovrascritto",
        ".gitignore è aggiornato soltanto con blocco bounded/idempotente",
        "Nessun file applicativo estraneo o conversation history viene creato/modificato"
      ],
      "evidence": [
        "src/bootstrap.mjs implementa preflight, template Ledger, preservazione fail-closed, runtime retained e managed .gitignore block",
        "Test init pulito, re-init, Ledger valido/estraneo, .gitignore esistente, .guardian parziale e file applicativi estranei"
      ],
      "requirements_refs": [
        "GitHub #16",
        "EIO INIT",
        "GITIGNORE",
        "IDEMPOTENZA E SAFETY"
      ],
      "risk": "HIGH",
      "milestone": "M1-P0-A",
      "last_updated_at": "2026-08-09T07:04:19.132Z",
      "last_updated_by": "Pi session 019fe548-2235-7018-8c05-3c0a638d01e2"
    },
    {
      "task_item_id": "P0-A4",
      "task_id": "TASK-EIOPAGO-M1-P0-A",
      "title": "Package and CLI entrypoint",
      "description": "Definire bin/exports/files e un entrypoint CLI standard installabile via npm link o package path, con compatibility checks.",
      "status": "DONE",
      "depends_on": [
        "P0-A2"
      ],
      "completion_criteria": [
        "Package espone il bin eio e una API ESM minima",
        "CLI supporta init, target esplicito, help/version e launch entrypoint",
        "Node, Git e Pi mancanti/incompatibili falliscono velocemente senza auto-update"
      ],
      "evidence": [
        "package.json espone bin eio, export ESM, files, Node engine e peer Pi 0.83.x",
        "src/cli.mjs supporta init, --target, help, version e launch entrypoint",
        "src/pi-loader.mjs risolve installazioni nested/hoisted senza adottare Pi dal target e verifica Pi 0.83.x stable",
        "npm pack --dry-run e invocazione reale del package installato su repo temporaneo esterno con spazi verificate"
      ],
      "requirements_refs": [
        "GitHub #16",
        "PACKAGING / CLI",
        "COMPATIBILITÀ"
      ],
      "risk": "HIGH",
      "milestone": "M1-P0-A",
      "last_updated_at": "2026-08-09T07:04:19.132Z",
      "last_updated_by": "Pi session 019fe548-2235-7018-8c05-3c0a638d01e2"
    },
    {
      "task_item_id": "P0-A5",
      "task_id": "TASK-EIOPAGO-M1-P0-A",
      "title": "Tests, docs and review readiness",
      "description": "Coprire fixture repository indipendenti, documentare UX/layout/cleanup ed eseguire tutti i gate finali.",
      "status": "DONE",
      "depends_on": [
        "P0-A3",
        "P0-A4"
      ],
      "completion_criteria": [
        "Casi init/re-init/Ledger/.gitignore/parziale/non-Git/path/worktree/spazi/environment sono coperti offline",
        "Documentazione portable alpha è utilizzabile senza conoscenza degli internals",
        "npm run check, npm test e git diff --check passano"
      ],
      "evidence": [
        "test/portable-alpha.test.mjs: 15 test P0-A mirati PASS; model policy portable coperta anche E2E",
        "docs/portable-alpha.md copre prerequisiti, install, init, layout, re-init, errori e cleanup",
        "Gate finali cold review: npm run check PASS (32 moduli); npm test PASS (81/81); git diff --check PASS con soli warning LF/CRLF; npm pack --dry-run PASS (24 file)"
      ],
      "requirements_refs": [
        "GitHub #16",
        "DOCUMENTAZIONE",
        "TEST",
        "STOP CONDITION"
      ],
      "risk": "MEDIUM",
      "milestone": "M1-P0-A",
      "last_updated_at": "2026-08-09T07:44:24.045Z",
      "last_updated_by": "Pi session 019fe570-6705-7b74-9de5-79c62d366406"
    }
  ]
}
```

## Regole di avanzamento

- Il motore handoff M1-H0/H1 resta invariato salvo plumbing minimo delle root.
- H2 calibration resta PAUSED: nessun RUN-40/50/60 e nessuna modifica a threshold o Advisor.
- Cost Guard, Chronicle e P0-B restano fuori scope.
- Nessun commit viene creato in questa sessione.
