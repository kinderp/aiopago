# CHECKPOINT — AIOPAGO 0.2-B INDEPENDENT REVIEW ROUND 1 BLOCKED REMEDIATION

- **Stato:** `0.2-B = READY FOR INDEPENDENT REVIEW`; gate indipendente `0/2`. La developer review non conta. 0.2-C resta `NOT STARTED / BLOCKED` e l'Efficiency Benchmark non è implementato.
- **Base/perimetro:** remediation partita dal feature HEAD atteso `433dc3de1f76303307f6c5e21363d37936356dc8` con `origin/main=323782ee7c491dfbf097606b7313f4d7c98865b1`; nessun rebase/merge, nessuna modifica a main.
- **H-01:** una generic proposal con `HANDOFF_CONFIRM/BLOCKED` preserva owner gate, task status, current/next item, next step, item set/status e dependency/supersession topology; il protected item resta BLOCKED e nessun item diventa IN_PROGRESS. Soltanto `satisfyOwnerGate()` HUMAN con exact command rilascia la latch.
- **H-02:** dopo semantic validation/preparation e lock attestation, la final primitive legge soltanto raw authority bytes con fingerprint pre/open/post (identity, regular state, size, nlink, mtime/ctime nanosecondi dove disponibili), li confronta con la copia esatta dell'initial authority e invoca immediatamente rename senza decode, parse, callback o altro filesystem I/O.
- **H-03/timestamp:** proposal/intent/applied/history e witness filesystem sono derived audit evidence, non autenticatori. Restart/new `PlanPort` con exact candidate resta sempre `PLAN_RECOVERY_AMBIGUOUS`; soltanto una receipt privata volatile installata dopo il live post-rename path consente same-instance idempotence. `applied.json` è exclusive, `applied_at >= prepared_at`, e clock rollback produce pending/ambiguity.
- **M-01/M-02:** contract e bootstrap 0.1.0 sono ripristinati byte-identici a main. Il validator accetta legacy `reason/actor/timestamp`, alias `terminal_*` o entrambi coerenti senza nuova reciprocità/cardinalità supersession. Layout compact bootstrap ed extended metadata sono mutabili; partial/duplicate/mismatch falliscono chiuso.
- **M-03/L-01:** immutable exact-existing viene file-fsynced e directory-risynced a ogni retry; errori inattesi riemergono. Il preflight UTF-8/structure/semantic avviene prima del lock, quindi authority malformata non crea `.guardian`; il reread sotto lock resta autorevole.
- **Regressioni/scope:** strict JSON, reconstruction, 32 MiB, exact history, lock ownership/release, no public raw replace, UTF-8 fatal, attempt bound e 0.2-A read-only restano coperti. Root `TASK_PLAN.md` invariato; nessun lavoro 0.2-C/Efficiency Benchmark.
- **Gate locale:** Node `v22.19.0`; Plan Proposal **181 test: 180 PASS, 1 platform skip, 0 fail**; full suite **337 test: 336 PASS, 1 platform skip, 0 fail**; `npm run check` PASS. Pack/diff finali registrati al commit di remediation.
- **Residual LOW:** irreducibile transizione user-space→rename contro editor non cooperativo; directory sync esplicitamente unsupported non garantisce power-loss durability; ACL/Windows extended metadata non sono preservabili atomicamente con Node standard; stale lock e restart ambiguity richiedono riconciliazione umana.
- `checkpoint_message`: “0.2-B Round 1 BLOCKED remediation completa; pronta per independent review, gate 0/2”.

**STOP operativo:** non dichiarare CLOSED e non iniziare 0.2-C o Efficiency Benchmark prima delle relative autorizzazioni/gate.

# CHECKPOINT — AIOPAGO RENAME COMPLETE

- **Brand:** Aiopago. **Repository:** `kinderp/aiopago` (`https://github.com/kinderp/aiopago`). **Default branch:** `main`. **CLI canonical:** `aio`. **Legacy CLI:** `eio` (deprecated, thin wrapper, warning soltanto su stderr). **0.2-A:** CLOSED. **Rename:** COMPLETE. **Next:** 0.2-B Plan Proposal Foundation.
- Baseline canonica: `ab5100207f7714852b121352d8f389dfe92133a4`; HEAD applicativo 0.2-A: `f0faab642c4a2ed52b40417aab577e74fcd253ba`; implementation commit del rename: `3c7a786444c51931ef6cdb31d3e5945e03e9cf5d`. Il commit documentale che contiene questa sezione chiude il checkpoint; nessuna feature 0.2-B è stata iniziata.
- Worktree/branch dedicati: `F:/dev/aiopago-rename`, `chore/rename-aiopago`. Il worktree storico `F:/dev/eiopago-ux-0.2` è rimasto intatto a `ab5100207f7714852b121352d8f389dfe92133a4`.
- Remote rename eseguito sullo stesso repository GitHub, non tramite copia: repository ID prima/dopo `1324222061`, node ID `R_kgDOTu4GbQ`; `kinderp/eiopago` → `kinderp/aiopago`. `default_branch=main` è rimasto invariato. `origin` finale è `https://github.com/kinderp/aiopago.git`; fetch, `ls-remote` e dry-run push autenticato PASS.
- Package: nome `aiopago`, metadata repository/homepage/bugs canonici e npm registry check del vecchio nome = `E404`, quindi nessun compatibility package e nessuna pubblicazione. Non esisteva un package/module tree interno `eiopago`: nessun namespace o implementation duplicata è stato inventato.
- CLI/TUI: `bin/aio.mjs` è l'entrypoint canonico; `bin/eio.mjs` delega alla stessa `src/cli-entry.mjs`. `/aio` è canonico; `/eio` e `/eiopago` sono alias deprecati dello stesso handler. Help, version, status e `plan --raw` hanno stdout ed exit code equivalenti; i warning legacy non contaminano stdout.
- Environment: canonica `AIOPAGO_CONTEXT_HANDOFF_THRESHOLD_PERCENT`; fallback deprecato `EIO_CONTEXT_HANDOFF_THRESHOLD_PERCENT`; valori duali diversi falliscono con conflitto esplicito. Non esisteva alcuna variabile pubblica `EIOPAGO_*`, quindi nessuna layer artificiale è stata aggiunta.
- Persistent state: nessun path `~/.eiopago`, `.eiopago`, database/config brandizzato o directory equivalente esisteva. `.guardian/`, config, runtime SQLite e artifact restano nello stesso path e non vengono spostati, uniti o sovrascritti. `aio init` preserva byte per byte config, Ledger, runtime e managed `.gitignore` legacy validi; la presenza simultanea dei due blocchi managed fallisce esplicitamente.
- Schemi/protocolli: nuovi writer usano `aiopago.repository/1.0.0`, `aiopago.task-ledger/0.1.0`, `aiopago.runner-session-binding.v1`, schemi calibration `aiopago.*`, producer `aiopago-runner` e marker `AIOPAGO_RESUME_V1`. I reader accettano gli identificatori pre-rename esatti necessari (`eiopago.repository/1.0.0`, `eiopago.runner-session-binding.v1` e schemi calibration `eiopago.*`); Ledger/owner command pre-rename restano leggibili. Nessun dato persistito è stato riscritto retroattivamente.
- Provenance immutabile: `TASK_PLAN.md` e `docs/m1-h2-calibration-pilot.json` hanno diff byte nullo da `origin/main`; `TASK-EIOPAGO-*`, i record `PLAN-EIOPAGO-*`, il marker storico `EIOPAGO_RESUME_V1`, worktree/remotes realmente usati e le sezioni checkpoint precedenti restano invariati. Audit e documenti calibration chiusi sono marcati esplicitamente come historical pre-rename records.
- Legacy allowlist finale: (1) storia immutabile in `CHECKPOINT.md`, `TASK_PLAN.md`, protocollo pilot, audit e documenti H2 storici; (2) reader/fallback precisi per config, managed ignore, Ledger command, runner binding, calibration ed environment; (3) alias CLI/TUI deprecati; (4) migration note e test di compatibilità. Nessun uso legacy corrente fuori da queste categorie è autorizzato.
- Brand guard: `scripts/check-brand-migration.mjs`, integrato in `npm run check`, scansiona file tracked/untracked pertinenti, nomi path e token brevi separatamente, con path/count/rationale esatti; nuove occurrence o variazioni della allowlist falliscono.
- Gate pre e post GitHub rename: `npm test` **156/156 PASS**; `npm run check` **PASS, brand guard + 39 moduli**; `npm pack --dry-run` **PASS, 30 file**; `git diff --check` **PASS**. Warning SQLite experimental e LF→CRLF dei fixture sono informativi. Review `origin/main...HEAD`: zero finding HIGH/MEDIUM noti, nessun URL corrente stale, nessuna perdita di compatibilità/schema, nessun lavoro accidentale 0.2-B.
- Residual non bloccanti e intenzionali: alias `eio`/`/eio`/`/eiopago`, env fallback, reader legacy e provenance storica sopra; rimozione futura richiede una migration separata. Nessuna CI configurata da osservare. Nessun blocker aperto.
- `checkpoint_message`: “Aiopago rename completo: repository, package, CLI e compatibilità legacy verificati”.

**STOP operativo:** Dedicated Rename Migration chiusa. Non iniziare 0.2-B, Core Observation Port o nuove feature in questa sessione.

**Prossimo passo ESATTO:** `0.2-B Plan Proposal Foundation` in una nuova sessione e branch dedicati, partendo dalla `main` Aiopago canonica.

**Nome sessione suggerito:** `aiopago-0.2-b-plan-proposal-foundation`

**Prompt minimo di ripresa:**

> Lavora su `kinderp/aiopago`. Leggi `AGENTS.md` se presente, la prima sezione di `CHECKPOINT.md`, `docs/roadmap.md` e `docs/rename-aiopago-migration.md`; verifica repository, `origin`, default `main`, HEAD e status. Il rename Aiopago è COMPLETE e 0.2-A è CLOSED: non riaprire il rename o rimuovere compatibility legacy senza finding dimostrato. Crea branch/worktree dedicati da `main` e avvia esclusivamente 0.2-B Plan Proposal Foundation, preservando le invarianti safety-critical e senza anticipare 0.2-C o il Core Observation Port.

# CHECKPOINT — Eiopago 0.2-A CLOSED

- Worktree/branch: `F:/dev/eiopago-ux-0.2`, `feat/human-workflow-ux-0.2`; baseline `72461f653d217e8f18b3cba2c1b7ed46220cee4e`; **HEAD finale applicativo 0.2-A** `f0faab642c4a2ed52b40417aab577e74fcd253ba`. Il commit documentale che contiene questa sezione formalizza la chiusura senza cambiare il codice applicativo.
- **Status: 0.2-A CLOSED.** La Human Workflow UX read-only espone `status`, `why`, `next`, `plan`, `plan --raw`, `plan --check` e `plan --technical` senza avviare Pi, selezionare modelli, effettuare provider call o acquisire ownership runtime.
- Finding chiusi: tre HIGH su operation futura ignorata, mismatch latch/journal capace di occultare `HUMAN_TAKEOVER` e authorization/admission/journal incompleti; un MEDIUM sulla projection pubblica fail-open per `includeRuntime:false` e condition futura/sconosciuta.
- Boundary accettato: il core 0.1 non possiede un verifier read-only complessivo estraibile con puro refactor. `runtime-reader.mjs` osserva soltanto presenza, sidecar e stabilità dei byte, non apre/interpreta SQLite e non contiene una lifecycle state machine. Runtime assente, presente, concorrente, non osservato o non verificabile resta `NEEDS_ATTENTION`/`RUNTIME_NOT_VERIFIED`; nessun percorso pubblico costruisce `READY` o `SUSPENDED`.
- Acceptance: piano Markdown autorevole e modifiche umane preservati; `plan --raw` indipendente dal validator; `plan --check` usa `TaskLedger`; output normale bounded e senza dati runtime privati; repository non inizializzati, directory nested e linked worktree coperti; byte/hash/mtime di piano e runtime invariati; nessuna mutation o migrazione.
- Invarianti core preservate: `runner.mjs`, `handoff.mjs`, `safety.mjs`, `storage.mjs` e `runner-ownership.mjs` hanno diff nullo dalla baseline. Nessun Plan Proposal, Intent Adapter, start/stop, Human Action Broker, control channel o altro scope 0.2-B è stato introdotto.
- Gate finali: test mirati `test/human-workflow.test.mjs` **34/34 PASS**; `npm test` **147/147 PASS**; `npm run check` **PASS, 36 moduli**; `npm pack --dry-run` **PASS, 26 file**; `git diff --check` **PASS**. Warning SQLite experimental e LF→CRLF dei fixture sono informativi.
- Review finale: **APPROVE**, zero finding HIGH/MEDIUM/LOW bloccanti, nessun TODO/FIXME bloccante. Residual non bloccante e deliberatamente futuro: una runtime projection positiva richiede un Core Observation Port condiviso col core.
- Roadmap persistita in `docs/roadmap.md`. Il repository remoto resta `kinderp/eiopago`; il default branch remoto resta `feat/pi-usage-guardian-foundation`. Nessun rename è stato iniziato in 0.2-A.

**STOP operativo:** dopo la chiusura di 0.2-A non iniziare il rename né 0.2-B in questa sessione.

**Prossimo passo ESATTO:**

1. **Dedicated rename migration: Eiopago -> Aiopago**
2. dopo il rename: **0.2-B Plan Proposal Foundation**

**Nome sessione suggerito:** `eiopago-aiopago-dedicated-rename`

**Prompt minimo di ripresa:**

> Leggi integralmente `AGENTS.md` se presente, la prima sezione di `CHECKPOINT.md`, `docs/roadmap.md` e la documentazione di migrazione che verrà autorizzata. Verifica worktree, branch, HEAD, remotes, upstream e default branch. 0.2-A è CLOSED a `f0faab642c4a2ed52b40417aab577e74fcd253ba`; non riaprirla salvo regressione dimostrata. Esegui in una sessione dedicata soltanto il rename completo Eiopago -> Aiopago, con inventario, piano atomico, test e remote strategy esplicita. Non iniziare 0.2-B durante il rename. Dopo acceptance del rename, il passo successivo è 0.2-B Plan Proposal Foundation.

# CHECKPOINT — M1-P0-A Portable Bootstrap, Packaging e Config PASS

- Baseline e branch verificati: `9ed10f6148a144179cccce3c9141e4fa61c808e5`, `feat/m1-p0-portable-alpha`; nessun commit creato.
- Audit reale chiuso: il vecchio bin usava `process.cwd()` come root unico, non esistevano `eio init`, config repository, `bin` package/exports/files o target esplicito; il loader Pi cercava soltanto env/node adiacente e il Runner creava stato direttamente sotto il cwd.
- Contratto implementato: installation root del package separata da Git target root; config root `.guardian`, runtime root `.guardian/runtime`, artifact root `.guardian`, Ledger path e target vengono validati e passati esplicitamente al Runner.
- `eio init [target|--target]` verifica Node >=22.19, Git worktree e Pi 0.83.x; crea config strict `eiopago.repository/1.0.0`, template Ledger solo se assente, runtime ignored e blocco `.gitignore` bounded. Re-init preserva byte Ledger/config/ignore e non cancella runtime o file estranei; Ledger non riconosciuto/ambiguo e path riservati rediretti via symlink/junction falliscono prima delle modifiche.
- Packaging alpha Node standard: package con `bin.eio`, export ESM, files allowlist, engine e peer Pi; uso previsto `npm link` o install globale da path. Help/version, init e launch target entrypoint sono reali; il completo dogfood launcher multi-repository resta P0-B.
- Plumbing core minimo: il Runner riceve root esplicite; se il Ledger portable lascia il model policy nullo, il modello realmente selezionato da Pi diventa la policy handoff effettiva. Safe point, latch, exactly-once admission, continuity, takeover e dispatch semantics non sono cambiati.
- Cold review: corretti fail-open su Ledger duplicato, redirect symlink/junction, esposizione di file `.guardian` sconosciuti e selezione accidentale di Pi dal target; aggiunti test package-cwd e model policy Pi effettiva. Documentazione: `docs/portable-alpha.md`.
- Gate finali cold review: `npm run check` PASS (32 moduli), `npm test` PASS (81/81), `git diff --check` PASS con soli warning informativi LF/CRLF, `npm pack --dry-run` PASS (24 file).
- Nessun H2 pilot o RUN-40/50/60, nessun cambio threshold/Advisor, nessun Cost Guard, Chronicle, P0-B o dogfood Alfred/Durex/FARO.

**STOP operativo:** P0-A è chiuso. Non iniziare P0-B senza autorizzazione separata.

# CHECKPOINT — M1-H2 H2-02A-F1 Deterministic Calibration Bootstrap PASS

- Perimetro esclusivo: issue #10, `H2-02A-F1`; nessun workload/pilot, model call reale, RUN-40/50/60, Cost Guard, Advisor adattivo, modifica workload/soglie globali o commit. HEAD di partenza/precedente experiment baseline: `d6a4b9cfa1e3c15cc0c9ea9ad9ead89216346254`; il nuovo experiment baseline sarà soltanto il futuro commit di freeze/acceptance F1.
- Root cause registrata: attempt 1 RUN-40 aveva protocollo ignored non materializzato prima del Runner; il Runner creava SQLite prima del controllo interno, rendendo invalido il criterio di assenza runtime; Git clean, threshold, model, reasoning, confirm e digest completo non erano autorevolmente attestati. Il fail-closed osservato era corretto.
- Implementato bootstrap minimo `scripts/calibration-run.mjs` + `src/calibration-preflight.mjs`: verifica locale di worktree/root, HEAD completo, branch, clean status, Pi/Node, JSON/blob Git, digest protocollo/prompt e variante; genera run_id UUID e persiste copia byte-identica, attestation `eiopago.calibration-preflight/1.0.0` e run-record `PREFLIGHT_PASSED` nell'area ignored prima del Runner.
- Runtime isolation: SQLite è `.guardian/calibration/<run_id>/runtime/guardian.sqlite`; migration 4 persiste `run_id`, `runtime_store_id` e digest attestation. Path preesistente, dati domain precedenti o identità diversa falliscono chiuso; nessun database esistente viene cancellato. Corretto esplicitamente il vecchio requisito “SQLite assente dopo startup”.
- Controlled state: il launcher deriva/fissa la threshold dalla variante, imposta env process-local e opzione SDK; Pi SDK pubblica fissa modello e `thinkingLevel` e il runtime verifica `AgentSession.model`/`thinkingLevel`; confirm è opzione Runner `confirm` e rifiuta manual. Input gate e transport gate rivalidano attestation/stato prima del workload/provider stream.
- Protocollo aggiornato senza cambiare workload/prompt: digest prompt resta `d89957e5c3ccae4ad4ac57b5458fc7d45044cb1e8e22da1f4da2b7c22299af58`; digest protocollo F1 `0af31e2ee41061c153d1e7c4cfaaf098db44f58ee41f15333b31b8afeb8bd2c1`. `RUN-40-ATTEMPT-1=INVALID_PREFLIGHT`, non replica, non resumable/reclassificabile. H2-02B resta PLANNED/BLOCKED.
- Test bootstrap offline: 17/17 PASS, incluso happy path, HEAD/branch/dirty, digest/copia, threshold/model/reasoning/confirm, contaminazione/identity SQLite, duplicate ID, missing attestation, mismatch runtime e transport fail-closed prima della call. Nessun launcher TUI o provider reale avviato. Il primo full-suite attempt ha esposto l'env ambientale threshold=40 nel fixture E2E storico; il fixture è stato reso esplicito a 50 senza cambiare il default. Gate finali: `npm run check` PASS (23 moduli), `npm test` PASS (46/46, E2E 6/6), `git diff --check` PASS con soli warning LF→CRLF.
- Ledger: `PLAN-M1-H2-0005`; `ITEM-H2-02A-F1=DONE`, `ITEM-H2-02B=BLOCKED`. Comando futuro, solo dopo freeze F1 e autorizzazione H2-02B: `npm run calibration -- --variant RUN-40 --experiment-baseline <SHA_F1>`; cold review: `npm run calibration -- --resume-run <run_id>`.
- Limiti/unknown: Pi attesta modello selezionato e reasoning effettivo, non seed/temperature non esposti né un eventuale routing upstream opaco del provider; charged cost resta unknown come in H2-01. Trust boundary locale, senza firma contro amministratore filesystem. Nessun commit creato.
- Esito: **H2-02A-F1 PASS**. `checkpoint_message`: “H2-02A-F1 PASS: bootstrap attestato e SQLite run-specific; nessun pilot avviato”.

**STOP operativo:** non creare/avviare un nuovo RUN-40/50/60. Serve acceptance/commit F1 e autorizzazione H2-02B separata.

# CHECKPOINT — M1-H2 H2-02A Controlled Calibration Protocol PASS

- Perimetro eseguito esclusivamente: issue #9, `H2-02A`; application baseline H2-01 `930fc35d03d3f9795fa6402a047b0ded489e2817` invariata. L'experiment baseline è il commit di freeze che contiene questa sezione e il protocollo: il suo SHA va nei futuri run record, non nel manifest, evitando dipendenze circolari. Nessun RUN-40/50/60, Cost Guard, Advisor adattivo o cambio del default globale.
- Congelato `H2-02A-PILOT-1`: i tre futuri worktree/branch devono partire identicamente dall'experiment baseline commit, con unica variabile intenzionale threshold process-local 40/50/60, modello `openai-codex/gpt-5.6-sol`, reasoning high, Pi 0.83.0, confirm, acceptance e completion identici, zero history copiata.
- Workload scelto: `WL-HANDOFF-INCIDENT-INSPECTOR-1`, inspector locale read-only per incidenti handoff, con core, CLI, fixture/test/documentazione e cold review/fix in sessione pulita. È reale, non implementato, offline e non modifica soglie; nessun padding.
- Non è garantibile il 60% su 272k: il protocollo richiede crossing autorevole più lifecycle completo per un run VALID; completion prima soglia è `CENSORED_EARLY_COMPLETION`, non evidenza della variante.
- Quality baseline semplice: quattro gate PASS, nessuna regressione/finding bloccante/perdita di stato, quattro WCP accettati e rework registrato. Charged ed equivalent cost hanno aggregazioni e Cost per Accepted Checkpoint separati; token/costo puro handoff resta unknown se non attribuibile.
- Artefatti: `docs/m1-h2-threshold-calibration.md`, `docs/m1-h2-calibration-pilot.json`; Ledger `PLAN-M1-H2-0004`, H2-02A DONE e H2-02B PLANNED. Il commit corrente effettua il freeze; prima del pilot restano run-record/extraction preflight e autorizzazione H2-02B.
- Solo documentazione/protocollo: nessuna suite applicativa ripetuta. Validazione strutturale e `git diff --check` eseguite come gate documentali.
- Esito: **H2-02A PASS**. `checkpoint_message`: “H2-02A PASS: protocollo pilot 40/50/60 congelato; nessun run avviato”.

**STOP operativo:** non creare worktree pilot e non iniziare RUN-40 senza autorizzazione esplicita H2-02B.

# CHECKPOINT — M1-H2 H2-01 Measurement Instrumentation PASS

- Perimetro eseguito esclusivamente: issue #9, `H2-01`; baseline M1-H1 `b317f79c9723136203e24d216467ef80601cb64a` preservata. Nessun esperimento 40/50/60, cambio soglia, Cost Guard, auto-handoff, supervised-auto, routing o integrazione esterna.
- Implementato schema `eiopago.metrics/1.0.0`: summary sessione, sample automatico per assistant `turn_end`, eventi handoff misurati e diagnostici. Correlazione session/task/item/checkpoint/handoff quando nota; quality/rework predisposti con valori null senza score inventato.
- Superfici Pi 0.83.0 usate: `session_start`, `session_shutdown`, `turn_end.message.usage`, `ctx.getContextUsage()` e `ctx.sessionManager.getSessionId()`. Charged/provider cost, subscription equivalent, cache-hit rate e minimal reads realmente osservate restano explicit unknown.
- Overhead misurato da byte reali: stat di `TASK_PLAN.md`, buffer sealed checkpoint/manifest e `Buffer.byteLength` del resume prompt. Il count dichiarato nel manifest è separato dalle reads effettive unknown; nessuna conversation history/prompt/response viene salvata.
- Persistenza: tabelle bounded nello SQLite Guardian esistente; default 100 sessioni, 2.000 sample, 1.000 eventi handoff e 100 diagnostici. Il journal resta autorità del lifecycle operativo H1; le tabelle metriche sono autorità delle sole misure.
- Failure telemetry è non decisionale/non bloccante: nessuno zero inventato, diagnostico minimale bounded senza testo potenzialmente sensibile. Lifecycle H1 e soglia default 50% non sono stati modificati.
- Test H2 mirati: **7/7 PASS**. Gate finali: `npm run check` **PASS** (20 moduli); `npm test` **PASS** (29 test, 22 top-level, E2E 6/6); `git diff --check` **PASS** con solo warning informativo LF→CRLF su `TASK_PLAN.md`.
- Ledger: `PLAN-M1-H2-0002`; `ITEM-H2-01=DONE`, `ITEM-H2-02=PLANNED`, `current_item=null`, `next_item=ITEM-H2-02`. Documentazione: `docs/m1-h2-threshold-calibration.md`.
- Esito: **H2-01 PASS**. Prima di H2-02 servono nuova autorizzazione, protocollo controllato, run comparabili e associazione acceptance/quality baseline.
- `checkpoint_message`: “H2-01 PASS: telemetry Pi/runtime bounded, correlata e privacy-safe; 29/29 test verdi”.

**STOP operativo:** non avviare H2-02 o dogfood 40/50/60 e non dichiarare una soglia ottimale senza nuova autorizzazione esplicita.

# CHECKPOINT — M1-H1 PASS; dogfood post-fix e acceptance completati

## Sessione B — chiusura H1-02/H1-03

- Handoff reale post-fix: `HO-27f6d0dcd68e7349bdd149de`, source `019fe1fb-d7b3-71f5-ac0e-dfd35e3f268d`, replacement `019fe1fc-aeca-76b7-99b5-c880d3b75a7d`.
- Evidenza runtime autorizzata dall'owner: Runner ownership attestata, Continuity Check **PASS**, resume admission autorizzata una sola volta e Sessione B ripresa con `ITEM-H1-02=IN_PROGRESS`, `current_item=ITEM-H1-02`, `next_item=ITEM-H1-03`, `owner_gate=SATISFIED`.
- History transfer: **ZERO**. Il codice esclude conversation history dal target e il manifest non contiene transcript; i sei minimal read sealed sono stati letti realmente.
- Review statica F1: coerente con il runtime. `TaskLedger.satisfyOwnerGate()` avanza atomicamente il Ledger prima del safe point/seal; `newSession({ setup })` installa una sola CustomEntry non-context; SQLite e journal persistono `RUNNER_SESSION_BOUND`; manifest e Continuity richiedono uguaglianza runtime/journal/manifest/current Runner; admission e dispatch sono idempotenti/fail-closed.
- Metriche post-fix Sessione A (`019fe1fb…`) e B (`019fe1fc…`): context, token, cache e costo **unknown**, perché checkpoint e runtime evidence non contengono snapshot usage. Le metriche 140.837 input / 23.074 output / 8.367 reasoning / 3.049.472 cache-read / USD 2,921141 appartengono alla sessione storica pre-fix `019fe1c2…` e non sono attribuite al nuovo dogfood.
- Dimensioni esatte di `TASK_PLAN.md`, checkpoint, manifest e resume prompt: **unknown**; l'API file corrente non espone byte-stat e non viene sostituita con stime. Checkpoint `CP-7a6eed065a7069546349c82f` e manifest `RM-b5ec41729aab629d55ad89a4` sono disponibili come file; il resume prompt `RP-a38d491dd73939115c57fc31` è disponibile inline ma non come file standalone. Minimal reads: **6**.
- Friction umana post-fix: comando sorgente `/eio handoff confirm` e una conferma separata per l'unica resume admission. Nessun failure riportato nel run post-fix. Restano storici il tentativo API/non-TTY fallito prima del latch e i finding A/B del primo dogfood reale.
- Gate shell finali eseguiti manualmente dall'owner nel TUI: `npm run check` **PASS** (`syntax ok: 18 modules`); `npm test` **PASS** (**22/22**, 15 top-level, E2E 6/6, zero failure); `git diff --check` **PASS**, con solo warning informativo LF→CRLF su `TASK_PLAN.md`.
- Stato finale: `TASK_PLAN.md` revisionato a `PLAN-M1-H1-0007`; task `DONE`, H1-02 `DONE`, H1-03 `DONE`, `current_item=null`, `next_item=null`. Owner gate `SATISFIED`; H1-01 non ripetuto, nessun nuovo handoff, Cost Guard e M1-H2 non iniziati.
- Esito milestone: **M1-H1 PASS**.
- `checkpoint_message`: “M1-H1 PASS: dogfood F1 reale e 22/22 test accettati”.

**STOP operativo:** M1-H1 è chiusa. Non eseguire un altro handoff, non iniziare Cost Guard o M1-H2 e non creare commit senza autorizzazione separata.

# CHECKPOINT — M1-H1-F1 implementato e testato offline; stato pre-dogfood superato

## Issue #8 — owner gate persistito e Runner ownership attestabile

- Data: 2026-08-08; sessione fix `019fe1ed-0ab4-70e1-9475-8e809324c93c`; perimetro esclusivo `M1-H1-F1`. H1-01 e SP-01…SP-04 non ripetuti; Cost Guard e integrazioni esterne non iniziati.
- **Causa Finding A:** `/eio handoff confirm` leggeva il Ledger senza transizionare il gate canonico. I tre handoff reali precedenti hanno quindi sigillato correttamente artefatti tecnici ma con lifecycle stale (`current_item=null`, `next_item=ITEM-H1-02`, vecchio owner step).
- **Fix Finding A:** `TaskLedger.satisfyOwnerGate()` richiede comando esatto e attore umano, valida il lifecycle bloccato e persiste atomicamente la nuova revisione Markdown prima che il piano venga usato per checkpoint/manifest. L'E2E prova `H1-01=DONE`, `H1-02=IN_PROGRESS`, `current_item=ITEM-H1-02`, `next_item=ITEM-H1-03` e un vero next step senza nuova richiesta handoff.
- **Causa Finding B:** il solo `replacement_session_id` in projection/manifest non forniva alla sessione runtime corrente una prova Runner-owned; il fail-closed osservato era corretto.
- **Meccanismo scelto:** il processo Runner genera `runner_instance_id`; l'handoff genera `session_binding_id` casuale. La API pubblica Pi `newSession({ setup })` installa una CustomEntry non-context `eiopago.runner-session-binding.v1` nella replacement session prima di qualsiasi conversation entry. Il binding contiene `handoff_id`, vero `replacement_session_id` del SessionManager, `runner_instance_id` e nonce.
- **Persistenza/attestazione:** la relazione è salvata nella tabella SQLite `runner_session_bindings`, nell'evento append-only `RUNNER_SESSION_BOUND` e nel manifest sealed. Continuity richiede `runtime binding == SQLite/journal event == manifest == handoff/current Runner`; binding assente/duplicato, Runner/target/nonce/handoff diverso o stato `SUPERSEDED` produce `RUNNER_OWNERSHIP_ATTESTATION_FAILED` e nessuna admission.
- **Test aggiunti:** attestation PASS e tutti i mismatch richiesti fail-closed; sessione Pi non Runner-owned; binding SQLite/journal active→superseded; owner gate blocked→confirm→Ledger avanzato→checkpoint/manifest→replacement Runner-owned→continuity→resume; resume prompt senza seconda richiesta; duplicate resume con una sola admission.
- **Verifiche finali:** `npm run check` PASS, **18 moduli**; `npm test` PASS, **22/22** (**15** top-level, E2E **6/6**), zero failure e provider fake offline; `git diff --check` PASS con soli warning informativi LF→CRLF.
- `TASK_PLAN.md` è `PLAN-M1-H1-0005`, stato `IN_PROGRESS`, `owner_gate=SATISFIED`, `current_item=ITEM-H1-02`, `next_item=ITEM-H1-03`. H1-01 non è stato ripetuto e H1-02 non è dichiarato DONE.
- Documentazione: `docs/m1-h1-context-handoff-advisor.md`. Limite esplicito: il trust boundary è il processo/filesystem locale; nessuna firma anti-amministratore locale e nessun recovery automatico post-crash/general-purpose orchestrator.
- Il precedente vincolo sul nuovo dogfood è stato successivamente revocato dall'owner: il run post-fix `HO-27f6d0dcd68e7349bdd149de` è riuscito ed è registrato nella sezione corrente sopra. I vecchi artefatti sealed non sono stati riscritti.
- `checkpoint_message`: “M1-H1-F1: owner gate avanzato prima del seal e replacement ownership attestata runtime/journal/manifest”.

**STOP operativo storico superato:** review e dogfood reale post-fix sono avvenuti. Non eseguire un altro handoff e non iniziare Cost Guard.

# CHECKPOINT — M1-H1 PARTIAL/BLOCKED prima dell'input handoff reale

## Safe point Sessione A — Context Handoff Advisor

- Data: 2026-08-08; sessione Pi A `019fe1c2-19f4-7e45-88df-e89e35f4f83c`; profilo verificato `openai-codex/gpt-5.6-sol`, reasoning `high`.
- Isolamento verificato: branch `feat/m1-h1-context-handoff-advisor`, worktree `F:/dev/eiopago-m1-h1`, HEAD baseline `84953671bc97d40efbf6f838f8ae08f3a40a4bd4`. Il worktree principale e le sue modifiche storiche non sono stati alterati, stageati o inclusi.
- Issue #7 letta in sola lettura. Non sono stati ripetuti M0.1 o SP-01…SP-04 e non sono stati iniziati Cost Guard, hard budget, billing, supervised-auto, TokenSave o router.
- `TASK_PLAN.md` è il Ledger M1-H1 revisionato `PLAN-M1-H1-0004`: task `BLOCKED`, `ITEM-H1-01=DONE` con evidenza, `current_item=null`, `next_item=ITEM-H1-02` bloccato; H1-03 non avviato.
- H1-01 implementato: `ContextHandoffAdvisor` usa `ctx.getContextUsage()` quando disponibile, soglia validata configurabile tramite opzione Runner o `EIO_CONTEXT_HANDOFF_THRESHOLD_PERCENT`, default indicativo 50%, una proposta per permanenza sopra soglia e riarmo sotto soglia.
- UX advisory: a soglia raggiunta chiede consenso; soltanto dopo risposta positiva precompila `/eio handoff confirm`. Non esegue handoff autonomo, non impegna latch, non blocca transport/richieste e non introduce hard stop.
- Evidenza: test mirati advisor **2/2 pass**; `npm run check` **17 moduli pass**; `npm test` **12/12 pass**; `git diff --check` pass.
- Metriche A al snapshot pre-report: 110 entry JSONL, 37 usage entry; input 140.837, output 23.074, reasoning 8.367, cache read 3.049.472, cache write 0, costo equivalente riportato USD 2,921141. Prima usage 3.569 token (1,31% derivato su 272.000); ultima usage completata 120.909 (44,45% derivato). `ctx.getContextUsage()` corrente non è esposto a questa sessione API, quindi l'occupazione finale corrente resta `unknown` e non viene inventata.
- Gate dogfood eseguito senza harness/fake di handoff: `npm run eio` dal worktree isolato ha avviato il vero Guardian Runner e caricato `<inline:eiopago-m1-h1>`, modello/reasoning corretti. Il tool API espone però stdin/stdout non-TTY e nessun canale per inviare il comando TUI; dopo 20 secondi il tentativo è scaduto prima di poter digitare `/eio handoff confirm`.
- Failure point esatto: **prima** di latch, safe point M1-H0, checkpoint, replacement e manifest. Stato verificato: latch `RELEASED`, generation `0`, `latestHandoff=null`; checkpoint/manifest/resume prompt/Sessione B non generati. Conversation history copiata: zero, ma non esiste un happy path completato.
- Il processo TUI PID 22268 è rimasto attivo dopo il timeout del tool ed è stato terminato in modo mirato con `taskkill`; nessun altro processo è stato toccato. Il fallback manuale M1-H0 non esiste per questo failure pre-command, quindi non è stato inventato né sostituito con copia/incolla.
- Intervento necessario: avviare il task fin dall'inizio dentro un TUI posseduto dal Guardian Runner M1-H0 e usare lì `/eio handoff confirm`. Collegare retroattivamente il Runner alla sessione API corrente o automatizzare `handoffDirect` sarebbe una simulazione vietata.
- Esito milestone corrente: **PARTIAL/BLOCKED**. H1-01 funziona, ma acceptance issue #7 non passa perché Sessione A → B e Continuity Check non sono avvenuti.
- `checkpoint_message`: “M1-H1 advisor verificato; dogfood bloccato prima dell'input /eio nel TUI”.

**Nome sessione suggerito:** `eiopago-m1-h1-dogfood-resume`

**Prompt minimo di ripresa:**

> Avvia Pi dal worktree `F:/dev/eiopago-m1-h1` sotto il Guardian Runner M1-H0 con TUI interattivo; verifica Git e profilo high e leggi `TASK_PLAN.md` revisione `PLAN-M1-H1-0004` più la prima sezione di `CHECKPOINT.md`. H1-01 è DONE (advisor 2/2, check 17, suite 12/12): non ripeterlo. Sblocca H1-02 soltanto tramite handoff reale `/eio handoff confirm`, senza history copiata o `handoffDirect`; poi misura Sessione B e artefatti. Non iniziare Cost Guard.

# CHECKPOINT — M1-H0 riaccettato sui tre finding mirati

## Ultima sessione — nuova acceptance sul diff corrente

- Data: 2026-08-08; sessione Pi `019fe0d1-9320-756b-b429-96e43af51ac4`.
- Gate verificato: `PI_PROVIDER=openai-codex`, `PI_MODEL=gpt-5.6-sol`, `PI_REASONING_LEVEL=high`; repository `F:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, HEAD `7439ef68f3e859c8655c8be07846a07064c0edb4`, upstream `80b8193b5a9559bde7c6c20d806042c4c5263d18`, identità Git `kinderp <a.caristia@gmail.com>`, nessun index lock. Worktree dirty preesistente preservato.
- Ambito eseguito esclusivamente come nuova acceptance dei tre finding M1-H0 sul diff corrente. Audit e SP-01…SP-04 non ripetuti; Cost Guard, M1.1/M1.2 e integrazioni esterne non iniziati.
- Esito: **PASS**. Il takeover escalato a `HUMAN_TAKEOVER` resta engaged e la stale confirm non rilascia il latch, non crea authorization/admission e non raggiunge il dispatch.
- Esito: **PASS**. I digest SHA-256 di index e worktree sono valorizzati, trasportati e confrontati fail-closed; il test rileva byte dirty e staged diversi anche con status porcelain invariato.
- Esito: **PASS**. Il Ledger canonico valida `current_item`/`next_item`; manifest e resume prompt li preservano e l'E2E aggiorna realmente la fonte da `PLAN-E2E-1` a `PLAN-E2E-2` dopo il lavoro source e prima dell'handoff.
- Verifiche eseguite: test mirati **3/3 pass**; `npm run check` pass su 16 moduli; `npm test` **10/10 pass** (core offline 6/6, E2E Pi reale/provider fake 4/4); `git diff --check` pass, con soli warning informativi LF→CRLF.
- `TASK_PLAN.md` avanzato a `PLAN-M1-H0-0003`, stato `DONE`, lifecycle chiuso (`current_item=null`, `next_item=null`) con evidenza di questa acceptance. Nessun file applicativo modificato durante l'acceptance e nessun commit eseguito.
- Invarianti confermati nel solo ambito valutato: `REQUIRES_RUNNER`, **FINISH CURRENT ATOMIC OPERATION** e `RESUME_DISPATCH_UNKNOWN` fail-closed senza retry cieco.
- `checkpoint_message`: “M1-H0 riaccettato: tre finding corretti e 10/10 test pass”.

**Nome sessione suggerito:** `eiopago-post-m1-h0-owner-gate`

**Prompt minimo di ripresa:**

> Verifica Git/profilo e leggi la prima sezione di `CHECKPOINT.md`. M1-H0 è accettato e il Ledger è chiuso; non iniziare Cost Guard, M1.1/M1.2 o integrazioni esterne senza nuova autorizzazione esplicita.

# CHECKPOINT — Tre finding M1-H0 corretti, nuova acceptance pendente

## Ultima sessione — correzioni mirate sul commit 7439ef6

- Data: 2026-08-08; sessione Pi `019fe0c5-a9b8-71b8-a6a8-5542af82887c`.
- Gate verificato: `PI_PROVIDER=openai-codex`, `PI_MODEL=gpt-5.6-sol`, `PI_REASONING_LEVEL=high`; repository `F:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, HEAD `7439ef68f3e859c8655c8be07846a07064c0edb4`, upstream `80b8193b5a9559bde7c6c20d806042c4c5263d18`, identità Git `kinderp <a.caristia@gmail.com>`, nessun index lock. Worktree preesistente dirty preservato.
- Ambito eseguito esclusivamente sui tre finding M1-H0 autorizzati. Audit e SP-01…SP-04 non ripetuti; Cost Guard, M1.1/M1.2 e integrazioni esterne non iniziati.
- **Takeover corretto:** `authorizeAndAdmit()` rifiuta transazionalmente `HUMAN_TAKEOVER_ACTIVE`; una conferma handoff pendente non rilascia il latch, non crea authorization/admission e non avvia dispatch.
- **Git continuity corretta:** `GitState` calcola digest SHA-256 verificabili dell'index e dei byte/mode del worktree tracciato o untracked non ignorato; `sameGitState()` richiede e confronta entrambi. Checkpoint e manifest li trasportano e Continuity li valida. Il test riproduce byte dirty e staged diversi con status porcelain invariato.
- **Ledger lifecycle corretto:** il Ledger canonico revisionato espone e valida `current_item`/`next_item`; manifest e resume prompt li preservano. L'E2E aggiorna realmente la fonte Markdown da `PLAN-E2E-1` a `PLAN-E2E-2` dopo il lavoro source e prima dell'handoff, poi verifica revisione, digest e lifecycle ripreso. `TASK_PLAN.md` è ora `PLAN-M1-H0-0002`, con item dei finding corrente fino alla nuova acceptance esterna.
- Verifiche finali: `npm run check` pass su 16 moduli; `npm test` **10/10 pass** (core offline 6/6, E2E Pi reale/provider fake 4/4); `git diff --check` pass. Nessun commit eseguito.
- Garanzie invarianti preservate: `REQUIRES_RUNNER`, **FINISH CURRENT ATOMIC OPERATION** e `RESUME_DISPATCH_UNKNOWN` fail-closed senza retry cieco.
- `checkpoint_message`: “M1-H0: corretti takeover stale-confirm, digest Git e lifecycle Ledger current/next”.

**Nome sessione suggerito:** `eiopago-m1-h0-reacceptance`

**Prompt minimo di ripresa:**

> Verifica Git/profilo e leggi la prima sezione di `CHECKPOINT.md`. Esegui soltanto nuova acceptance dei tre finding M1-H0 sul diff corrente; non ripetere audit/SP e non iniziare Cost Guard, M1.1/M1.2 o integrazioni esterne.

# CHECKPOINT — M1-H0 acceptance bloccata da finding mirati

## Ultima sessione — acceptance issue #6 sul commit 7439ef6

- Data: 2026-08-08; sessione Pi `019fe0c1-0a7c-77db-8563-b7eb915fc746`.
- Gate verificato: `PI_PROVIDER=openai-codex`, `PI_MODEL=gpt-5.6-sol`, `PI_REASONING_LEVEL=high`; repository `F:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, HEAD `7439ef68f3e859c8655c8be07846a07064c0edb4`, upstream `80b8193b5a9559bde7c6c20d806042c4c5263d18`, identità Git `kinderp <a.caristia@gmail.com>`, nessun index lock. Worktree preesistente dirty preservato; il codice/test valutato coincide col commit.
- Letti regole operative, sola precedente prima sezione del checkpoint, `TASK_PLAN.md`, handoff MVP, ADR-0015 e issue GitHub #6 in sola lettura. Audit e SP-01…SP-04 non ripetuti; Cost Guard, M1.1/M1.2 e integrazioni esterne non iniziati.
- Esito acceptance: **BLOCKED**. Il commit copre gran parte del vertical slice e `npm run check` passa su 16 moduli; `npm test` passa **8/8**, ma restano tre finding vincolanti.
- **P1 — takeover aggirabile:** `authorizeAndAdmit()` verifica solo stato/generation del latch e non la causa `HUMAN_TAKEOVER`; una conferma handoff già pendente può quindi rilasciare il takeover, committare admission e proseguire. Riproduzione locale: latch escalato a takeover → admission `COMMITTED`, latch `RELEASED` da `human:stale-confirm`.
- **P1 — Git continuity incompleta:** `observeGitState()` lascia `index_digest`/`worktree_digest` null e `sameGitState()` confronta solo identità e righe porcelain. Cambiare i byte di un file già dirty senza cambiarne lo status produce `sameGitState=true`, quindi un mismatch reale può passare continuity.
- **P2 — Ledger/E2E non soddisfa current/next e update:** il Ledger canonico non contiene `current_item`/`next_item`; il reader deriva soltanto `current_item` dal primo item `IN_PROGRESS` e non espone `next_item`. Nel Ledger committato, tutto `DONE` produce `current_item=null`. Inoltre l'handoff importa il Ledger read-only e l'E2E usa una fixture già predisposta, senza dimostrare il criterio issue #6 “Ledger aggiornato” durante il flusso.
- Nessun file applicativo modificato e nessun commit eseguito. Unica modifica della sessione: questo checkpoint operativo.
- `checkpoint_message`: “M1-H0 acceptance bloccata: takeover, digest Git dirty e lifecycle Ledger/E2E da correggere”.

**Nome sessione suggerito:** `eiopago-m1-h0-fix-acceptance`

**Prompt minimo di ripresa:**

> Verifica Git/profilo; leggi regole operative, prima sezione di `CHECKPOINT.md`, issue #6, `TASK_PLAN.md`, `docs/m1-h0-handoff-mvp.md` e ADR-0015. Con nuova autorizzazione, correggi soltanto i tre finding M1-H0 sul commit 7439ef6: takeover non rilasciabile da conferma pendente, digest Git index/worktree verificabili e lifecycle Ledger current/next con E2E che dimostri l'update. Mantieni `REQUIRES_RUNNER`, FINISH CURRENT ATOMIC OPERATION e `RESUME_DISPATCH_UNKNOWN` fail-closed; non ripetere audit/SP-01…SP-04 e non iniziare Cost Guard, M1.1/M1.2 o integrazioni esterne.

# CHECKPOINT — M1-H0 revisionato e consolidato

## Ultima sessione — review mirata e commit issue #6

- Data: 2026-08-08; sessione Pi `019fe02e-522e-714d-b0e2-8cd1ff15d3b9`.
- Gate verificato: `PI_PROVIDER=openai-codex`, `PI_MODEL=gpt-5.6-sol`, `PI_REASONING_LEVEL=high`; repository `F:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, HEAD/upstream iniziale `80b8193`, identità Git `kinderp <a.caristia@gmail.com>`, nessun index lock.
- Letti regole operative, sola precedente prima sezione del checkpoint, Ledger, handoff MVP, ADR-0015 e diff pertinenti. Issue GitHub #6 letta direttamente in sola lettura; audit e SP-01…SP-04 non ripetuti.
- Review mirata chiusa sulle decisioni vincolanti: `REQUIRES_RUNNER`, **FINISH CURRENT ATOMIC OPERATION**, replacement paused/no-history, admission locale unica e `RESUME_DISPATCH_UNKNOWN` fail-closed restano invariati.
- Corretto il tracking degli effetti `edit`/`write`: Pi non ripete `args` in `tool_execution_end`, quindi il Runner conserva il path ammesso da `tool_call` e lo usa come effect reference terminale; mutazioni senza riferimento restano `HUMAN_DECISION_REQUIRED`.
- Aggiunto takeover/pause minimo `/eio takeover` (`/eio pause` accettato): latch durevole `HUMAN_TAKEOVER`, queue/retry/compaction chiusi e safe point tool-aware, senza avviare integrazioni o Cost Guard.
- Rafforzato Continuity Check su GitState del checkpoint e policy model/reasoning del manifest. Il prompt E2E verifica esplicitamente `current_item` e `next_step`.
- Gestiti create cancellato/ambiguo come `HANDOFF_FAILED`: nessun secondo target, checkpoint preservato e istruzioni numerate persistite/visibili da `/eio status`; nessun manifest finale viene inventato senza il vero target ID.
- Verifiche finali: `npm run check` pass su 16 moduli; `npm test` **8/8 pass** (core offline 4/4, E2E Pi reale/provider fake 4/4, inclusi `/eio takeover`, `/eio handoff manual` e failure create), zero tentativi rete nei test.
- Consolidato esclusivamente il vertical slice M1-H0 e i suoi artefatti applicativi/documentali; PDF e lavoro preesistente SP/audit non sono stati inclusi né alterati intenzionalmente. Nessuna configurazione `~/.pi` modificata.
- Limiti invariati: `node:sqlite` experimental; provider fake offline; create-session→journal non ACID; recovery unattended/hardening fuori scope. Issue #6 resta soggetta ad acceptance esterna, che il commit non implica.
- `checkpoint_message`: “M1-H0 review chiusa: handoff paused/no-history, takeover e fallback fail-closed verificati”.

**Nome sessione suggerito:** `eiopago-m1-h0-acceptance`

**Prompt minimo di ripresa:**

> Verifica Git e profilo; leggi regole operative, prima sezione di `CHECKPOINT.md`, `TASK_PLAN.md`, `docs/m1-h0-handoff-mvp.md` e ADR-0015. Valuta soltanto acceptance/finding di M1-H0 issue #6 sul commit indicato nel messaggio precedente; non ripetere audit o SP-01…SP-04 e non iniziare Cost Guard, M1.1/M1.2, provider o integrazioni esterne senza nuova autorizzazione.

# CHECKPOINT — M1-H0 Automatic Session Handoff MVP implementato

## Ultima sessione — issue #6, vertical slice owner-controlled

- Data: 2026-08-08; sessione Pi `019fe012-6014-7a8d-8858-d04c64260f56`.
- Gate verificato prima delle decisioni: `PI_PROVIDER=openai-codex`, `PI_MODEL=gpt-5.6-sol`, `PI_REASONING_LEVEL=high`. Repository reale `F:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, HEAD/upstream `80b8193`, nessun index lock; modifiche SP-01…SP-04 e PDF preesistenti preservati.
- Letti regole operative, sola prima sezione del checkpoint, SP-01/SP-02/SP-03/SP-04, ADR-0015, roadmap, contratti pertinenti e documentazione/esempi Pi necessari. Audit e spike chiusi non sono stati ripetuti; Cost Guard completo, supervised-auto, provider esterni, dashboard e SP-05+ non sono stati iniziati.
- Creato `TASK_PLAN.md` revisionato `PLAN-M1-H0-0001`, Markdown canonico con import deterministico read-only, DAG/evidence validation e digest SHA-256 dei byte; item M1-H0 chiuso con evidenze, Cost Guard esplicitamente fuori Ledger/scope.
- Implementato storage SQLite versionato in `src/storage.mjs`: WAL, `synchronous=FULL`, authority metadata, latch fail-closed, journal append-only, active-source ownership, operation outcome, artifact index, authorization/admission unique e dispatch intent. Runtime e artefatti generati restano sotto `.guardian/` e sono ignorati da Git.
- Implementati checkpoint e Resume Context Manifest sealed in `src/artifact-store.mjs`/`src/handoff.mjs`: temp+fsync+rename, payload/content digest, digest dei byte, immutabilità per ID, secret scan, checkpoint parent/DAG, Git snapshot e manifest sigillato solo dopo il vero target ID.
- Implementato Runner minimo in `src/runner.mjs`: provider transport posseduto e wrappato dal gate, nessuna estensione/skill esterna, tool allowlist profilata, queue/retry/compaction ownership e Extension inline UI/comandi. `REQUIRES_RUNNER` resta rispettato; il soft gate Extension non viene presentato come hard stop.
- Implementato safe point SP-03 in `src/safety.mjs`: latch durevole prima degli effetti, clear queue, cancel retry/compaction, abort cooperativo, attesa terminale e policy **FINISH CURRENT ATOMIC OPERATION**. Tool non profilati non sono ammessi; mutazione unknown o senza effect reference converge su `HUMAN_DECISION_REQUIRED`.
- Implementati `/eio handoff manual|confirm`, alias `/eiopago`, `/eio resume` e `/eio status`. Il target Pi nasce con parent, paused e senza message/history; `manual` lascia latch e prompt in editor, `confirm` autorizza soltanto dopo Continuity Check nella replacement session.
- Continuity Check rilegge Ledger, checkpoint/manifest e digest, Git completo/status, source/target/parent, target no-history/idle, current item/next step, minimal reads realmente disponibili, model/reasoning policy e latch generation; non auto-corregge mismatch.
- Resume: rilascio latch esclusivamente `human:*`, authorization e admission nello stesso commit SQLite con unique `resume_prompt_id`/idempotency key; dispatch intent prima di `sendUserMessage`. Successo registra `RESUME_DISPATCHED` e ACK; ogni errore post-intent diventa `RESUME_DISPATCH_UNKNOWN` e non viene ritentato. Nessuna exactly-once provider execution dichiarata.
- Test: `npm run check` pass su 16 moduli; `npm test` **6/6 pass**. Offline core **4/4** copre Ledger, immutabilità/tamper, latch/admission/dispatch unknown e safe point. E2E **2/2** usa vero `AgentSessionRuntime`/`SessionManager` Pi 0.83.0, provider fake, source→checkpoint→target paused/no-history→resume, parent header, ordine journal, admission unica, retry/reload idempotente e manual paused; zero tentativi rete.
- Documentazione aggiunta: `docs/m1-h0-handoff-mvp.md`; roadmap aggiornata solo per registrare il gate M1-H0 locale. Contratti e ownership ADR non sono stati cambiati.
- Limiti espliciti: `node:sqlite` è ancora marcato experimental da Node 22.19; E2E usa runtime Pi reale ma provider fake offline; nessun sandbox rete OS o paid-provider test; create-session→journal resta saga non ACID e un outcome ambiguo blocca il secondo target; crash recovery unattended e hardening restano M1.1/M1.2.
- Nessun commit eseguito e nessuna configurazione `~/.pi` modificata. Stato: **M1-H0 implementato e testato localmente; review/consolidamento pendenti, acceptance esterna non implicita**.
- `checkpoint_message`: “M1-H0: handoff Pi paused/no-history e resume idempotente verificati”.

**Nome sessione suggerito:** `eiopago-m1-h0-review-consolidate`

**Prompt minimo di ripresa:**

> Verifica profilo/Git; leggi regole operative, prima sezione di `CHECKPOINT.md`, `TASK_PLAN.md`, `docs/m1-h0-handoff-mvp.md`, ADR-0015 e i diff M1-H0. Non ripetere audit o SP-01…SP-04. Esegui review mirata di issue #6, `npm run check`, `npm test` e, se conforme, consolida/committa esclusivamente M1-H0 preservando `REQUIRES_RUNNER`, FINISH CURRENT ATOMIC OPERATION e `RESUME_DISPATCH_UNKNOWN` fail-closed. Non iniziare Cost Guard completo, M1.1/M1.2, provider o integrazioni esterne senza nuova autorizzazione.

# CHECKPOINT — M0.1 Contract and Boundary Freeze completata

## Ultima sessione — M0.1 Contract and Boundary Freeze (corrente)

- Data: 2026-08-05; sessione Pi `019fd3de-0d1b-7cb8-bfd2-9b50b354432c`.
- Profilo verificato prima delle decisioni: `openai-codex/gpt-5.6-sol`, reasoning `high`.
- Esito: **M0.1 completata esclusivamente a livello documentale; STOP DI SESSIONE**. M1 non iniziata, nessun codice applicativo creato, nessuna dipendenza installata e nessun commit eseguito.
- Decisioni `DECIDED`: ownership ibrida distinta per categoria (Ledger Markdown; checkpoint JSON immutabile; telemetria/handoff/latch SQLite; Git tecnico; provider billing per addebito; evidenze presso artefatto owner); checkpoint come commit operativo distinto da Git; lifecycle e parent/DAG; acceptance esterna separata; handoff saga fail-closed e human latch prioritario; confini Eiopago/Durex/FARO Governance/Raiatea/Alfred; modalità standalone.
- Decisioni `PROVISIONAL`: path `TASK_PLAN.md` e `.guardian/checkpoints/`; fallback Extension-first per block-next-call; Raiatea resolver futuro. Qualsiasi cambio di autorità richiede nuovo ADR e migrazione one-way.
- API Pi 0.83.0 classificate in ADR-0015: `CONFIRMED` usage, statistiche, abort surface, input/steering, comandi, conferme, nuova sessione, parent, naming, model e reasoning; `NEEDS_SPIKE` block-next-call, safe point, prompt exactly-once, shutdown/suspend; `REQUIRES_RUNNER` per recovery automatica dopo process crash. Un block hook Extension immediatamente pre-request è `UNSUPPORTED`; Runner resta condizionale a SP-01/SP-04.
- Spike offline M0.1 in `%TEMP%`, senza provider/rete e senza modificare `~/.pi`: RPC (`get_state`, stats, naming, `new_session`, abort idle) riuscito; SessionManager ha verificato header parent v3 e sessione child senza history parent. Rilevata materializzazione differita del JSONL fino alla prima risposta assistant, da coprire nel journal.
- Spike M1 richiesti: SP-01 block race; SP-02 active-stream abort; SP-03 safe point; SP-04 prompt exactly-once; SP-05 shutdown/suspend; SP-06 reload/crash; SP-07 hotkey Windows; SP-08 failure dopo teardown `newSession`; SP-09 takeover durante commit; SP-10 import/conflitti Ledger-checkpoint.
- Contratti minimi definiti: ID e Ledger schema; checkpoint fields/lifecycle/immutabilità; `EventEnvelope`, `CheckpointSpec`, `RunContext`, `RunEvent`, `CandidateCheckpoint`, `CheckpointDecision`, `EvidenceReference`; latch e handoff transaction. JSON Schema, fixture e conformance restano M1/futuro e nessun contratto è implementato.
- Documenti creati: `docs/adr/0015-m0-boundaries-and-contract-freeze.md`, `docs/contracts/m0-contracts.md`, `docs/roadmap.md`.
- Documenti aggiornati in modo mirato: `docs/audit/guardian-requirements-coverage.md` (zero COMPLETE, 92 PARTIAL, zero MISSING), `PIANO_MAESTRO_FARO_DUREX_EIOPAGO.md` e questo checkpoint. PDF funzionali non modificati.
- Git verificato: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, remote `origin` `https://github.com/kinderp/eiopago.git`, zero commit. Non tracciati: checkpoint, due PDF, Piano Maestro e `docs/`; nessun file applicativo.
- Rischi aperti: nessun gate Extension pre-request; teardown del vecchio runtime prima della garanzia del nuovo; prompt replacement avvia una call; crash unattended richiede process owner; source-of-truth sicura solo se projection non scrivono indietro; `VERIFIED` non deve essere mostrato come `ACCEPTED`.
- Modello consigliato per l'avvio M1: `openai-codex/gpt-5.6-sol`, reasoning `high` per SP-01/SP-02/SP-03/SP-04 e race di sicurezza; passare a `medium` solo dopo il gate per scaffold/implementazione meccanica e test ordinari.
- Prossimo passo globale: soltanto dopo autorizzazione esplicita a iniziare M1, eseguire prima SP-01 con fake stream/no rete e decidere Extension fallback vs Runner; non integrare provider, TokenSave, pi-auto-router, Durex o FARO.
- `checkpoint_message`: “M0.1 congelata: contratti, ownership, lifecycle e API Pi classificati”.

**Nome sessione suggerito:** `eiopago-m1-block-next-call-spike`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md`, `CHECKPOINT.md`, ADR-0015, `docs/contracts/m0-contracts.md` e `docs/roadmap.md`; usa coverage/Piano Maestro solo per riscontri e non ripetere audit o M0.1. Verifica Git e profilo `openai-codex/gpt-5.6-sol`, reasoning `high`. Inizia M1 solo se esplicitamente autorizzato: esegui prima SP-01 con fake stream e zero rete per provare block-next-call; se fallisce classifica `REQUIRES_RUNNER` senza hack terminali. Non integrare provider, TokenSave, pi-auto-router, Durex o FARO e non modificare `~/.pi`.

## Sessione precedente — audit copertura requisiti

- Data: 2026-08-05; sessione Pi `019fd3de-0d1b-7cb8-bfd2-9b50b354432c`.
- Esito: **audit di copertura completato; STOP DI SESSIONE**. Creato `docs/audit/guardian-requirements-coverage.md`; nessuna funzionalità implementata, M0 non ampliata, M1 non iniziata e nessuna decisione critica ratificata.
- Fonti lette in modo mirato: regole canoniche, checkpoint e indice/sezioni pertinenti di `Guardian_Pi_Agent_Guida_Funzionale.pdf` v0.1. Il PDF è comparso come file non tracciato durante la sessione ed è stato incluso perché materialmente pertinente all'audit. Nessun altro documento o repository terzo è stato riletto.
- Risultato sintetico: zero funzionalità `COMPLETE`; copertura prevalentemente `PARTIAL` documentale; lacune maggiori in block-next-call verificabile, latch/handoff transazionale, ledger canonico, checkpoint/evidence model e accounting canonico. Contratti futuri nominati dal mandato non risultano documentati nelle fonti.
- Verifiche: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, remote `origin` `https://github.com/kinderp/eiopago.git`, zero commit. Stato finale non tracciato: `CHECKPOINT.md`, `Guardian_Pi_Agent_Guida_Funzionale.pdf` e `docs/`.
- Profilo della sessione: `openai-codex/gpt-5.6-sol`, reasoning `medium`, usato esclusivamente per audit di copertura; il gate `high` resta obbligatorio prima di ratificare decisioni M0 o verificare le API critiche.
- Modifiche: soltanto il nuovo report di audit e questo checkpoint; `~/.pi` non modificato. Nessun test eseguito perché non esiste codice Eiopago e il mandato vietava implementazioni.
- Prossimo passo: in una nuova sessione `high`, leggere il report senza ripetere l'audit e riprendere il gate M0 già previsto; non iniziare M1 prima delle decisioni/verifiche richieste.
- `checkpoint_message`: “Audit copertura completato: zero COMPLETE, gap critici M0/M1 identificati”.

**Nome sessione suggerito:** `eiopago-m0-gap-ratifica-high`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md`, `CHECKPOINT.md` e `docs/audit/guardian-requirements-coverage.md`; usa `Guardian_Pi_Agent_Guida_Funzionale.pdf` solo per riscontri puntuali e non ripetere l’audit. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`; se non conforme aggiorna solo il checkpoint e fermati. Riprendi esclusivamente il gate M0 già previsto, partendo dai cinque gap urgenti e senza segnare COMPLETE ciò che è solo in roadmap. Non iniziare M1 né modificare `~/.pi`.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd3de-0d1b-7cb8-bfd2-9b50b354432c`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; Master Task Ledger non creato, API Pi non verificate, decisioni M0 non ratificate e M1 non avviata.
- Profilo esatto rilevato dalle variabili `PI_*`: `openai-codex/gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning richiesto è `high`, quindi il profilo obbligatorio non è soddisfatto.
- Git verificato: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, remote `origin` `https://github.com/kinderp/eiopago.git`, zero commit; soltanto `CHECKPOINT.md` e `docs/` sono non tracciati, coerentemente con lo stato dichiarato.
- In conformità al gate non sono stati ripetuti audit/test, non sono state svolte verifiche API mirate e `~/.pi` non è stato modificato. Modificato soltanto `CHECKPOINT.md`.
- Prossimo gate: avviare una nuova sessione con profilo effettivo `openai-codex/gpt-5.6-sol`, reasoning esattamente `high`; verificare Git e le variabili `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` prima di creare il ledger o assumere decisioni M0.
- `checkpoint_message`: “Profilo Sol corretto, reasoning ancora medium; M0 rinviata senza decisioni”.

**Nome sessione suggerito:** `eiopago-m0-api-ratifica-high`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md` e `CHECKPOINT.md`; non ripetere audit/test. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`, altrimenti aggiorna solo il checkpoint e fermati. Completa solo M0: crea il Master Task Ledger; verifica le API Pi mirate e ratifica confirm handoff, takeover, latch, Extension vs Runner, state machine e roadmap M1/M1.1/M1.2. Non iniziare M1 né modificare `~/.pi`. Chiudi aggiornando ledger/checkpoint, prompt minimo e nome sessione.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd3c2-76f7-783a-9b94-20bd2c5c83b4`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; Master Task Ledger non creato, API Pi non verificate, decisioni M0 non ratificate e M1 non avviata.
- Profilo esatto rilevato dalle variabili `PI_*`: `openai-codex/gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning richiesto è `high`, quindi il profilo obbligatorio non è soddisfatto.
- Git verificato: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, remote `origin` `https://github.com/kinderp/eiopago.git`, zero commit; soltanto `CHECKPOINT.md` e `docs/` sono non tracciati, coerentemente con lo stato dichiarato.
- In conformità al gate non sono stati ripetuti audit/test, non sono state svolte verifiche API mirate e `~/.pi` non è stato modificato. Modificato soltanto `CHECKPOINT.md`.
- Prossimo gate: avviare una nuova sessione con profilo effettivo `openai-codex/gpt-5.6-sol`, reasoning esattamente `high`; verificare Git e le variabili `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` prima di creare il ledger o assumere decisioni M0.
- `checkpoint_message`: “Profilo Sol corretto, reasoning ancora medium; M0 rinviata senza decisioni”.

**Nome sessione suggerito:** `eiopago-m0-api-ratifica-high`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md` e `CHECKPOINT.md`; non ripetere audit/test. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`, altrimenti aggiorna solo il checkpoint e fermati. Completa solo M0: crea il Master Task Ledger; verifica le API Pi mirate e ratifica confirm handoff, takeover, latch, Extension vs Runner, state machine e roadmap M1/M1.1/M1.2. Non iniziare M1 né modificare `~/.pi`. Chiudi aggiornando ledger/checkpoint, prompt minimo e nome sessione.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd3b8-ecd8-72be-a936-898825b9de6b`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; Master Task Ledger non creato, API Pi non verificate, decisioni M0 non ratificate e M1 non avviata.
- Profilo esatto rilevato dalle variabili `PI_*`: `openai-codex/gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning richiesto è `high`, quindi il profilo obbligatorio non è soddisfatto.
- Git verificato: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, remote `origin` `https://github.com/kinderp/eiopago.git`, zero commit; soltanto `CHECKPOINT.md` e `docs/` sono non tracciati, coerentemente con lo stato dichiarato.
- In conformità al gate non sono stati ripetuti audit/test, non sono state svolte verifiche API mirate e `~/.pi` non è stato modificato. Modificato soltanto `CHECKPOINT.md`.
- Prossimo gate: avviare una nuova sessione con profilo effettivo `openai-codex/gpt-5.6-sol`, reasoning esattamente `high`; verificare Git e le tre variabili `PI_*` prima di creare il ledger o assumere decisioni M0.
- `checkpoint_message`: “Profilo Sol corretto, reasoning ancora medium; M0 rinviata senza decisioni”.

**Nome sessione suggerito:** `eiopago-m0-api-ratifica-high`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md` e `CHECKPOINT.md`; non ripetere audit/test. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`, altrimenti aggiorna solo il checkpoint e fermati. Completa solo M0: crea il Master Task Ledger; verifica le API Pi mirate e ratifica confirm handoff, takeover, latch, Extension vs Runner, state machine e roadmap M1/M1.1/M1.2. Non iniziare M1 né modificare `~/.pi`. Chiudi aggiornando ledger/checkpoint, prompt minimo e nome sessione.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd3b2-61c0-7724-84c9-fdfc49645e27`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; Master Task Ledger non creato, API Pi non verificate, decisioni M0 non ratificate e M1 non avviata.
- Profilo esatto rilevato dalle variabili `PI_*`: `openai-codex/gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning richiesto è `high`, quindi il profilo obbligatorio non è soddisfatto.
- Git verificato: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, remote `origin` `https://github.com/kinderp/eiopago.git`, zero commit; soltanto `CHECKPOINT.md` e `docs/` sono non tracciati, coerentemente con lo stato dichiarato.
- In conformità al gate non sono stati ripetuti audit/test, non sono state svolte verifiche API mirate e `~/.pi` non è stato modificato. Modificato soltanto `CHECKPOINT.md`.
- Prossimo gate: avviare una nuova sessione con profilo effettivo `openai-codex/gpt-5.6-sol`, reasoning esattamente `high`; verificare Git e le tre variabili `PI_*` prima di creare il ledger o assumere decisioni M0.
- `checkpoint_message`: “Reasoning ancora medium; M0 e verifica API rinviate senza modifiche”.

**Nome sessione suggerito:** `eiopago-m0-api-ratifica-high`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md` e `CHECKPOINT.md`; non ripetere audit/test. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`, altrimenti aggiorna solo il checkpoint e fermati. Completa solo M0: crea il Master Task Ledger; verifica le API Pi mirate e ratifica confirm handoff, takeover, latch, Extension vs Runner, state machine e roadmap M1/M1.1/M1.2. Non iniziare M1 né modificare `~/.pi`. Chiudi aggiornando ledger/checkpoint, prompt minimo e nome sessione.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd327-16e7-7e9f-a249-758ed2723c33`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; Master Task Ledger non creato, nessuna decisione M0 ratificata e M1 non avviata.
- Profilo rilevato da `PI_PROVIDER`, `PI_MODEL` e `PI_REASONING_LEVEL`: `openai-codex/gpt-5.6-sol`, reasoning effettivo `medium`. Provider e modello sono corretti, ma il reasoning non è esattamente `high`; il profilo obbligatorio non è soddisfatto.
- Git verificato: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, remote `origin` coerente, nessun commit; `CHECKPOINT.md` e `docs/` restano non tracciati e coerenti con lo stato dichiarato.
- Non sono stati ripetuti audit o test e `~/.pi` non è stato modificato. Una ricerca mirata iniziale nelle API/documentazione installate ha rilevato l'esempio `examples/extensions/handoff.ts`, ma è stata interrotta al riscontro del profilo non conforme: nessuna semantica API, fattibilità, state machine, latch o scelta Extension/Runner è stata ratificata.
- Modifiche: aggiornato soltanto `CHECKPOINT.md` per registrare il gate e il passaggio di sessione. Roadmap e requisiti restano quelli già acquisiti sotto.
- Prossimo gate: nuova sessione con profilo effettivo `openai-codex/gpt-5.6-sol`, reasoning `high`; verificare le tre variabili `PI_*` prima di creare il ledger o riprendere la verifica API mirata.
- `checkpoint_message`: “Profilo Sol confermato ma reasoning medium; M0 critica rinviata senza decisioni”.

**Nome sessione suggerito:** `eiopago-m0-handoff-takeover-api-high`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md` e `CHECKPOINT.md`; non ripetere audit/test. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`, altrimenti aggiorna solo il checkpoint e fermati. Completa solo M0: crea il Master Task Ledger; verifica le API Pi mirate e ratifica confirm handoff, takeover, latch, Extension vs Runner, state machine e roadmap M1/M1.1/M1.2. Non iniziare M1 né modificare `~/.pi`. Chiudi aggiornando ledger/checkpoint, prompt minimo e nome sessione.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd303-d3c1-703b-95b2-7a6b423833e7`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; nessuna decisione critica o attività M1 avviata.
- Profilo rilevato: provider `openai-codex`, modello `gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning non è esattamente `high`, quindi il profilo obbligatorio richiesto non è soddisfatto.
- Repository verificato: `E:/dev/eiopago`; branch `feat/pi-usage-guardian-foundation`; worktree principale; remote `origin` coerente; nessun commit; `CHECKPOINT.md` e `docs/` non tracciati, coerenti con i file dichiarati nel checkpoint.
- Non sono stati ripetuti audit, inventari o test già completati; `~/.pi` non è stato modificato.
- Statistiche rilevate durante il gate: 10 entry JSONL; 2 record usage; input 9.715; output 714; reasoning 150; cache read 0; cache write 0; costo riportato USD 0,069995; contesto stimato 8.509 / 272.000 = 3,13%. Nessuna soglia quantitativa raggiunta; stop esclusivamente qualitativo.
- Nuovo requisito prioritario ricevuto e registrato senza progettarlo in profilo non conforme: **Automatic Session Handoff** deve appartenere al Cost Guard MVP/M1, non a dashboard od orchestratore futuro. Deve creare una sessione pulita nello stesso processo (non clone/fork), preservare il parent, trasferire solo checkpoint/stato minimo, bloccare ulteriori chiamate nella vecchia sessione e supportare `manual`/`confirm`/`auto` (default `confirm`). Il mandato prescrive state machine, validazioni, configurazione iniziale e dieci criteri E2E; questi elementi devono essere incorporati in roadmap, requisiti, casi d'uso, architettura, ADR e criteri M1 durante la fase critica `high`.
- Modifiche: aggiornato soltanto questo checkpoint per acquisire requisito, stato reale, statistiche e handoff. Nessun documento architetturale creato perché ciò violerebbe il gate `high`; M1 non iniziata.
- Prossimo gate: nuova sessione con `openai-codex/gpt-5.6-sol`, reasoning effettivo `high`; includere Automatic Session Handoff nella fase critica delimitata e verificare le API Pi mirate necessarie senza rileggere l'intero audit.
- Integrazione strategica successiva ricevuta nella stessa sessione: la continuità dei task lunghi deve seguire il principio «cronologia corta, memoria persistente affidabile, contesto recuperato su richiesta e passaggi verificati». Il mandato amplia l'handoff con punti stabili, pacchetto persistente/versionato, aggiornamento progressivo deterministico, costo control-plane separato, Quality Gate, Continuity Check, Resume Context Manifest, lineage task/sessione, crash recovery, redazione segreti, policy per tipo di task, limiti anti-loop, estensione atomica controllata e misure di qualità/A-B. Non presume che più contesto o ogni nuova sessione migliorino automaticamente la qualità.
- Roadmap richiesta dall'ultima integrazione: M0 fondazione/decisioni; M1 Cost Guard MVP; M1.1 Automatic Session Handoff; poi M2–M11. In fase critica `high` va deciso se includere l'handoff direttamente in M1 quando l'API Pi lo consente senza ritardare eccessivamente il primo guard, altrimenti completarlo nell'estensione immediata M1.1; non può essere rinviato alla dashboard.
- Output architetturali richiesti ma **non redatti in questa sessione medium**: visione, requisiti, casi d'uso, architettura, modello dati, budget/stop, routing, roadmap, sicurezza, benchmark, domande aperte, documento dedicato e ADR non duplicati. Il gate qualitativo resta vincolante; nessuna supposizione sulle API Pi è stata ratificata.
- Statistiche dopo l'acquisizione dell'integrazione: 22 entry JSONL; 6 record usage; input 24.790; output 3.829; reasoning 742; cache read 44.032; cache write 0; costo USD 0,260836; contesto stimato 21.254 / 272.000 = 7,81%. Nessuna soglia quantitativa raggiunta; permane lo stop per reasoning `medium`.
- Ulteriore requisito ricevuto nella stessa sessione: **Persistent Master Task Ledger** canonico e versionato per l'intero task, distinto da Session Checkpoint, documentazione/ADR e repository/test. Deve mantenere requisiti versionati, DAG/lista di attività con ID e stati stabili, dipendenze, evidenze verificabili, budget/costo, lineage e prossimo passo globale; nessuna attività può diventare `DONE` senza evidenza. I cambi requisito devono restare tracciati tramite `SUPERSEDED`/`DROPPED`, senza cancellazioni silenziose.
- Il ledger deve essere aggiornato progressivamente e verificato prima dell'handoff e durante la continuity verification; il checkpoint deve restare un delta di sessione con riferimenti al ledger. Per l'MVP deve esistere una sola fonte canonica leggibile in Markdown; l'eventuale SQLite generatore della vista è futuro e non deve creare doppie fonti divergenti.
- Convenzione file e schema non ratificati: il repository non possiede ancora una convenzione oltre a checkpoint/regole; la fase `high` deve scegliere motivatamente tra `TASK_PLAN.md` e `.guardian/tasks/<task-id>/...`, creare il ledger iniziale senza ricostruzioni indipendenti e aggiungere le entità/equivalenti richieste al modello dati.
- Statistiche dopo questa integrazione: 35 entry JSONL; 11 record usage; input 34.819; output 6.965; reasoning 1.159; cache read 158.208; cache write 0; costo USD 0,462149; contesto stimato 28.927 / 272.000 = 10,63%. Nessuna soglia quantitativa raggiunta; STOP invariato perché reasoning effettivo `medium`.
- Requisito successivo ricevuto nella stessa sessione: **Visual Task Roadmap e Checkpoint History**, comando primario `/guardian roadmap` interamente locale, senza chiamate LLM/provider, con possibile CLI coerente. Deve proiettare Master Task Ledger, DAG/piano, session lineage, handoff, checkpoint effettivi/previsti/mancanti, requirement changes, review/finding/fix, test, uso e costi.
- Varianti richieste: default, `--oneline`, `--details`, filtri active/completed/planned/missing/checkpoints/sessions/reviews, `--usage`, `--cost`, `--json`; Unicode con fallback ASCII, colori opzionali e semantica non dipendente dal colore. Il DAG non deve essere falsificato come gerarchia: percorso principale, rami e riferimenti trasversali espliciti.
- `--missing` diventa una vista di controllo coerenza su checkpoint/evidenze/requisiti/handoff/continuity; `--json` richiede schema stabile e versionato. Usage e costi devono mantenere separate fonti misurate, stimate, abbonamento, API, provider riconciliato e control plane.
- Collocazione, contratto dati e nomenclatura CLI non ratificati in profilo `medium`: integrarli in specifiche, architettura, modello dati, casi d'uso, roadmap e criteri durante M0 `high`, senza iniziare la milestone d'implementazione.
- Statistiche dopo l'acquisizione: 44 entry JSONL; 15 record usage; input 43.516; output 9.650; reasoning 1.301; cache read 280.064; cache write 0; costo USD 0,647112; contesto stimato 35.842 / 272.000 = 13,18%. Nessuna soglia quantitativa raggiunta; STOP qualitativo invariato.
- Completamento del requisito Visual Task Roadmap ricevuto nella stessa sessione: la vista deve modellare cicli implementazione→review→finding→fix→review→approvazione, plan/history/combined, `ExpectedCheckpoint`, requirement-change events, summary aggregate e filtri non mutanti. Ogni round/sessione/checkpoint conserva identità, lineage, Git, profilo, durata, usage/costi distinti, test/finding/handoff/continuity/evidenze; i campi assenti sono `unknown`, mai zero inventato.
- Nuovo campo richiesto `checkpoint_message`: una riga descrittiva, idealmente 72–100 caratteri, generata durante la normale chiusura senza chiamata LLM dedicata. Dettagli esclusi dalla larghezza restano accessibili con `/guardian roadmap --details <id>` o comando show da ratificare.
- `ExpectedCheckpoint` deve distinguere `PLANNED`, `NOT_YET_DUE`, `DUE`, `SATISFIED`, `MISSING`, `WAIVED`, `SUPERSEDED`; è `MISSING` solo dopo trigger/fase/task/handoff pertinente, mai prima che sia dovuto. La vista essenziale statica è proposta per M1, lineage/handoff per M1.1, review/finding/fix e filtri avanzati per M2, TUI interattiva per M9; non rinviarla alla dashboard.
- Requisiti non funzionali acquisiti: offline, deterministica, incrementale/indicizzata, nessuna rete/LLM/provider, dati parziali sicuri, terminale stretto, Unicode/ASCII/no-color, escape/CSV injection safety, output JSON versionato e tempo obiettivo locale da documentare/misurare. La source-of-truth strategy Markdown/SQLite/Git/provider deve essere decisa senza correzioni silenziose.
- Test richiesti registrati senza esecuzione: casi lineari/DAG/branch-merge, sessioni/handoff/review/fix, stati checkpoint, evidenze e requirement superseded, dati incompleti/costi non riconciliati, rendering/filtri/ordinamenti/JSON/idempotenza, assenza rete/LLM e injection. Golden/snapshot solo se leggibili e non fragili.
- `checkpoint_message` corrente: “Acquisiti ledger e roadmap visuale; fase critica ancora bloccata dal profilo”.
- Statistiche dopo il completamento del requisito: 52 entry JSONL; 19 record usage; input 52.360; output 12.145; reasoning 1.404; cache read 426.496; cache write 0; costo USD 0,839398; contesto stimato 42.272 / 272.000 = 15,54%. Nessuna soglia quantitativa raggiunta; STOP qualitativo invariato (`medium` anziché `high`).
- Nuova priorità P0 ricevuta: **Session Handoff Orchestrator con Human Takeover** precede roadmap avanzata, TokenSave, auto-router, forecasting, benchmark, provider avanzati e dashboard. La modalità iniziale è `confirm`; sono richieste esattamente `manual`, `confirm`, `supervised-auto`, `auto`, con `auto` disabilitata per default e possibile Guardian Runner solo se l'Extension API non supporta automazione robusta.
- Precedenza vincolante acquisita: HUMAN TAKEOVER → emergency stop/sicurezza → hard budget → checkpoint/integrità repository → handoff → piano agente → ottimizzazione. Un persistent human-control latch blocca nuove LLM/tool agentici, handoff, cambi profilo/budget e mutazioni piano; sopravvive a session switch, reload, crash e restart, ed è rilasciabile solo dall'utente.
- Comandi richiesti registrati: pause/takeover/resume; handoff prepare/confirm/cancel/status; plan show/edit/add/remove/reprioritize/approve; mode manual/confirm/supervised-auto/auto. Hotkey configurabile senza sovrascrivere Escape e steering directives deterministiche devono convergere sullo stesso latch.
- State machine candidata imposta dal mandato: `RUNNING → THRESHOLD_DETECTED → SAFE_POINT_REQUESTED → CHECKPOINT_PREPARING → HANDOFF_PREPARED → HANDOFF_ARMED → HANDOFF_COMMIT → NEW_SESSION_PAUSED → CONTINUITY_CHECK → RESUME_READY → RESUMED`. Durante COMMIT si esegue solo lo switch tecnico minimo; un takeover concorrente viene persistito e porta la nuova sessione a `NEW_SESSION_PAUSED`, senza rollback parziale né prompt automatico.
- Nuovo ordine roadmap sostituisce quello precedente: M0 API/session-control architecture; M1 Cost Guard + confirm handoff + takeover; M1.1 supervised-auto + crash recovery; M1.2 Runner per auto solo se necessario; M2 attribuzione/review budget/roadmap completa; M3–M11 come riportato sotto. La roadmap visuale minima può restare M1 ma non ritarda handoff/takeover/block/new-session/resume prompt.
- Verifiche API richieste ma non eseguite in `medium`: session creation/parent/name/prompt, pre-next-call block, safe abort, command/input/steering/hotkey/TUI, persistence/reload e confini Extension vs AgentSession/RPC. Non dichiarare implementabile alcuna modalità finché non provata con test mirati.
- `checkpoint_message` corrente: “Promosso handoff con takeover a P0; verifica API bloccata dal profilo”.
- Statistiche dopo l'acquisizione: 62 entry JSONL; 24 record usage; input 63.310; output 15.183; reasoning 1.772; cache read 644.096; cache write 0; costo USD 1,094088; contesto stimato 50.157 / 272.000 = 18,44%. Nessuna soglia quantitativa raggiunta; STOP qualitativo invariato (`medium` anziché `high`).

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd2f1-57cb-78f7-8b69-0aaba6cc227d`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; nessuna decisione critica avviata.
- Profilo rilevato: provider `openai-codex`, modello `gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning non è esattamente `high`, quindi il profilo obbligatorio non è soddisfatto.
- Regole operative canoniche: create in `docs/it/00-regole-operative.md` su richiesta esplicita dell'utente; il mandato corrente e questo checkpoint le integrano.
- Repository verificato: `E:/dev/eiopago`; branch `feat/pi-usage-guardian-foundation`; worktree principale; remote `origin` coerente; nessun commit; solo `CHECKPOINT.md` non tracciato.
- Confronto checkpoint/stato reale: inizialmente nessuna discrepanza. Non risultavano README, ADR o altri file di progetto; in conformità al checkpoint non sono stati ripetuti audit, test, inventari o letture terze.
- Statistiche rilevate prima dell'aggiornamento del checkpoint: 11 entry JSONL; 3 record usage; input 10.774; output 862; reasoning 181; cache read 0; cache write 0; costo riportato USD 0,079730; contesto stimato 7.790 / 272.000 = 2,86%.
- Soglie di consumo: nessun warning o stop raggiunto. Lo stop deriva esclusivamente dal gate qualitativo del reasoning.
- Modifiche: su richiesta esplicita dell'utente, creata la fonte canonica `docs/it/00-regole-operative.md` e resa obbligatoria a ogni chiusura la consegna, sia nel checkpoint sia nel messaggio finale, del prompt minimo per la sessione successiva e di un nome breve suggerito. Aggiornato anche questo checkpoint; roadmap, decisioni pregresse e prossimo passo restano invariati.
- M0 ancora mancante: intera fase critica (architettura e autorità, TokenSave/TraceDecay, accounting e dati, sicurezza/threat model, budget e hard stop verificabile, compose/fork/rewrite, metodologia benchmark, ADR e documenti canonici minimi). M1 non iniziata.
- Profilo obbligatorio per la prossima sessione: `openai-codex/gpt-5.6-sol`, reasoning effettivo `high`; verificarlo prima di qualsiasi decisione critica.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd2d9-3737-701e-a520-f7ce52715c1f`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; nessuna decisione critica avviata.
- Profilo rilevato: provider `openai-codex`, modello `gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning non è esattamente `high`, quindi il profilo obbligatorio non è soddisfatto.
- Repository verificato: `E:/dev/eiopago`; branch `feat/pi-usage-guardian-foundation`; worktree principale; nessun commit; solo `CHECKPOINT.md` non tracciato.
- Confronto checkpoint/stato reale: **nessuna discrepanza**. Non risultano README, ADR o altri file di progetto; non sono stati ripetuti audit, test o ricerche.
- Statistiche disponibili dopo l'analisi del checkpoint: 9 entry JSONL; 2 record usage; input 10.427; output 932; reasoning 150; cache read 0; cache write 0; costo riportato USD 0,080095; contesto stimato 8.251 / 272.000 = 3,03%.
- Statistiche prima della chiusura: 13 entry JSONL; 4 record usage; input 12.613; output 2.035; reasoning 366; cache read 16.384; cache write 0; costo riportato USD 0,132307; contesto stimato 9.650 / 272.000 = 3,55%.
- Soglie di consumo: nessun warning o stop raggiunto. Lo stop deriva esclusivamente dal gate qualitativo del reasoning.
- Modifiche: aggiornato soltanto questo checkpoint; roadmap, decisioni pregresse e prossimo passo restano invariati.
- M0 ancora mancante: intera fase critica (architettura e autorità, TokenSave/TraceDecay, accounting e dati, sicurezza/threat model, budget e hard stop verificabile, compose/fork/rewrite, metodologia benchmark, ADR e documenti canonici minimi). M1 non iniziata.
- Profilo obbligatorio per la prossima sessione: `openai-codex/gpt-5.6-sol`, reasoning effettivo `high`; verificarlo prima di qualsiasi decisione critica.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd2be-9b8c-7c75-900f-662b2ce356f6`.
- Esito: fermato al gate pre-fase critica per profilo non conforme.
- Motivo: provider e modello corretti (`openai-codex/gpt-5.6-sol`), ma reasoning effettivo `medium` anziché `high`.
- Regole canoniche: verificato che nel repository non esiste ancora un file separato; valgono il mandato corrente e questo checkpoint.
- Confronto col repository: checkpoint coerente con branch `feat/pi-usage-guardian-foundation`, worktree principale, assenza di commit e solo `CHECKPOINT.md` non tracciato; nessun README, ADR o altro file di progetto presente.
- Modifiche al progetto: nessuna decisione o implementazione; aggiornato soltanto questo checkpoint.
- Decisioni critiche: nessuna avviata o ratificata.
- Statistiche dopo l'analisi del checkpoint: 11 entry JSONL; input 9.754; output 1.192; reasoning 212; cache read 4.096; cache write 0; costo riportato USD 0,086578; contesto stimato 8.467 / 272.000 = 3,11%.
- Soglie: nessun warning di consumo raggiunto; stop imposto dal gate qualitativo del reasoning.
- Ripresa consigliata: avviare una nuova sessione verificando **prima** delle decisioni che `PI_REASONING_LEVEL=high`; mantenere invariato il prossimo passo già descritto sotto.

## Data

2026-08-05

## Obiettivo

Progetto **eiopago** (nome precedente nel mandato: `pi-usage-guardian`): M0 — fondazione e audit minimo indispensabile. Questa sessione ha completato la verifica ambiente, l'audit documentale di Pi e l'audit ordinario riproducibile dei principali candidati. La fase critica di architettura/sicurezza/accounting non è iniziata perché il contesto ha superato la soglia di stop autorizzata.

## Stato

**Stabile ma M0 non completata. STOP obbligatorio prima della fase critica.**

Non sono iniziate M1 né implementazioni complete di router, TraceDecay/TokenSave, provider, benchmark o dashboard.

## Repository, branch e worktree

- Progetto: `E:/dev/eiopago`
- Remote: `https://github.com/kinderp/eiopago.git`
- Branch: `feat/pi-usage-guardian-foundation`
- Worktree: worktree principale, isolato sul branch sopra
- Commit base: nessuno; repository remoto e locale senza commit
- Modifiche non correlate iniziali: nessuna
- Regole operative canoniche nel repository: `docs/it/00-regole-operative.md` (create dopo l'audit, su richiesta dell'utente)

## Profilo di esecuzione e gate

### Profilo corrente prima del gate

- Provider: `openai-codex`
- Modello: `gpt-5.6-sol`
- Model ID: `gpt-5.6-sol`
- Reasoning effettivo: `medium`
- Profilo operativo: Quality/medium per audit ordinario
- Context window catalogo Pi: 272.000 token
- Fonte accesso: OAuth, coerente con abbonamento OpenAI Codex; nessun segreto letto o registrato
- Prezzo: non esposto dal catalogo CLI per questa fonte; costo per messaggio disponibile nel JSONL Pi

### Statistiche al gate pre-fase critica

Metodo: somma locale degli usage persistiti nel JSONL Pi; contesto stimato dall'ultimo assistant usage come `input + cacheRead + cacheWrite`. Non è stata aperta una seconda istanza RPC.

- Entry JSONL: 86
- Input cumulativo: 224.821
- Output cumulativo: 9.267
- Reasoning cumulativo: 1.886
- Cache read cumulativa: 1.277.952
- Cache write cumulativa: 0
- Costo cumulativo riportato: USD 2,041091
- Contesto stimato: 209.788 / 272.000 = 77,13%
- Esito soglie:
  - cache read: OK (< 3.000.000 warning)
  - costo: WARNING (>= USD 1,50; < USD 3,00 stop)
  - contesto: **STOP** (>= 60%)

### Decisione sul reasoning

L'utente ha autorizzato `high` esclusivamente per architettura, confini di autorità, accounting, precisione monetaria, sicurezza, threat model, budget/stop, reuse/fork/rewrite e benchmark. Il passaggio **non è stato effettuato**, perché il gate di contesto ha imposto lo stop prima della fase critica.

Per la ripresa:

- consigliato: `openai-codex/gpt-5.6-sol`, reasoning `high`, nuova sessione;
- alternativa più economica nello stesso provider: `openai-codex/gpt-5.6-terra`, reasoning `high`, solo se si accetta minore margine sulle decisioni critiche;
- dopo la fase critica: tornare a `medium` per implementazione/test e `low` per fixture, export, documentazione meccanica e checkpoint.

## Profili usati per fase

| Fase | Profilo | Provider/modello | Reasoning | Esito |
| --- | --- | --- | --- | --- |
| Verifica ambiente | Balanced | openai-codex/gpt-5.6-sol | medium | completata |
| Audit documentale Pi | Balanced/Quality | openai-codex/gpt-5.6-sol | medium | completato |
| Audit ordinario componenti terzi | Balanced/Quality | openai-codex/gpt-5.6-sol | medium | completato |
| Gate fase critica | Quality | openai-codex/gpt-5.6-sol | medium | stop per contesto |
| Architettura/sicurezza/accounting | Quality | consigliato Sol | high | non iniziata |

## Ambiente rilevato

- OS: Windows x64, shell MINGW64
- Node.js: 22.19.0
- npm: 10.9.3
- pnpm: non installato
- yarn: non installato
- TypeScript globale: non installato
- Python: 3.10.7
- Rust/Cargo: non installati
- Pi CLI: 0.83.0
- Package installati effettivi:
  - `@earendil-works/pi-coding-agent` 0.83.0
  - `@earendil-works/pi-agent-core` 0.83.0
  - `@earendil-works/pi-ai` 0.83.0
  - `@earendil-works/pi-tui` 0.83.0
- Sessioni Pi: JSONL v3 ad albero con `id`/`parentId`; usage assistant contiene input/output/reasoning/cacheRead/cacheWrite/cost/totalTokens
- Modelli disponibili e autenticati rilevati offline:
  - OpenAI Codex: gpt-5.3-codex-spark, gpt-5.4, gpt-5.4-mini, gpt-5.5, gpt-5.6-luna, gpt-5.6-terra, gpt-5.6-sol
  - Moonshot: catalogo Kimi disponibile tramite API key già configurata; nessun segreto mostrato
- GPT-5.6 Sol/Terra/Luna: contesto Pi 272K, output massimo 128K, reasoning e immagini supportati
- Livelli Pi CLI: off, minimal, low, medium, high, xhigh, max; per GPT-5.6 la documentazione conferma xhigh e max quando supportati

## Audit Pi completato

Documentazione installata 0.83.0 letta senza modificarla:

- README.md
- docs/extensions.md
- docs/models.md
- docs/environment-variables.md
- docs/sdk.md
- docs/tui.md
- docs/rpc.md
- docs/session-format.md
- docs/json.md
- esempi pertinenti: session-name, model-status, preset, shutdown-command, custom-footer, status-line, rpc-demo

Capacità confermate:

- eventi session/agent/turn/message/tool/model/thinking/compaction/provider response;
- usage finale assistant e usage opzionale dei tool;
- input/output/reasoning/cache read/cache write/costo nei JSONL reali;
- `ctx.getContextUsage()`, session naming, model registry e modello/reasoning correnti;
- `tool_call` bloccabile; conferme TUI/RPC; shutdown e abort;
- footer/status/widget/overlay/custom command;
- SDK `AgentSession`, JSON mode e RPC;
- RPC `get_session_stats`, `get_state`, `get_entries`, `get_available_models`, livelli thinking e abort;
- model/thinking changes persistiti nel JSONL.

Limite critico da risolvere in M1: la superficie ExtensionAPI documentata non presenta un evento dedicato `before_llm_call` con risultato bloccabile. `before_provider_request` può sostituire il payload ma non documenta un esito `block`. Il Cost Guard MVP deve dimostrare un vero `block-next-LLM-call`, probabilmente tramite controllo in `input`/`before_agent_start`, stato persistito e arresto/checkpoint prima che la richiesta raggiunga il provider; la soluzione definitiva richiede la fase critica e un test harness senza rete.

## Versioni terze auditate

Clone isolati in `%TEMP%/eiopago-m0-audit`; nessun package globale installato, nessuna configurazione personale modificata.

| Progetto | Versione auditata | SHA | Licenza | Nota |
| --- | --- | --- | --- | --- |
| pi-auto-router | repository 0.2.3; npm pubblicato 0.2.2 | `39f48d994d8abdf7ba1018ac1bffe89f44bee849` | MIT | main avanti rispetto a npm |
| TokenSave/TraceDecay core | Cargo 0.0.73, tag v0.0.73 | `e2c7971c64aa8652ae7f35ec8d3f56be38c3acd5` | MIT | progetto rinominato TraceDecay; README/security mostrano nomenclatura/versioni in transizione |
| pi-tokensaver | 0.0.2, tag v0.0.2 | `65764848f5173b5dac1f4d1dbb73c95f75ca9fa3` | MIT | peer namespace Pi precedente |
| pi-tokensave diretto | 0.1.0 | `64f735bc3286e20a4e5eec7c093bafcea7d455b5` | MIT | adapter diretto più recente e read-only |
| pi-token-usage | 0.2.1, tag v0.2.1 | `774e5fd33b49bce82eadd331cb92c95143e72856` | MIT | parser JSONL riutilizzabile/estraibile |
| pi-usage | clone 0.2.1; npm 0.3.0 | `5f0cc99c00a2668d4d903e74641cb76230426162` | MIT | clone shallow non allineato a npm; usa endpoint quota e credenziali OAuth |
| pi-harness-runtime | 0.10.19 | `68557e59670d143f2c4a65bfdd99addbd73ef005` | MIT | alternativa ampia/beta, fuori dal core M0 |
| pi-powerline-footer | 0.12.1, tag v0.12.1 | `75385f6d750331da1b480f7aceb0f3b1d2b272ff` | licenza non rilevata alla root | pattern TUI pertinente, compatibile Pi 0.83 |

## Test terzi eseguiti in isolamento

Comandi eseguiti con `npm install --ignore-scripts --no-audit --no-fund`, HOME/USERPROFILE sintetici e `PI_OFFLINE=1`.

- pi-auto-router: **429 pass, 3 fail**, 432 totali. Fallimenti riproducibili sullo SHA auditato (`buildMonthlyQuotaWindow`, due casi `formatModelLine`); nessuna chiamata provider reale autorizzata.
- pi-token-usage: **23/23 pass**.
- pi-tokensaver: build TypeScript pass; unit test **20/20 pass**. Test MCP reali non eseguiti perché il binario TokenSave non è installato.
- pi-tokensave diretto: **111 pass, 1 skip**, 112 totali; smoke test reale saltato perché il binario TokenSave non è presente.
- pi-usage: test saltati perché Bun non è installato.
- TraceDecay core: build/test non eseguiti perché Rust/Cargo non sono installati; nessun binario scaricato/installato.

Log locali nelle rispettive directory temporanee (`test.log`, `build.log`, `install.log`).

## Risultati audit ordinario e ipotesi

### pi-auto-router

Confermato/parzialmente confermato:

- routing multi-provider, subscription-first, budget giornaliero/mensile, UVI/quota pacing, shadow mode, circuit breaker, cooldown, decision explanation, JSONL append-only, report script, test e MIT;
- stesso-request failover prima di output sostanziale;
- moduli pubblicamente esportati dai file `src`, ma package senza `exports`/API programmatica stabile dichiarata;
- config e file JSON/JSONL sono contratti de facto, non ancora schema stabile formalizzato;
- legge e può aggiornare auth OAuth per quota; rischio elevato per il confine credenziali;
- a budget esaurito può ricadere sulla lista healthy se tutti i candidati sono bloccati: incompatibile con l'hard stop Guardian;
- non modella direttamente i profili Economy/Balanced/Quality/Critical né un mapping semantico completo dei reasoning level.

Decisione **provvisoria**, da ratificare in high: composizione tramite adapter/event log; nessun fork. Guardian deve imporre candidati/tetto/hard stop, auto-router ordinare candidati e gestire failover della stessa richiesta.

### TokenSave/TraceDecay

Confermato/parzialmente confermato:

- Rust, local-first, libSQL locale, MCP stdio, oltre 70 tool, oltre 50 linguaggi, sync incrementale/on-demand, branch/worktree, dashboard/monitor e metriche di saving;
- core non conserva normalmente sorgente grezzo nel grafo, ma read cache e transcript/session store possono contenere testo sorgente o conversazioni;
- rete opzionale per version check, pricing e contatore aggregato; upload counter disabilitabile con `tracedecay disable-upload-counter`;
- metriche di saving sono stime e non prova di costo monetario evitato;
- nomenclatura `tokensave`/`tracedecay` e versioning documentale sono in transizione;
- nessun test reale locale per assenza Rust/binario.

Decisione **provvisoria**, da ratificare in high: componente esterno opzionale dopo il Cost Guard MVP; adapter read-only, upload disabilitato per default, metriche stimate separate da usage/cache/billing.

### pi-tokensaver

Confermato:

- bridge MCP con lifecycle, schema conversion, sync automatico, modifica automatica `.gitignore`, prompt forte, SIGTERM/SIGKILL e test;
- package giovane 0.0.2, peer dependency su namespace precedente `@mariozechner`/`@sinclair`;
- rischio processi/tool/prompt duplicati e side effect automatici.

Decisione **provvisoria**: non adottare; preferire piccolo adapter diretto/read-only o contribuire upstream. Non attivarlo insieme a integrazione diretta.

### pi-token-usage e pi-usage

- `pi-token-usage`: parser locale semplice e testato; input/output/cache/cost, aggregazioni e TUI/footer. Non conserva reasoning, raw+normalized, accounting preciso o dedup robusta per import incrementale. Candidato per estrazione/adattamento del parser, non dipendenza strategica.
- `pi-usage`: quota live multi-provider tramite endpoint non sempre pubblici/stabili e accesso a credenziali. Utile come riferimento per adapter quota futuro, non per M0/M1 e non da invocare senza consenso/rete.
- pi-powerline-footer: pattern TUI utile; nessuna dipendenza necessaria.
- pi-harness-runtime: scope troppo ampio per il Cost Guard; escluso dal core iniziale.

## Priorità economiche autorizzate da incorporare

Ordine vincolante da riportare in documentazione/ADR/roadmap nella prossima sessione:

1. **P0 Cost Guard + Session Handoff Orchestrator**: identità e Master Task Ledger, telemetria/storage, warning/soglie, vero block-next-LLM-call, checkpoint-and-stop, `confirm` handoff in sessione pulita, prompt automatico e human takeover persistente. La roadmap visuale entra solo col minimo locale necessario e non precede questi controlli.
2. **P1 attribuzione consumo**.
3. **P2 riduzione contesto con TraceDecay/TokenSave**, solo dopo misura+stop.
4. **P3 routing economico con pi-auto-router**, Guardian autorità su budget globale/profilo minimo/autorizzazione chiamata/hard stop/telemetria.
5. **P4 riconciliazione provider**.
6. **P5 forecasting/apprendimento dopo dati reali**.
7. **P6 benchmark/condivisione/dashboard senza ritardare la protezione economica**.

Roadmap vincolante (versione più recente; sostituisce l'ordine precedente):

- M0 — Audit minimo, architettura e verifica API session control
- M1 — Cost Guard + confirm handoff + human takeover; roadmap statica solo minima e non bloccante
- M1.1 — supervised-auto + crash recovery
- M1.2 — Guardian Runner per auto, soltanto se necessario
- M2 — Attribuzione, review budget e roadmap visuale completa
- M3 — TokenSave/TraceDecay
- M4 — pi-auto-router
- M5 — Provider e riconciliazione
- M6 — Forecasting
- M7 — Routing adattivo
- M8 — Benchmark
- M9 — Grafici avanzati, inclusa TUI roadmap interattiva
- M10 — Condivisione opt-in
- M11 — Dashboard

M1 deve includere nello stesso vertical slice Persistent Master Task Ledger, telemetria/fasi/storage, warning/soglie, block-next-LLM-call, checkpoint-and-stop, **confirm handoff**, nuova sessione pulita, prompt automatico di ripresa e **human takeover persistente**. La roadmap locale entra soltanto col minimo necessario e non può ritardare questi gate. `supervised-auto` e crash recovery appartengono a M1.1; `auto` usa M1.2/Guardian Runner solo se le API Extension non risultano robuste. Il ledger canonico e il checkpoint-delta devono evitare doppie fonti di verità; handoff preserva lineage/parent e trasferisce solo pacchetto persistente e Resume Context Manifest.

## Decisioni già prese e limiti

- Nome ufficiale progetto: **eiopago**; `Guardian` resta termine di dominio/compatibilità nel mandato, non nome package definitivo.
- Extension-first per M1 `manual`/`confirm` e takeover, subordinato a verifica API. La precedente esclusione RPC dal core è qualificata dal nuovo mandato: AgentSession/RPC è ammesso in M1.2 esclusivamente per un Guardian Runner opzionale se `auto` robusto non è supportato dall'Extension API.
- SQLite previsto come archivio; denaro in integer minor/micro units o decimal text, mai floating point binario nel modello canonico.
- Raw observations separate dai record normalizzati e dalla riconciliazione.
- Local-first, nessun upload implicito, consenso esplicito.
- Composition before fork.
- Queste decisioni architetturali non sono ancora ratificate con reasoning high e ADR.

## File creati

- `CHECKPOINT.md`
- `docs/it/00-regole-operative.md`

Il file canonico delle regole operative è stato creato dopo lo stop originario, su richiesta esplicita dell'utente e senza avviare la fase critica. Nessun commit creato.

## Attività non iniziate

- fase critica high;
- documentazione obbligatoria e ADR;
- scaffold TypeScript;
- schema/migrazione SQLite;
- vertical slice M0 e fixture;
- test eiopago;
- review indipendente;
- M1 e milestone successive.

## Rischi e problemi aperti

1. Contesto sessione corrente al 77,13%: non riutilizzare per la fase critica.
2. Mancanza di hook Pi pubblico esplicitamente bloccabile immediatamente prima della request: progettare e testare il gate M1 senza affermazioni non verificate.
3. pi-auto-router ha 3 test falliti sul main auditato e può ignorare di fatto un budget quando tutti i candidati risultano bloccati.
4. pi-auto-router accede/aggiorna credenziali per quota: Guardian non deve duplicare o ampliare tale autorità.
5. TraceDecay ha rete opzionale e storage locale che può includere source cache/transcript; privacy da configurare esplicitamente.
6. Rebrand TokenSave→TraceDecay e mismatch versioni/adapter possono rompere schemi e nomi tool.
7. pi-tokensaver usa namespace Pi precedenti e side effect automatici.
8. Nessun test reale TraceDecay disponibile nell'ambiente corrente.
9. Repository senza commit base: prima del primo commit concordare se creare un initial foundation commit.
10. Automatic Session Handoff richiede verifica mirata delle semantiche reali di `waitForIdle()`, `ctx.newSession()`, `withSession`, parent linkage, accodamento del comando post-turno e blocco della chiamata successiva; non assumere che gli hook documentati garantiscano atomicità prima del test E2E.
11. Il profilo `medium` corrente impedisce di ratificare state machine, autorità e failure semantics del nuovo requisito; nessuna progettazione è stata avviata in questa sessione.
12. Il pacchetto di handoff deve evitare duplicazione col checkpoint canonico, contenuti estesi, cronologia, reasoning interno e segreti; schema/versionamento e redazione richiedono una decisione esplicita.
13. Quality Gate, Continuity Check, idempotenza e crash recovery sono confini di sicurezza: una discrepanza Git/checkpoint o un passaggio ambiguo deve bloccare modifiche e ripresa.
14. I risparmi di contesto/cache e la conservazione della qualità restano ipotesi da misurare; non dichiararli dimostrati senza A/B o osservazioni sufficienti.
15. Il task corrente non ha ancora un Master Task Ledger: prima della fase architetturale va creato e popolato in modo conciso dal checkpoint, senza duplicarlo; struttura, task ID e schema version richiedono ratifica `high`.
16. Coerenza obbligatoria: nessun requisito nuovo senza task, nessun `DONE` senza evidenza, nessuna attività attiva legata a requisiti superati e nessuna ripresa quando ledger/checkpoint/Git divergono.
17. La visual roadmap deve essere una proiezione deterministica di fonti canoniche, non una nuova fonte di verità; servono regole di ordinamento, aggregazione, deduplica e gestione dati incompleti.
18. Checkpoint previsti/mancanti e diramazioni operative richiedono entità/eventi espliciti: non dedurli ambiguamente dalla sola cronologia delle sessioni.
19. Rendering terminale stretto, fallback ASCII, output JSON stabile e riconciliazione costi richiedono criteri/test mirati; nessuna chiamata LLM/provider è consentita dal comando.
20. I valori assenti devono restare `unknown`: trattarli come zero falserebbe aggregazioni, costi e gate.
21. Renderer e output devono neutralizzare terminal escape e CSV/formula injection; nomi/messaggi non sono input fidati.
22. La relazione Markdown/SQLite resta aperta: nell'MVP, se Markdown è primario, l'import DB deve essere idempotente e i conflitti visibili; nessuna sincronizzazione silenziosa.
23. La TUI interattiva è fuori dal primo vertical slice e non deve ritardare warning, soglie o block-next-LLM-call.
24. Human takeover deve prevalere anche durante race con HANDOFF_COMMIT: il latch persistito non va perso e la nuova sessione deve restare pausata senza prompt.
25. Hotkey/input interception e steering durante esecuzione dipendono dalle API Pi effettive e dal terminale Windows; preservare Escape e non sovrascrivere binding.
26. Extension e possibile Runner devono condividere database, policy e state machine senza duplicare telemetria o piano.
27. `auto` non è supportata per assunzione: se l'Extension richiede hack fragili, progettare Runner AgentSession/RPC e mantenerla disabilitata per default.
28. Modifiche umane al piano invalidano prompt/checkpoint incoerenti, versionano il ledger e richiedono approvazione prima della ripresa.

## Operazioni da non ripetere

- Non rileggere integralmente la documentazione Pi 0.83.0 elencata sopra.
- Non ripetere inventario toolchain/Pi salvo verifica rapida di eventuali cambi.
- Non riclonare i repository se `%TEMP%/eiopago-m0-audit` esiste con gli SHA indicati.
- Non ripetere i test terzi sopra salvo cambio SHA/dipendenze o necessità mirata.
- Non leggere o mostrare credenziali; non modificare `~/.pi`.
- Non installare globalmente Rust, Bun, TraceDecay o package Pi.
- Non iniziare M1, sub-agent o review automatica.

## File da leggere alla ripresa

1. `docs/it/00-regole-operative.md`
2. `CHECKPOINT.md`
3. Il mandato originale presente nella sessione precedente, solo se necessario per verificare un requisito non riassunto qui
4. Sorgenti terzi mirati nella directory temporanea, solo per domande ancora aperte
5. Documenti di progetto man mano che vengono creati; non esistono ancora README/ADR

## Prossimo passo

Aprire una nuova sessione sullo stesso branch con `openai-codex/gpt-5.6-sol` e reasoning `high`. Verificare rapidamente branch/status e nuove statistiche. Eseguire soltanto la fase critica delimitata:

- priorità P0–P6 e roadmap M0–M11;
- architettura e confini Guardian/auto-router;
- accounting, denaro e riconciliazione;
- credenziali/threat model/privacy;
- budget/stop e fattibilità block-next-LLM-call;
- Persistent Master Task Ledger: convenzione, requisiti/versioni, task/DAG, evidenze, eventi, rapporto col checkpoint e controlli di coerenza; creare il ledger canonico iniziale senza duplicare il checkpoint;
- Visual Task Roadmap/Checkpoint History: comando locale, plan/history/combined, viste/filtri, `checkpoint_message`, `ExpectedCheckpoint`, review/finding/fix/test, DAG e lineage, usage/cost, aggregazioni, rendering sicuro e schema JSON versionato;
- Session Handoff Orchestrator P0: `confirm` + human takeover in M1, supervised-auto/crash recovery in M1.1 e Runner/auto solo se necessario in M1.2;
- comandi di controllo, persistent human-control latch, hotkey/steering deterministici, HANDOFF_ARMED/COMMIT interrompibile, precedenze e tre scenari E2E prioritari;
- verifica mirata Extension API vs AgentSession/RPC e classificazione `confermato`/`da testare`/`non supportato`/`Runner`;
- matrice reuse/composition/fork/rewrite;
- visione, requisiti, casi d'uso, architettura, modello dati, budget/stop, routing, roadmap, sicurezza, benchmark, domande aperte, documento dedicato e ADR non duplicati;
- ADR critici.

Al termine registrare le decisioni e valutare uno stop oppure una nuova sessione `medium` per scaffold/vertical slice/test.

## Comandi di ripresa

```bash
cd E:/dev/eiopago
git status --short --branch
printf '%s/%s reasoning=%s\n' "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"
```

Se i clone temporanei sono ancora presenti:

```bash
for d in "${TEMP:-/tmp}/eiopago-m0-audit"/*; do
  [ -d "$d/.git" ] && printf '%s %s\n' "$(basename "$d")" "$(git -C "$d" rev-parse HEAD)"
done
```

## Ripresa in una nuova sessione

Regola operativa: ogni checkpoint di chiusura deve riportare sia il prompt minimo di ripresa sia un nome breve e descrittivo suggerito per la nuova sessione.

**Nome sessione suggerito:** `eiopago-m0-handoff-takeover-api-high`

### Prompt minimo per la nuova sessione high

> Leggi `docs/it/00-regole-operative.md` e `CHECKPOINT.md`; non ripetere audit/test né ricreare documenti. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`, altrimenti aggiorna checkpoint e fermati. Completa solo M0: crea il Master Task Ledger; verifica API Pi mirate per confirm handoff, new session/parent/prompt, block-next-call, abort, takeover/hotkey/steering e persistence; decidi Extension vs Runner. Ratifica state machine, latch, comandi, precedenze, tre E2E e roadmap M1/M1.1/M1.2; aggiorna requisiti, architettura, modello dati, casi d'uso, test e ADR senza duplicazioni. Non iniziare M1 né modificare `~/.pi`. Chiudi aggiornando ledger/checkpoint e prossimo gate.
