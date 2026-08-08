# Master Task Ledger — M1-H1 Context Handoff Advisor dogfood

**Authority:** Markdown canonico standalone
**Schema:** `eiopago.task-ledger/0.1.0`
**Current revision:** `PLAN-M1-H1-0007`
**Requirements version:** `REQ-M1-H1-ISSUE-8-F1-2026-08-08`
**Updated:** 2026-08-08T15:27:41.242Z

Il blocco JSON seguente è la rappresentazione deterministica importata dal Runner. Il digest della revisione è SHA-256 dei byte completi di questo file e non viene scritto nel file stesso.

```json task-ledger
{
  "schema_version": "0.1.0",
  "task_id": "TASK-EIOPAGO-M1-H1",
  "title": "Context Handoff Advisor minimale con dogfood reale M1-H0",
  "objective": "Implementare un advisor non bloccante per l'occupazione del context e provare il trasferimento reale di questo lavoro da una sessione Pi A a una sessione pulita B tramite Eiopago M1-H0.",
  "requirements_version": "REQ-M1-H1-ISSUE-8-F1-2026-08-08",
  "plan_revision_id": "PLAN-M1-H1-0007",
  "status": "DONE",
  "completion_criteria": [
    "Advisor legge l'occupazione context quando Pi la espone e usa una soglia configurabile con default indicativo 50%",
    "Advisor evita notifiche ripetute, propone chiaramente /eio handoff e resta advisory senza hard stop o cambio non consentito",
    "H1-01 è verificato nella Sessione A con test mirati",
    "Handoff reale /eio handoff crea una replacement session B paused/no-history e Continuity Check passa",
    "Sessione B riprende H1-02 senza ripetere H1-01 e completa documentazione, metriche e acceptance",
    "History trasferita nell'happy path pari a zero e friction/failure registrati senza inventare metriche"
  ],
  "risk": "HIGH",
  "created_at": "2026-08-08T14:26:06Z",
  "updated_at": "2026-08-08T15:27:41.242Z",
  "current_item": null,
  "next_item": null,
  "next_step": "STOP: M1-H1 is complete and accepted; do not start another handoff, Cost Guard, M1-H2, or the next milestone without separate authorization.",
  "evidence": [
    "GitHub issue #7 letta in sola lettura",
    "Worktree isolato F:/dev/eiopago-m1-h1 dalla baseline 84953671bc97d40efbf6f838f8ae08f3a40a4bd4",
    "H1-01: test advisor 2/2, npm run check 17 moduli, npm test 12/12 e git diff --check pass",
    "Dogfood gate: npm run eio ha caricato il Runner inline reale, ma il tool API non ha un canale TUI per inviare /eio; latch RELEASED generation 0, latestHandoff=null, nessun checkpoint/manifest/target",
    "Dogfood reale: handoff HO-dafdf726b0f8d142760a96cc → replacement 019fe1e4-eb10-7dcf-aab1-a18619d17994, checkpoint/manifest sealed e resume acknowledged; history non trasferita",
    "Issue #8 M1-H1-F1: owner gate transition e Runner session binding implementati con test offline e successivamente validati dal dogfood reale post-fix",
    "M1-H1-F1 final verification before the real post-fix dogfood: npm run check 18 modules; npm test 22/22 (15 top-level, E2E 6/6); git diff --check pass",
    "Real post-fix dogfood: HO-27f6d0dcd68e7349bdd149de → replacement 019fe1fc-aeca-76b7-99b5-c880d3b75a7d; Runner ownership and Continuity Check PASS; one resume admission; zero conversation history transferred",
    "Session B resumed ITEM-H1-02 with next_item ITEM-H1-03 and owner gate SATISFIED; six authoritative minimal reads completed without reconstructing conversation history",
    "Static F1 review found runtime evidence coherent with owner-gate-before-seal, setup binding, SQLite/journal/manifest attestation and idempotent admission code paths",
    "Final owner-executed shell acceptance: npm run check PASS (18 modules); npm test PASS (22/22, 15 top-level, E2E 6/6); git diff --check PASS with one informational LF-to-CRLF warning",
    "M1-H1 accepted PASS: H1-02 and H1-03 DONE; lifecycle closed with current_item=null and next_item=null"
  ],
  "model_policy": "openai-codex/gpt-5.6-sol",
  "reasoning_policy": "high",
  "checkpoint_policy": "confirm_fail_closed_dogfood",
  "minimal_reads": [
    "TASK_PLAN.md",
    "CHECKPOINT.md",
    "docs/m1-h0-handoff-mvp.md",
    "docs/m1-h1-context-handoff-advisor.md"
  ],
  "dogfood": {
    "source_session_id": "019fe1fb-d7b3-71f5-ac0e-dfd35e3f268d",
    "target_session_id": "019fe1fc-aeca-76b7-99b5-c880d3b75a7d",
    "branch": "feat/m1-h1-context-handoff-advisor",
    "worktree": "F:/dev/eiopago-m1-h1",
    "baseline_head": "84953671bc97d40efbf6f838f8ae08f3a40a4bd4",
    "handoff_command_canonical": "/eio handoff confirm",
    "handoff_command_actually_submitted": "/eio handoff confirm",
    "runner_launch_command": "npm run eio",
    "handoff_id": "HO-27f6d0dcd68e7349bdd149de",
    "handoff_outcome": "PASS: RUNNER_OWNERSHIP_ATTESTED, CONTINUITY_PASS, RESUMED",
    "resume_admission": "AUTHORIZED_ONCE",
    "conversation_history_transfer": "ZERO_CONFIRMED in replacement session",
    "metrics_session_a": {
      "session_id": "019fe1fb-d7b3-71f5-ac0e-dfd35e3f268d",
      "context_final": null,
      "input_tokens": null,
      "output_tokens": null,
      "reasoning_tokens": null,
      "cache_read_tokens": null,
      "cache_write_tokens": null,
      "reported_equivalent_cost_usd": null,
      "status": "unknown: the sealed checkpoint records usage=null and no post-fix source-session usage snapshot is available"
    },
    "metrics_session_b": {
      "session_id": "019fe1fc-aeca-76b7-99b5-c880d3b75a7d",
      "context_initial": null,
      "context_final": null,
      "input_tokens": null,
      "output_tokens": null,
      "reasoning_tokens": null,
      "cache_read_tokens": null,
      "cache_write_tokens": null,
      "reported_equivalent_cost_usd": null,
      "status": "unknown: the replacement-session runtime evidence contains no usage snapshot"
    },
    "historical_pre_fix_metrics": {
      "session_id": "019fe1c2-19f4-7e45-88df-e89e35f4f83c",
      "captured_at": "2026-08-08T14:34:53Z",
      "usage_entries": 37,
      "input_tokens": 140837,
      "output_tokens": 23074,
      "reasoning_tokens": 8367,
      "cache_read_tokens": 3049472,
      "cache_write_tokens": 0,
      "reported_equivalent_cost_usd": 2.921141,
      "context_initial_reported_tokens": 3569,
      "context_initial_derived_percent_of_272000": 1.31,
      "context_last_reported_tokens": 120909,
      "context_last_reported_derived_percent_of_272000": 44.45,
      "context_final_current": null,
      "status": "historical only; not attributed to the post-fix source session"
    },
    "artifact_sizes": {
      "task_plan_bytes": null,
      "checkpoint_bytes": null,
      "resume_manifest_bytes": null,
      "resume_prompt_bytes": null,
      "resume_prompt_available_inline": true,
      "resume_prompt_standalone_file": false,
      "status": "unknown: exact byte-stat metadata is not exposed by the current file API; no estimate substituted"
    },
    "minimal_reads_session_b": [
      "TASK_PLAN.md",
      "CHECKPOINT.md",
      "docs/m1-h0-handoff-mvp.md",
      "docs/m1-h1-context-handoff-advisor.md",
      ".guardian/checkpoints/CP-7a6eed065a7069546349c82f.json",
      ".guardian/manifests/RM-b5ec41729aab629d55ad89a4.json"
    ],
    "minimal_reads_session_b_count": 6,
    "manual_interventions": [
      "A human submitted the already-satisfied canonical owner command /eio handoff confirm in the Runner-owned source TUI.",
      "A human authorized the single resume admission after Continuity Check PASS."
    ],
    "friction": [
      "The real flow required the source command and one separate resume-admission confirmation.",
      "An earlier API/non-TTY attempt failed before latch engagement and required targeted process termination; it did not generate this handoff or transfer history.",
      "The first real pre-fix dogfood exposed stale owner-gate and unverifiable runtime ownership findings; F1 addressed both.",
      "No failure was reported for post-fix handoff HO-27f6d0dcd68e7349bdd149de."
    ],
    "finding_fix": {
      "issue": "#8",
      "id": "M1-H1-F1",
      "status": "ACCEPTED_PASS",
      "causes": [
        "Owner gate was never transitioned in the canonical Ledger before seal",
        "replacement_session_id existed only in persisted artifacts, without a current-runtime Runner binding"
      ],
      "ownership_surface": "Pi newSession setup + non-context CustomEntry eiopago.runner-session-binding.v1",
      "persisted_relation": [
        "handoff_id",
        "replacement_session_id",
        "runner_instance_id",
        "session_binding_id"
      ],
      "real_handoff_after_fix": "PASS: HO-27f6d0dcd68e7349bdd149de → 019fe1fc-aeca-76b7-99b5-c880d3b75a7d",
      "verification": [
        "pre-dogfood npm run check: PASS (18 modules)",
        "pre-dogfood npm test: PASS (22/22, 15 top-level)",
        "pre-dogfood git diff --check: PASS",
        "post-fix Runner ownership attestation: PASS",
        "post-fix Continuity Check: PASS",
        "post-fix resume admission: AUTHORIZED ONCE",
        "final npm run check: PASS (18 modules)",
        "final npm test: PASS (22/22, 15 top-level, E2E 6/6)",
        "final git diff --check: PASS; informational LF-to-CRLF warning only"
      ]
    }
  },
  "task_items": [
    {
      "task_item_id": "ITEM-H1-01",
      "task_id": "TASK-EIOPAGO-M1-H1",
      "title": "Implementare, configurare e testare il Context Handoff Advisor",
      "description": "Integrare l'API Pi getContextUsage quando disponibile, soglia configurabile default 50%, deduplicazione e proposta consensuale del percorso M1-H0, senza blocchi o hard stop.",
      "status": "DONE",
      "depends_on": [],
      "completion_criteria": [
        "Occupazione percentuale letta soltanto quando disponibile",
        "Soglia validata e configurabile con default 50%",
        "Una sola proposta mentre l'occupazione resta sopra soglia, con riarmo sotto soglia",
        "Conferma positiva prepara il comando canonico senza eseguirlo autonomamente",
        "Test mirati e check moduli passano"
      ],
      "evidence": [
        "src/context-advisor.mjs: default 50%, validation e deduplicazione con riarmo sotto soglia",
        "src/extension.mjs: turn_end usa ctx.getContextUsage e prepara /eio handoff confirm soltanto dopo consenso",
        "Test mirati Context Handoff Advisor: 2/2 pass",
        "npm run check: 17 moduli pass",
        "npm test: 12/12 pass, inclusi 6/6 E2E/regressioni M1-H0 e zero failure",
        "git diff --check: pass"
      ],
      "requirements_refs": [
        "GitHub issue #7",
        "REQ-M1-H1-ISSUE-7-AUTH-2026-08-08"
      ],
      "risk": "MEDIUM",
      "milestone": "M1-H1",
      "last_updated_at": "2026-08-08T14:30:15Z",
      "last_updated_by": "Pi session 019fe1c2-19f4-7e45-88df-e89e35f4f83c"
    },
    {
      "task_item_id": "ITEM-H1-02",
      "task_id": "TASK-EIOPAGO-M1-H1",
      "title": "Validare la ripresa reale e chiudere documentazione e metriche",
      "description": "Nella Sessione B verificare continuità e stato Git, completare documentazione, correggere soltanto friction minima emersa dal dogfood e registrare metriche disponibili.",
      "status": "DONE",
      "depends_on": [
        "ITEM-H1-01"
      ],
      "completion_criteria": [
        "Sessione B dimostra task/current/next, HEAD, test H1-01 e prossima attività dal contesto persistito",
        "H1-01 non viene ripetuto",
        "Metriche A/B e dimensioni degli artefatti registrate quando disponibili",
        "Context transfer strutturato, history, letture ridondanti e friction sono separati nel report"
      ],
      "evidence": [
        "src/ledger.mjs: owner gate persisted before checkpoint/manifest seal",
        "src/runner-ownership.mjs e src/storage.mjs: runtime/journal/manifest Runner binding fail-closed",
        "test/pi-e2e.test.mjs: owner gate → binding → continuity → one resume offline",
        "docs/m1-h1-context-handoff-advisor.md",
        "Pre-dogfood verification: check 18 modules, suite 22/22, E2E 6/6, diff-check pass",
        "Runtime post-fix: HO-27f6d0dcd68e7349bdd149de resumed exactly once in 019fe1fc-aeca-76b7-99b5-c880d3b75a7d with Runner ownership and Continuity PASS",
        "Session B read all 6 sealed minimal reads, resumed ITEM-H1-02/ITEM-H1-03 lifecycle, and observed zero transferred conversation history",
        "Post-fix A/B usage and exact artifact byte sizes recorded as unknown rather than inferred",
        "Final owner-executed shell gates: check PASS (18 modules), test PASS (22/22; E2E 6/6), diff-check PASS"
      ],
      "requirements_refs": [
        "GitHub issue #7 dogfood",
        "Metodo Antirez",
        "GitHub issue #8",
        "M1-H1-F1"
      ],
      "risk": "HIGH",
      "milestone": "M1-H1",
      "last_updated_at": "2026-08-08T15:27:41.242Z",
      "last_updated_by": "Pi replacement session 019fe1fc-aeca-76b7-99b5-c880d3b75a7d; owner-provided final shell acceptance"
    },
    {
      "task_item_id": "ITEM-H1-03",
      "task_id": "TASK-EIOPAGO-M1-H1",
      "title": "Acceptance e report del dogfood",
      "description": "Eseguire acceptance focalizzata e produrre esito PASS/PARTIAL/BLOCKED senza estendere il perimetro al Cost Guard.",
      "status": "DONE",
      "depends_on": [
        "ITEM-H1-02"
      ],
      "completion_criteria": [
        "Acceptance issue #7 valutata con evidenze",
        "TASK_PLAN e CHECKPOINT riflettono lo stato reale",
        "Report finale include comando, handoff, metriche, artifact size, reads, history, interventi, friction, test e file"
      ],
      "evidence": [
        "Real post-fix handoff HO-27f6d0dcd68e7349bdd149de resumed replacement 019fe1fc-aeca-76b7-99b5-c880d3b75a7d",
        "Runner ownership PASS; Continuity Check PASS; one resume admission; owner gate SATISFIED",
        "Conversation history transfer ZERO; six sealed minimal reads completed; H1-02 resumed correctly",
        "TASK_PLAN.md, CHECKPOINT.md and docs/m1-h1-context-handoff-advisor.md reconciled without inventing unavailable A/B metrics or artifact sizes",
        "Final acceptance: npm run check PASS, npm test PASS 22/22, git diff --check PASS"
      ],
      "requirements_refs": [
        "GitHub issue #7 acceptance",
        "REQ-M1-H1-ISSUE-7-AUTH-2026-08-08"
      ],
      "risk": "MEDIUM",
      "milestone": "M1-H1",
      "last_updated_at": "2026-08-08T15:27:41.242Z",
      "last_updated_by": "Pi replacement session 019fe1fc-aeca-76b7-99b5-c880d3b75a7d; owner-provided final shell acceptance"
    }
  ],
  "owner_gate": {
    "kind": "HANDOFF_CONFIRM",
    "status": "SATISFIED",
    "command": "/eio handoff confirm",
    "item_id": "ITEM-H1-02",
    "satisfied_plan_revision_id": "PLAN-M1-H1-0005",
    "satisfied_task_status": "IN_PROGRESS",
    "satisfied_next_item": "ITEM-H1-03",
    "satisfied_next_step": "M1-H1 acceptance completed; do not perform another handoff or start the next milestone without separate authorization.",
    "satisfied_at": "2026-08-08T15:01:46.519Z",
    "satisfied_by": "human:/eio-handoff",
    "evidence_handoff_id": "HO-dafdf726b0f8d142760a96cc",
    "post_fix_validation_handoff_id": "HO-27f6d0dcd68e7349bdd149de",
    "post_fix_replacement_session_id": "019fe1fc-aeca-76b7-99b5-c880d3b75a7d",
    "post_fix_continuity": "PASS",
    "final_acceptance": "PASS"
  }
}
```

## Piano Sessione A — massimo 6 passi

1. Isolare il worktree dalla baseline e verificare profilo/Git.
2. Acquisire issue #7 e creare il Ledger M1-H1.
3. Implementare configurazione, deduplicazione e UX dell'advisor.
4. Eseguire test mirati, check moduli e controlli diff.
5. Portare H1-01 a `DONE` con evidenza, registrare metriche A e aggiornare checkpoint/Ledger.
6. Usare realmente `/eio handoff confirm`; H1-02 e H1-03 appartengono alla Sessione B.

## Regole di avanzamento

- `DONE` è vietato senza criteri soddisfatti ed evidenze verificabili.
- Il Cost Guard, hard budget, billing, supervised-auto e cambio sessione autonomo sono fuori scope.
- La chat non sostituisce il Ledger; ogni safe point e failure del dogfood devono essere persistiti.
