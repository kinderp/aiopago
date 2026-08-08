# M1-H1 — Context Handoff Advisor e fix F1

## Perimetro

H1-01 resta invariato. Questo documento registra soltanto `M1-H1-F1` (issue #8): persistenza dell'owner gate già soddisfatto e attestazione minimale della ownership della replacement session. Cost Guard e orchestrazione general-purpose restano fuori scope.

## Finding A — owner gate stale

**Causa:** `/eio handoff confirm` importava il Ledger senza applicare una transizione canonica del gate. Checkpoint e manifest venivano quindi sigillati con `current_item=null`, `next_item=ITEM-H1-02` e il vecchio `next_step` che richiedeva ancora lo stesso comando.

**Fix:** in modalità `confirm`, prima di leggere il piano usato per safe point e sealing, `TaskLedger.satisfyOwnerGate()` applica una scrittura atomica temp+fsync+rename della nuova revisione Markdown. La transizione richiede attore `human:*`, comando esatto, lifecycle bloccato coerente e un vero `satisfied_next_step`. L'E2E verifica prima del seal:

- `ITEM-H1-01 = DONE`;
- `ITEM-H1-02 = IN_PROGRESS`;
- `current_item = ITEM-H1-02`;
- `next_item = ITEM-H1-03`;
- `next_step` privo di una nuova richiesta `/eio handoff confirm`.

## Finding B — Runner ownership non verificabile

**Causa:** `replacement_session_id` era presente nel journal/projection e nel manifest, ma la sessione Pi corrente non possedeva una credenziale di binding installata dal Runner. Il solo manifest non poteva attestare l'identità runtime e il fail-closed era quindi corretto.

**Fix minimale:** ogni processo `GuardianRunner` genera un `runner_instance_id`; ogni handoff genera un nonce `session_binding_id`. Il Runner usa la API pubblica Pi `newSession({ setup(sessionManager) })` per aggiungere alla replacement session una `CustomEntry` non inclusa nel contesto LLM (`eiopago.runner-session-binding.v1`) durante il setup, prima di qualsiasi conversation entry. La entry contiene:

- `handoff_id`;
- `replacement_session_id` ottenuto dal `SessionManager` reale;
- `runner_instance_id`;
- `session_binding_id`.

La stessa relazione viene persistita nella tabella SQLite `runner_session_bindings` e nell'evento append-only `RUNNER_SESSION_BOUND`, quindi inserita nel Resume Context Manifest sealed. Il Continuity Check estrae l'unica binding entry dalla sessione runtime corrente e richiede uguaglianza completa tra:

```text
runtime/session binding == SQLite/journal binding == manifest binding == handoff/current Runner
```

Binding mancante/duplicato, installato dopo una conversation entry, Runner/target/nonce/handoff diverso o binding `SUPERSEDED` produce `RUNNER_OWNERSHIP_ATTESTATION_FAILED`. Nessuna admission viene aperta.

## Test offline

I test deterministici coprono pass attestation, sessione Pi non Runner-owned, mismatch di Runner/target/nonce/handoff, binding superseded, relazione SQLite+journal, owner-gate transition prima del seal, no-history, manifest binding, ordine `RUNNER_SESSION_BOUND` prima del manifest, resume senza seconda richiesta e admission idempotente. Il provider è fake e `fetch` è bloccato.

## Dogfood reale post-fix

L'owner ha confermato il run Runner-owned seguente:

- handoff `HO-27f6d0dcd68e7349bdd149de`;
- source `019fe1fb-d7b3-71f5-ac0e-dfd35e3f268d`;
- replacement `019fe1fc-aeca-76b7-99b5-c880d3b75a7d`;
- Runner ownership attestation e Continuity Check: **PASS**;
- resume admission: autorizzata una sola volta;
- lifecycle ripreso: `ITEM-H1-02=IN_PROGRESS`, `next_item=ITEM-H1-03`, owner gate `SATISFIED`;
- conversation history trasferita: **ZERO**;
- minimal reads effettivi: **6**.

Il comportamento osservato è coerente con il codice: owner gate prima del seal, binding durante `newSession({ setup })`, relazione persistita in SQLite/journal/manifest, confronto fail-closed delle quattro viste e admission idempotente.

Le metriche context/token/cache/costo delle sessioni post-fix A e B non sono disponibili negli artefatti runtime ricevuti e restano `unknown`. Le metriche precedentemente raccolte appartengono a una sessione pre-fix diversa e non sono usate per stimare il beneficio del run post-fix. Anche le dimensioni esatte degli artefatti restano `unknown` perché l'API file corrente non espone byte-stat. Il beneficio osservato è quindi qualitativo e verificabile: continuità strutturata con zero history, non una percentuale universale di risparmio.

## Acceptance finale

I gate shell sono stati eseguiti manualmente dall'owner nel TUI:

- `npm run check`: **PASS**, 18 moduli;
- `npm test`: **PASS**, 22/22 test, 15 top-level, E2E 6/6, zero failure;
- `git diff --check`: **PASS**, con solo warning informativo LF→CRLF su `TASK_PLAN.md`.

H1-02 e H1-03 sono `DONE`; M1-H1 è **DONE / PASS**. Non è stato eseguito un altro handoff, H1-01 non è stato ripetuto e Cost Guard/M1-H2 non sono stati iniziati.

## Limiti

La CustomEntry è metadata persistito di sessione e non conversation authority. L'attestazione opera nel trust boundary locale del processo/filesystem: non è una firma contro un amministratore locale che possa alterare insieme sessione, SQLite e artefatti. Un nuovo processo Runner riceve un diverso `runner_instance_id`; il recupero automatico post-crash non è implementato in F1 e resta fail-closed.
