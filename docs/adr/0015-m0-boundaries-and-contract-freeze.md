# ADR-0015 — M0.1 Contract and Boundary Freeze

- **Stato ADR:** DECIDED
- **Data:** 2026-08-05
- **Milestone:** M0.1
- **Profilo di ratifica:** `openai-codex/gpt-5.6-sol`, reasoning `high`
- **Ambito:** decisioni e contratti; nessuna implementazione
- **Contratti collegati:** [`../contracts/m0-contracts.md`](../contracts/m0-contracts.md)
- **Roadmap collegata:** [`../roadmap.md`](../roadmap.md)

## 1. Contesto e vincoli

Aiopago/Guardian deve rendere implementabile M1 senza diventare un orchestratore durevole o un control plane globale. Il report di copertura ha rilevato fonti concorrenti potenziali, assenza di un checkpoint model atomico, confini esterni non congelati e API Pi non verificate al livello necessario.

Questo ADR non rende alcuna funzionalità runtime `COMPLETE`. Congela confini e contratti; codice, migrazioni e test restano M1 o milestone successive.

### Legenda decisionale

- **DECIDED:** vincolo ratificato da M0.1.
- **PROVISIONAL:** scelta sufficiente a progettare, da validare prima o durante M1.
- **NEEDS_SPIKE:** semantica non dimostrata; il relativo criterio M1 non può chiudersi senza spike.
- **DEFERRED:** fuori da M0.1 e non implementato ora.

## 2. Decisioni ratificate

### D1 — Strategia C: ownership ibrida per tipo di dato (DECIDED)

Sono state considerate:

- **A. Markdown canonico, SQLite derivato:** semplice da revisionare ma inadatto a latch, telemetria e transazioni concorrenti.
- **B. SQLite canonico, Markdown projection:** forte per runtime ma rende fragile il piano umano e crea un bootstrap opaco.
- **C. Ownership distinta per dato:** ogni categoria ha una sola fonte autorevole; SQLite può contenere sia dati canonici runtime sia indici esplicitamente derivati.

È scelta **C**. Non esiste sincronizzazione bidirezionale generica. Ogni tabella/file dichiara `authority` e `schema_version`; una projection non corregge mai la fonte.

| Dato | Fonte autorevole MVP | Chi può modificarlo | Projection/consumer | Conflitto e fail-closed | Recovery/versionamento |
|---|---|---|---|---|---|
| Master Task Ledger | Markdown canonico versionato (`TASK_PLAN.md` per il task standalone; path configurabile in futuro) | Utente; Guardian solo tramite operazione validata e revisionata | Indice SQLite e roadmap runtime, solo derivati | Hash/revisione inattesi bloccano update, handoff e `DONE`; nessun merge silenzioso | Git/storia file + `plan_revision`; reimport idempotente |
| Checkpoint Guardian | Oggetto `CandidateCheckpoint` immutabile, serializzato come artefatto JSON versionato in `.guardian/checkpoints/` | Guardian produce; verificatore Guardian aggiunge eventi di stato separati; l'utente può richiedere un successore | Indice SQLite e vista Markdown, derivati | Digest/schema/parent/Git incoerenti producono `INVALID`; non si riscrive l'artefatto | Scrittura temp+rename; scansione e reindicizzazione; SemVer schema |
| Telemetria locale | SQLite Guardian, record append-only raw + normalizzati separati | Collector Guardian; reconciler aggiunge record, non sovrascrive raw | CSV/JSON/roadmap/report | DB non leggibile: stop budget fail-closed; dati mancanti=`unknown` | WAL/backup/migrazioni versionate; replay da eventi/session JSONL dove disponibile |
| Stato handoff | SQLite Guardian, state machine + journal/idempotency key | Solo transition service deterministico; takeover può interrompere secondo precedenza | Stato UI/roadmap | Transizione illegale o generazione incoerente blocca handoff e prompt | Reconciliation journal↔session Pi↔checkpoint dopo restart |
| Human-control latch | SQLite Guardian, record monotono con generation e actor | Attivabile da utente, sicurezza o budget secondo causa; **rilasciabile solo dall'utente** | Cache in memoria non autorevole | DB assente/corrotto/ambiguo equivale a latch attivo; nessuna chiamata/tool/handoff | Reload dal DB; recovery esplicito; audit append-only per activate/release |
| Roadmap Markdown | `docs/roadmap.md` per scope e milestone di prodotto | Umano tramite review Git | `/guardian roadmap` non la usa come stato runtime | Divergenza con contratti blocca la modifica documentale, non viene “riparata” dal DB | Git/versione documento; ADR per cambi di confine |
| Stato runtime della roadmap | Projection deterministica da Ledger, checkpoint, handoff, sessioni e telemetria | Nessuna scrittura diretta | CLI/TUI/JSON | Projection non valida segnala errore; non muta fonti | Ricostruibile; schema output versionato |
| Stato Git | Repository/Git per file, HEAD, index e worktree | Utente e strumenti autorizzati; Guardian non crea commit senza policy esplicita | `GitState` nel checkpoint è snapshot/riferimento | Mismatch con checkpoint/ledger blocca continuity e handoff | Re-scan Git; nessuna correzione automatica |
| Costo provider | Billing definitivo provider per addebito; Pi/provider response/local estimate restano fonti distinte | Importer/reconciler appendono osservazioni | Record reconciled con stato `pending/matched/mismatch` | Fonte assente resta `unknown/pending`; mai sostituita con zero | Import idempotente e provenance; schema/versione adapter |
| Evidenze | Artefatto originario: Git/repository per codice e test; provider per billing; Raiatea futuro per provenance generale | Producer autorizzato; Guardian crea solo `EvidenceReference` | Checkpoint e FARO risolvono riferimenti | Digest/locator non verificabile impedisce `VERIFIED` quando richiesto | Nuovo riferimento/versione; mai mutazione della prova accettata |

#### Sincronizzazione e conflitti

1. Ogni projection registra revisione/digest della fonte.
2. L'import confronta revisioni prima di scrivere; non effettua last-write-wins.
3. Un conflitto genera evento e stato bloccante; l'utente sceglie la fonte o crea una nuova revisione.
4. Il DB non esporta modifiche nel Ledger Markdown salvo comando umano esplicito e compare-and-swap sulla revisione.
5. Checkpoint e Ledger non contengono segreti; un secret-scan fallito blocca la candidatura.
6. Nel futuro il Ledger potrà migrare a SQLite canonico solo con nuovo ADR, migrazione one-way, backup, conformance e rimozione dell'autorità Markdown. Non è ammesso un periodo indefinito con due fonti canoniche.

### D2 — Checkpoint come commit operativo, distinto da Git (DECIDED)

- La sessione è un working environment temporaneo.
- Una sessione può terminare senza checkpoint valido.
- Il checkpoint è l'unità operativa atomica, verificabile e riprendibile.
- `VERIFIED` è assimilabile a un commit operativo Guardian, ma non equivale a un commit Git né ad acceptance globale.
- Un checkpoint può riferirsi a zero, uno o più commit Git e deve sempre registrare lo snapshot del worktree.
- La history dei checkpoint è un DAG. Il parent primario preserva la linea principale; merge parent opzionali rappresentano ricongiungimenti senza falsare una gerarchia.
- Da `CANDIDATE` in poi il payload è content-addressed e immutabile. Correzioni e retry producono un nuovo checkpoint figlio con nuovo ID.
- L'acceptance esterna appartiene a `CheckpointDecision` e non modifica il checkpoint.

Il modello, i campi, le transizioni e i casi limite sono normativi in `docs/contracts/m0-contracts.md`.

### D3 — Ledger, checkpoint, ADR e Git hanno ruoli non sovrapposti (DECIDED)

| Artefatto | Domanda | Contenuto normativo |
|---|---|---|
| Master Task Ledger | Cosa resta da fare nell'intero task? | Requisiti/versioni, DAG, task item, dipendenze, stato globale, criteri/evidenze globali |
| Checkpoint | Quale delta verificabile è stato consolidato e come si riprende? | Session/run lineage, piano revisionato, GitState, evidenze, rischi, usage/costo, next step |
| ADR/documentazione canonica | Quali decisioni permanenti valgono? | Motivazioni, trade-off, contratti e confini |
| Git/repository/test | Qual è lo stato tecnico reale? | File, commit, worktree, build, test e artefatti |

Relazione minima:

`Task → TaskItem → Session → CandidateCheckpoint → VerifiedCheckpoint → ExternalDecision?`

Un checkpoint può includere più sessioni e, in futuro, più run; una sessione può produrre zero o più draft ma al massimo un candidato per la stessa idempotency key. `TaskItem`, sessione e run non diventano `DONE` per la sola dichiarazione dell'agente.

### D4 — State machine handoff e priorità (DECIDED)

Percorso nominale:

`RUNNING → THRESHOLD_DETECTED → SAFE_POINT_REQUESTED → CHECKPOINT_PREPARING → HANDOFF_PREPARED → HANDOFF_ARMED → HANDOFF_COMMIT → NEW_SESSION_PAUSED → CONTINUITY_CHECK → RESUME_READY → RESUMED`

Stati bloccanti/errore:

- `CHECKPOINT_INVALID`
- `GIT_STATE_MISMATCH`
- `BUDGET_BLOCKED`
- `HUMAN_TAKEOVER_REQUESTED`
- `CONTINUITY_FAILED`
- `HANDOFF_FAILED`
- `MAX_HANDOFFS_REACHED`

Guardie nominali:

| Transizione | Guardia minima |
|---|---|
| `RUNNING → THRESHOLD_DETECTED` | osservazione versionata supera trigger configurato |
| `THRESHOLD_DETECTED → SAFE_POINT_REQUESTED` | latch/budget intent persistito prima di chiedere la chiusura atomica |
| `SAFE_POINT_REQUESTED → CHECKPOINT_PREPARING` | nessun tool mutante in corso, queue controllata e repository osservabile |
| `CHECKPOINT_PREPARING → HANDOFF_PREPARED` | candidato sealed, Quality Gate positivo, GitState e Ledger revision coerenti |
| `HANDOFF_PREPARED → HANDOFF_ARMED` | conferma richiesta ottenuta, limiti handoff/sessione validi, latch generation invariata |
| `HANDOFF_ARMED → HANDOFF_COMMIT` | `COMMIT_INTENT` durevole e idempotency key esclusiva |
| `HANDOFF_COMMIT → NEW_SESSION_PAUSED` | target registrato oppure failure journal riconciliabile; mai prompt in commit |
| `NEW_SESSION_PAUSED → CONTINUITY_CHECK` | runtime nuovo rebindato e latch riletto dalla fonte autorevole |
| `CONTINUITY_CHECK → RESUME_READY` | checkpoint/digest, parent, Ledger, Git, budget e next step verificati |
| `RESUME_READY → RESUMED` | latch rilasciato/mai attivato e `PROMPT_ARMED` persistito; invio exactly-once |

| Stato errore | Ingresso | Uscita consentita |
|---|---|---|
| `CHECKPOINT_INVALID` | Quality Gate/schema/digest/secret scan fallisce da PREPARING/PREPARED/ARMED | nuovo checkpoint ID da PREPARING oppure stop umano; mai riabilitare lo stesso candidato |
| `GIT_STATE_MISMATCH` | snapshot differisce durante prepare/arm/continuity | dopo decisione umana o nuova revisione/checkpoint, ritornare a PREPARING/CONTINUITY_CHECK |
| `BUDGET_BLOCKED` | hard budget prevale in qualsiasi stato | solo override umano limitato e auditato o checkpoint-and-stop; non autorizza call per ripararsi |
| `HUMAN_TAKEOVER_REQUESTED` | takeover in qualsiasi stato | latch attivo; prima del commit annulla, durante/dopo commit converge su NEW_SESSION_PAUSED; solo resume umano |
| `CONTINUITY_FAILED` | check nella sessione nuova fallisce | resta pausato; dopo correzione verificabile ripete CONTINUITY_CHECK o produce nuovo checkpoint |
| `HANDOFF_FAILED` | create/rebind/journal fallisce | reconciliation deterministica o scelta umana; nessun retry cieco/secondo target |
| `MAX_HANDOFFS_REACHED` | limite task/sessione raggiunto prima di arm | stop/continuazione manuale autorizzata; nessun auto-handoff |

Precedenza invariabile:

1. human takeover;
2. emergency safety stop;
3. hard budget;
4. repository e checkpoint integrity;
5. handoff;
6. piano dell'agente;
7. ottimizzazione economica.

#### Regole operative

- Il latch viene persistito prima dell'effetto di controllo e blocca nuove LLM call, tool agentici, handoff, cambi modello/reasoning, aumento budget e mutazioni piano.
- Il rilascio è una nuova operazione auditata, con actor umano; silenzio, timeout o messaggio del modello non rilasciano il latch.
- Due comandi con la stessa idempotency key restituiscono lo stesso esito; con chiavi diverse e una transazione attiva, il secondo è rifiutato o accodato come intent umano prioritario.
- Un takeover prima di `HANDOFF_COMMIT` annulla l'intent senza creare la sessione.
- Durante `HANDOFF_COMMIT` il takeover viene persistito; si completa soltanto lo switch tecnico già iniziato e la nuova sessione resta `NEW_SESSION_PAUSED`, senza prompt automatico.
- Il prompt viene inviato una sola volta, soltanto dopo `CONTINUITY_CHECK` positivo, latch rilasciato e stato `RESUME_READY`.

#### Atomicità di `HANDOFF_COMMIT`

La creazione della sessione Pi è un effetto esterno e non può condividere una transazione ACID con SQLite. Si usa una saga fail-closed:

1. persistere `COMMIT_INTENT` con checkpoint digest, parent, idempotency key, latch generation e target non ancora noto;
2. invocare la creazione della nuova sessione;
3. persistere target session ID/path e `COMMIT_APPLIED`;
4. entrare sempre in `NEW_SESSION_PAUSED`;
5. eseguire continuity; inviare il prompt solo con un evento `PROMPT_ARMED` poi `PROMPT_SENT` idempotente.

Dopo crash si riconciliano journal, parent/session Pi e checkpoint. Stato ambiguo significa pausa; non si crea una seconda sessione finché l'utente o il reconciler deterministico non identifica l'effetto precedente. Pi 0.83.0 distrugge il vecchio runtime prima di completare la creazione del nuovo: un errore di creazione non offre rollback automatico e deve portare a `HANDOFF_FAILED` fail-closed.

### D5 — Fallback minimo per block-next-call (PROVISIONAL, NEEDS_SPIKE)

L'Extension API 0.83.0 non espone un `before_llm_call` bloccabile. `before_provider_request` può sostituire il payload ma non ha un risultato `block`; non è un gate di budget.

Fallback Extension-first più piccolo da provare in M1:

1. persistere latch/budget gate;
2. intercettare ogni `input` con `action: "handled"` quando bloccato;
3. bloccare ogni `tool_call`;
4. chiamare `ctx.abort()` appena il gate scatta;
5. impedire/azzerare steering e follow-up pendenti tramite superficie supportata dall'host;
6. accettare soltanto comandi locali di status/recovery/takeover/resume.

Questo non è dichiarato sufficiente finché uno spike non prova l'assenza di una request successiva in tutte le race (tool loop, retry, compaction retry, steering e follow-up). Nessun parsing del testo terminale è accettabile.

Se lo spike fallisce, il vero gate deve stare nel `streamFn`/request admission di un **Guardian Runner** basato su `AgentSession` o RPC. In tal caso la garanzia forte è `REQUIRES_RUNNER`, M1 consegna soltanto il fallback esplicitamente qualificato se accettato, e M1.2 diventa necessaria prima di abilitare `auto`.

### D6 — Confini dell'ecosistema e standalone (DECIDED come ipotesi architetturale)

| Componente | Possiede | Non possiede in Aiopago |
|---|---|---|
| Aiopago/Guardian | sessioni Pi, contesto, token/costi locali, Cost Guard, handoff, takeover, Ledger locale, `CandidateCheckpoint`, roadmap/report locali, modalità standalone | queue durevole generale, lease worker, backlog globale, GitHub write, metodologia globale, acceptance globale, evidence repository generale |
| Durex | queue, task/run durevoli, worker, claim, lease/fencing, heartbeat, retry/resume, cancellazione, process ownership, output persistente | contesto LLM, policy di fase, acceptance |
| FARO Governance | backlog globale, metodologia/policy progetto, task/checkpoint graph globale, priorità, assegnazione, acceptance, GitHub synchronization, project babysitting | esecuzione di sessione e worker lease |
| Raiatea | evidence bundle, provenance, risoluzione e verifica delle evidenze | scheduling e session control |
| Alfred | osservazione di eventi e segnali | task scheduling, session management, acceptance |

Aiopago standalone segue `Pi → Guardian → checkpoint locale`. Le integrazioni sono adapter opzionali, provider-neutral, senza database condiviso o import di moduli interni. In assenza di consumer esterni, gli ID `project_id`, `run_id` ed external decision possono essere null secondo contratto; Cost Guard, handoff manual/confirm, takeover, Ledger e roadmap locale restano utilizzabili.

`CheckpointDecision` è un contratto futuro: Guardian lo consuma ma non produce acceptance globale. `EvidenceReference` è prodotto localmente per evidenze del repository; Raiatea può risolverlo/arricchirlo in futuro senza diventare dipendenza dell'MVP.

## 3. Matrice API Pi 0.83.0

Classificazione basata su documentazione installata, type declarations/source runtime 0.83.0 e due smoke spike offline in `%TEMP%`. `CONFIRMED` significa superficie e percorso implementativo riscontrati senza rete; non sostituisce i test E2E Guardian M1.

| Capacità | Stato | Evidenza locale | Spike/test M1 richiesto |
|---|---|---|---|
| Intercettare eventi usage | CONFIRMED | Eventi `message_end`/`tool_result`, usage assistant/tool nei tipi e JSONL reali già auditati | Fixture con assistant/tool/compaction e dedup |
| Leggere statistiche sessione | CONFIRMED | `AgentSession.getSessionStats()`, RPC `get_session_stats`; smoke RPC offline riuscito | Golden con categorie mancanti=`unknown` |
| Bloccare la LLM call successiva | NEEDS_SPIKE | Nessun risultato block su `before_provider_request`; `input` può essere handled e `tool_call` bloccato | **SP-01** race matrix no-provider; se fallisce → REQUIRES_RUNNER |
| Abortire uno stream | CONFIRMED | `ctx.abort()`, `AgentSession.abort()`, RPC `abort`, sorgente usa `AbortController` | **SP-02** fake slow stream: abort, persistenza messaggio aborted, nessun retry |
| Attendere un safe point | NEEDS_SPIKE | `waitForIdle()` esiste ma attende anche retry/compaction/queued continuation; non equivale da solo a safe point | **SP-03** safe-point con tool batch, queue e takeover |
| Ricevere input o steering | CONFIRMED | evento `input`, `steer/followUp`, source/queue types ed esempi | Test convergenza di input, hotkey e steering sul latch |
| Registrare comandi | CONFIRMED | `registerCommand`; command context separato | Test doppio comando/idempotency |
| Mostrare conferme | CONFIRMED | `ctx.ui.confirm` in TUI e protocollo UI RPC | Test cancel/timeout/no-UI fail-closed |
| Creare nuova sessione | CONFIRMED | `ctx.newSession`, `AgentSessionRuntime.newSession`, RPC; smoke offline cambia session ID/path | E2E replacement failure e teardown ordering |
| Impostare parent session | CONFIRMED | `parentSession` nell'header v3; smoke `SessionManager` prova parent e assenza history parent | Test path non disponibile/deferred persistence |
| Inviare prompt nella nuova sessione | NEEDS_SPIKE | `withSession.sendUserMessage()` esiste; callback usa contesto nuovo, ma invia una LLM call | **SP-04** exactly-once, paused-before-prompt, crash fra armed/sent |
| Assegnare nome sessione | CONFIRMED | `setSessionName`, RPC `set_session_name`; smoke riuscito | Test nome persistito dopo prima risposta |
| Cambiare modello | CONFIRMED | `pi.setModel`/`AgentSession.setModel`/RPC `set_model` implementati | Test auth failure + blocco latch |
| Cambiare reasoning | CONFIRMED | `setThinkingLevel`, clamp e persistence; RPC | Test clamp/provider mapping + blocco latch |
| Chiudere o sospendere sessione | NEEDS_SPIKE | `ctx.shutdown()` chiude graceful; non esiste suspend durevole nativo equivalente al latch | **SP-05** shutdown con queue e pausa Guardian senza prompt |
| Recuperare dopo reload o crash | REQUIRES_RUNNER | Reload lifecycle è presente; un'Extension non riavvia da sola il processo dopo crash | **SP-06** reload state restore in M1.1; Runner/process owner per unattended crash |

### Smoke spike M0.1 eseguiti

- **RPC offline, HOME/USERPROFILE e session-dir temporanei:** `get_state`, `get_session_stats`, `set_session_name`, `new_session(parentSession)`, `abort` idle e bash locale; nuova sessione con ID/path distinti, nessuna rete/provider call, exit 0.
- **SessionManager offline:** header v3 del child contiene `parentSession`; il contesto child contiene solo messaggi child e non il testo parent. È stato osservato che il file JSONL è materializzato alla prima risposta assistant persistita, quindi il commit journal non può assumere esistenza immediata del file.

## 4. Roadmap congelata

- **M0.1:** questo freeze documentale.
- **M1:** Cost Guard + confirm handoff + human takeover, secondo i criteri in `docs/roadmap.md`.
- **M1.1:** supervised-auto + crash recovery.
- **M1.2:** Guardian Runner soltanto se SP-01/SP-04 o automazione non presidiata lo richiedono.
- **M2–M11:** invariati e descritti nella roadmap.

## 5. Decisioni provvisorie e rinvii

### PROVISIONAL

- Path definitivo del Ledger (`TASK_PLAN.md` è il default standalone proposto).
- Artefatti checkpoint JSON sotto `.guardian/checkpoints/`; nome/path da confermare nello scaffold M1 senza cambiare autorità o immutabilità.
- Fallback Extension-first per block-next-call, subordinato a SP-01.
- Raiatea come resolver futuro di `EvidenceReference`; il contratto resta provider-neutral.

### NEEDS_SPIKE

SP-01…SP-06 nella matrice, più:

- **SP-07:** collisioni shortcut Windows e preservazione Escape.
- **SP-08:** failure di `newSession()` dopo teardown del vecchio runtime e recovery dal journal.
- **SP-09:** concorrenza takeover durante `HANDOFF_COMMIT` e nessun prompt automatico.
- **SP-10:** reimport idempotente Ledger/checkpoint e conflitto hash visibile.

### DEFERRED

- Storage/migrazioni, implementazione schema e conformance fixtures: M1.
- supervised-auto e recovery completo: M1.1.
- Runner/auto: M1.2 solo se necessario.
- Adapter Durex/FARO/Raiatea/Alfred, provider, TokenSave e pi-auto-router: fuori da questa sessione e dalle consegne M1 iniziali salvo contratti neutrali.

## 6. Conseguenze e rischi aperti

1. La strategia ibrida è sicura solo se ogni tabella/file dichiara autorità; una sync bidirezionale la renderebbe invalida.
2. JSON checkpoint e Ledger Markdown richiedono scritture atomiche, digest e conformance prima di uso reale.
3. Pi non offre un block hook Extension immediatamente prima della request: SP-01 è gate critico M1.
4. `newSession()` esegue teardown prima che la nuova runtime sia garantita; serve journal e failure test.
5. `sendUserMessage()` avvia una call: non può essere eseguito finché latch e continuity non sono positivi.
6. Crash recovery non presidiato implica process ownership esterna/Runner; non va simulato con terminal scraping.
7. `VERIFIED` Guardian non significa `ACCEPTED`; UI e roadmap devono mantenere la distinzione.
8. Nessun contratto deve contenere segreti o reasoning interno.

## 7. Criterio di chiusura M0.1

M0.1 è chiusa documentalmente quando questo ADR, i contratti, la roadmap, il report di copertura e il checkpoint di sessione sono coerenti. Ciò non chiude alcun criterio M1 e non autorizza implementazione automatica.
