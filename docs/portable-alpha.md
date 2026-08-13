# Eiopago Portable Alpha — installazione, avvio e handoff

Eiopago è installato separatamente dal repository su cui lavora. Nel target non copia il proprio source, non aggiunge dipendenze applicative e non modifica `package.json`.

## Prerequisiti

- Node.js **22.19.0 o successivo**;
- Git su `PATH` e un normale Git worktree, inclusi linked worktree;
- `@earendil-works/pi-coding-agent` **0.83.x** accanto all'installazione Eiopago;
- un provider Pi configurato e utilizzabile.

Eiopago verifica i prerequisiti prima di init e launch. Non installa e non aggiorna automaticamente Node, Git o Pi. Se Pi è installato in una posizione non risolvibile, impostare `PI_CODING_AGENT_ROOT` alla directory del package Pi. Un override errato fallisce senza fallback al `node_modules` del target.

## Installazione locale alpha

Dal repository/package Eiopago:

```text
npm link
```

In alternativa:

```text
npm install --global F:/dev/eiopago-m1-p0
```

Per provare esattamente il contenuto impacchettato senza pubblicarlo:

```text
npm pack
npm install --global ./eiopago-0.1.0.tgz
```

La Portable Alpha non viene pubblicata su npm.

## Inizializzare un target

Dentro il worktree target:

```text
eio init
```

Oppure da qualsiasi directory:

```text
eio init --target F:/dev/un-altro-progetto
```

Sono accettati anche path nested, path con spazi e linked worktree. Git determina sempre il top-level reale. `eio init`:

1. verifica Node, Git, Pi e target;
2. preserva config e Ledger compatibili;
3. crea solo lo stato Eiopago mancante;
4. aggiunge un blocco delimitato e idempotente a `.gitignore`;
5. stampa root, versioni e file creati/preservati.

Prima del lavoro, sostituire il Ledger iniziale con un task bounded reale. Un `TASK_PLAN.md` estraneo, ambiguo o incompatibile non viene sovrascritto.

## Avviare Pi sotto il Runner

Dal target:

```text
eio
```

Oppure:

```text
eio --target F:/dev/un-altro-progetto
```

Il comando risolve e valida il target, crea il Runner con quel repository esplicito, carica soltanto l'estensione Eiopago prevista e apre il normale TUI Pi. Il Runner possiede sessione e trasporto Pi; non esiste fallback implicito al cwd del source Eiopago. Il Runner portable normale espone `read`, `edit`, `write`, `grep`, `find`, `ls` e il built-in Pi `bash`; ogni invocation shell è tracciata come operazione atomica non read-only e deve raggiungere un outcome terminale noto prima del safe point.

Se il target non è inizializzato, l'avvio termina con `REPOSITORY_NOT_INITIALIZED` e indica di eseguire `eio init`.

## Comandi nel TUI

### Stato

```text
/eio status
```

Mostra in forma bounded:

- target repository e worktree;
- branch e HEAD;
- task, revisione Ledger, current item e next item;
- ownership Runner e sessione corrente;
- modello/reasoning effettivi;
- latch, takeover e handoff corrente;
- stato context/Advisor quando disponibile.

Non mostra conversation history, credenziali o secret.

### Handoff con conferma

Prima aggiornare `TASK_PLAN.md`: l'item concluso deve avere stato/evidence corretti e `current_item`, `next_item`, `next_step` devono descrivere il lavoro da riprendere. Poi:

```text
/eio handoff confirm
```

Eiopago attende un safe point, salva gli artifact del target, crea una nuova sessione Pi vuota e verifica repository, Git, Ledger, modello, reasoning e ownership. Solo dopo un Continuity Check positivo chiede il consenso per una singola resume admission.

Accettando la conferma, la nuova sessione riceve il solo contesto minimo autorevole e prosegue dal `current_item`/`next_step` del Ledger. Non occorre conoscere o copiare ID, database, prompt o artifact.

Invii duplicati e conferme duplicate non producono una seconda admission locale. Questo non equivale a dichiarare exactly-once presso il provider.

### Handoff manuale

```text
/eio handoff manual
```

La replacement resta in pausa dopo il Continuity Check. Per autorizzare in seguito:

```text
/eio resume
```

Anche `/eio resume` richiede consenso umano. Non incollare manualmente checkpoint, manifest o chat nel nuovo editor.

### Pause e takeover

I due nomi correnti sono alias:

```text
/eio pause
/eio takeover
```

Entrambi richiedono un safe point e attivano `HUMAN_TAKEOVER`. Il takeover umano ha precedenza assoluta: una conferma handoff pendente non può rilasciarlo e nuovi prompt/provider call restano bloccati.

La alpha non offre un force-resume del takeover. Dopo un takeover, conservare lo stato, terminare il Runner e riconciliare esplicitamente il lavoro prima di qualsiasi cleanup o nuova inizializzazione.

## Cosa viene salvato nel target

```text
<target>/
├── .gitignore
├── TASK_PLAN.md
└── .guardian/
    ├── config.json
    ├── runtime/
    ├── checkpoints/    # creato al primo handoff
    └── manifests/      # creato al primo handoff
```

Da versionare:

- `.guardian/config.json`;
- `TASK_PLAN.md`;
- il blocco Eiopago in `.gitignore`.

Resta locale e ignorato:

- `.guardian/runtime/`;
- `.guardian/checkpoints/`;
- `.guardian/manifests/`;
- `.guardian/test-runs/` e `.guardian/calibration/`.

Checkpoint e manifest descrivono il task target: Git root, branch, HEAD, stato worktree, revisione Ledger, item corrente/successivo, test/decisioni/evidence dichiarati dal Ledger, policy modello e lineage della replacement.

## Cosa non viene trasferito

La replacement non è un clone/fork della chat. Non riceve:

- transcript;
- precedenti messaggi user/assistant;
- summary o compaction della conversazione;
- prompt copiati dalla sessione precedente;
- secret o credenziali.

La continuity usa soltanto la revisione di `TASK_PLAN.md`, checkpoint, Resume Context Manifest, stato Git e i `minimal_reads` dichiarati. La relazione parent della sessione serve a verificare la lineage, non a importare history.

## Troubleshooting: Git dubious ownership / `safe.directory`

Git può rifiutare un worktree reale quando il filesystem non registra ownership, oppure quando l'ownership osservata non consente di considerarlo trusted. In questo caso Eiopago fallisce chiuso con `GIT_SAFE_DIRECTORY_REQUIRED`, mostra il repository esatto e il comando manuale corrispondente; non modifica automaticamente la configurazione Git globale.

Eseguire il comando mostrato soltanto se si riconosce e si considera trusted quello specifico repository. Aggiungere esclusivamente il path esatto, non una directory parent più ampia, e non usare `safe.directory=*`, che disabiliterebbe il controllo per tutti i repository.

## Failure recovery

I controlli safety-critical falliscono chiuso.

- `GIT_STATE_MISMATCH`, `PLAN_REVISION_MISMATCH`, `CHECKPOINT_MISMATCH`, `MANIFEST_MISMATCH`: non confermare e non ritentare alla cieca. Ripristinare o riconciliare esplicitamente Git/Ledger/artifact, quindi avviare un nuovo percorso solo quando lo stato è noto.
- `MODEL_POLICY_MISMATCH` o `REASONING_POLICY_MISMATCH`: selezionare la policy dichiarata nel Ledger/manifest; Eiopago non cambia modello automaticamente.
- `RUNNER_OWNERSHIP_ATTESTATION_FAILED`: non usare una sessione Pi creata fuori dal percorso Runner-owned.
- replacement creation fallita/ambigua: il checkpoint resta conservato, ma Eiopago non crea automaticamente un secondo target. Usare `/eio status` e seguire le istruzioni mostrate.
- `RESUME_DISPATCH_UNKNOWN`: il prompt potrebbe essere stato accettato; il redispatch automatico è vietato. Verificare umanamente la sessione prima di ogni azione.
- `HUMAN_TAKEOVER_ACTIVE`: il takeover prevale; una vecchia conferma non può riprendere il lavoro.

Non cancellare `.guardian/runtime` per aggirare un errore: eliminerebbe lo stato che consente la riconciliazione.

## Procedura manuale di acceptance su fixture esterna

Creare un repository temporaneo, mai un repository di dogfood reale:

```text
mkdir eio-portable-fixture
cd eio-portable-fixture
git init
git config user.email portable@example.invalid
git config user.name "Portable Fixture"
echo portable > app.txt
git add app.txt
git commit -m "initial fixture"
eio init
```

Modificare `TASK_PLAN.md` con due item bounded, per esempio:

1. `ITEM-1`: cambiare `app.txt` in `PORTABLE` e verificarlo;
2. `ITEM-2`: creare `acceptance.txt` senza ripetere `ITEM-1`.

Impostare inizialmente `current_item=ITEM-1`, `next_item=ITEM-2` e `model_policy=null` (oppure una policy Pi esplicita disponibile). Poi:

```text
eio
```

Nel TUI:

```text
/eio status
```

Chiedere a Pi:

```text
Completa soltanto ITEM-1, verifica il risultato e aggiorna TASK_PLAN.md: ITEM-1 DONE con evidence, ITEM-2 IN_PROGRESS, current_item ITEM-2, next_item null e next_step "Create acceptance.txt for ITEM-2; do not repeat ITEM-1.". Non eseguire ITEM-2.
```

Dopo `ITEM-1`, il Ledger deve riportare esplicitamente:

```text
ITEM-1 = DONE
ITEM-2 = IN_PROGRESS
current_item = ITEM-2
next_item = null
next_step = "Create acceptance.txt for ITEM-2; do not repeat ITEM-1."
```

`next_item` rappresenta un futuro item `PLANNED`/`BLOCKED`, non l'item corrente.

Verificare il diff, quindi:

```text
/eio handoff confirm
```

Accettare l'unica conferma mostrata dopo `Continuity passed`. La sessione B deve continuare `ITEM-2`, senza richiedere copie manuali. Infine controllare:

```text
/eio status
```

Atteso: target fixture corretto, sessione replacement Runner-owned, latch rilasciato, handoff `RESUMED`, modello/reasoning invariati, `acceptance.txt` creato e `ITEM-1` non ripetuto.

## Re-init, uninstall e cleanup

`eio init` è re-runnable e preserva config, Ledger, blocco ignore, runtime e artifact esistenti. Path riservati rediretti con symlink/junction o di tipo incompatibile vengono rifiutati.

Rimuovere CLI/link con:

```text
npm unlink --global eiopago
# oppure
npm uninstall --global eiopago
```

Nel target, fermare prima ogni Runner e archiviare gli artifact necessari. Poi, soltanto con stato riconciliato:

1. rimuovere consapevolmente `.guardian/runtime`, `checkpoints` e `manifests`;
2. rimuovere `.guardian/config.json` e la directory se non servono più;
3. rimuovere esattamente il blocco managed Eiopago da `.gitignore`;
4. conservare `TASK_PLAN.md` se è documentazione utile.

Non esiste un comando distruttivo `uninit` nella Portable Alpha.
