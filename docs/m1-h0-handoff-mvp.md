# M1-H0 — Automatic Session Handoff MVP

## Scope consegnato

Il vertical slice standalone implementa esclusivamente:

- `TASK_PLAN.md` come Master Task Ledger Markdown canonico e import read-only;
- SQLite locale versionato (`node:sqlite`, WAL, `synchronous=FULL`) per latch, journal, handoff, operation outcome, authorization, admission e dispatch intent;
- checkpoint JSON e Resume Context Manifest sealed con scrittura temp+fsync+rename, digest dei byte e indice SQLite;
- Guardian Runner con provider transport admission fail-closed e allowlist di tool profilati;
- safe point SP-03 **FINISH CURRENT ATOMIC OPERATION**;
- `/eio handoff manual`, `/eio handoff confirm`, `/eio takeover`, `/eio resume` e `/eio status` (alias `/eiopago`);
- replacement Pi con parent, inizialmente paused e senza history;
- Continuity Check e resume prompt deterministico senza call dedicata;
- authorization/admission idempotente e dispatch intent persistito prima dell'invio;
- test offline e E2E sul runtime/SessionManager Pi reale con provider fake e zero rete.

Cost Guard completo, telemetria/costi, supervised-auto, provider adapter, watchdog, dashboard e crash recovery unattended restano fuori scope.

## Avvio

Requisiti: Node.js 22.19+ e Pi installato. Il Runner usa il provider/model del Ledger (`openai-codex/gpt-5.6-sol`, reasoning `high`) e non carica estensioni o skill esterne.

```text
npm test
npm run test:e2e
npm run eio
```

In Pi gestito dal Runner:

```text
/eio handoff manual
/eio handoff confirm
/eio takeover
/eio resume [handoff-id]
/eio status
```

`manual` crea e valida il target, precompila il prompt ma mantiene latch e target in pausa. `confirm` chiede l'autorizzazione nella replacement session dopo continuity; solo allora rilascia il latch, committa admission e invia il prompt. `takeover` persiste o scala il latch a `HUMAN_TAKEOVER`, chiude queue/retry/compaction e raggiunge lo stesso safe point tool-aware senza avviare un handoff.

## Garanzie e failure model

- Una call provider che linearizza dopo latch `ENGAGED` viene rifiutata nel provider posseduto dal Runner.
- Queue, retry e compaction vengono chiusi prima di `SAFE_TO_HANDOFF`.
- Tool non profilati (incluso `bash` in questo MVP) non sono ammessi dal Runner.
- Mutazione con outcome unknown o senza effect reference produce `HUMAN_DECISION_REQUIRED`; `edit`/`write` conservano il path ammesso fino a `tool_execution_end` perché quell'evento Pi non ripete gli argomenti.
- Checkpoint e manifest non vengono riscritti sotto lo stesso ID con byte diversi.
- Continuity confronta Ledger, digest, Git, lineage, parent, target vuoto/paused, model e reasoning policy.
- `resume_prompt_id` ha una authorization e una admission; l'idempotency key è unica.
- Qualsiasi errore dopo il dispatch intent viene classificato `RESUME_DISPATCH_UNKNOWN`; il Runner non ritenta automaticamente.
- La creazione Pi e il journal SQLite non sono una singola transazione ACID: outcome ambiguo/cancellato della create resta `HANDOFF_FAILED` senza secondo target automatico. Checkpoint e istruzioni numerate di riconciliazione manuale restano visibili in `/eio status`; il manifest finale non viene falsamente sigillato finché manca il vero target ID.

Non viene dichiarata exactly-once provider execution.

## Verifica M1-H0

`npm run check` valida i 16 moduli. `npm test` esegue 4 test core offline e 4 E2E con Pi/SessionManager reali e provider fake: happy path confirm, comandi reali `/eio takeover` e `/eio handoff manual` paused/no-history, più failure ambiguo con checkpoint/istruzioni preservati. I test bloccano `fetch` e osservano zero tentativi rete.
