# Aiopago Portable Alpha — installazione, avvio e handoff

Aiopago è installato separatamente dal repository su cui lavora. Nel target non copia il proprio source, non aggiunge dipendenze applicative e non modifica `package.json`.

## Prerequisiti

- Node.js **22.19.0 o successivo**;
- Git su `PATH` e un normale Git worktree, inclusi linked worktree;
- `@earendil-works/pi-coding-agent` **0.83.x** accanto all'installazione Aiopago;
- un provider Pi configurato e utilizzabile.

Aiopago verifica i prerequisiti prima di init e launch. Non installa e non aggiorna automaticamente Node, Git o Pi. Se Pi è installato in una posizione non risolvibile, impostare `PI_CODING_AGENT_ROOT` alla directory del package Pi. Un override errato fallisce senza fallback al `node_modules` del target.

## Installazione locale alpha

Dal repository/package Aiopago:

```text
npm link
```

In alternativa:

```text
npm install --global F:/dev/aiopago-m1-p0
```

Per provare esattamente il contenuto impacchettato senza pubblicarlo:

```text
npm pack
npm install --global ./aiopago-0.1.0.tgz
```

La Portable Alpha non viene pubblicata su npm.

## Compatibilità del rename

`aio` è il comando canonico. Il precedente eseguibile `eio` e i comandi TUI `/eio` e `/eiopago` restano alias temporanei deprecati della stessa implementazione; l'eseguibile scrive il solo warning di deprecazione su stderr, senza modificare stdout o exit code. Nuovi script e istruzioni devono usare `aio` e `/aio`.

La variabile canonica della soglia Advisor è `AIOPAGO_CONTEXT_HANDOFF_THRESHOLD_PERCENT`. La precedente `EIO_CONTEXT_HANDOFF_THRESHOLD_PERCENT` è accettata come fallback deprecato; se entrambe sono presenti con valori diversi Aiopago fallisce esplicitamente. Non è mai esistita una famiglia pubblica `EIOPAGO_*`, quindi non viene inventata una migration layer.

Gli stati locali restano nei path brand-neutral `.guardian/`: non esistono directory o database `.eiopago` da spostare. Config `eiopago.repository/1.0.0`, Ledger pre-rename, binding sessione e record calibration pre-rename restano leggibili; nuovi artifact usano identificatori `aiopago.*`. `aio init` non riscrive silenziosamente config, Ledger, runtime o blocchi `.gitignore` legacy già validi.

## Inizializzare un target

Dentro il worktree target:

```text
aio init
```

Oppure da qualsiasi directory:

```text
aio init --target F:/dev/un-altro-progetto
```

Sono accettati anche path nested, path con spazi e linked worktree. Git determina sempre il top-level reale. `aio init`:

1. verifica Node, Git, Pi e target;
2. preserva config e Ledger compatibili;
3. crea solo lo stato Aiopago mancante;
4. aggiunge un blocco delimitato e idempotente a `.gitignore`;
5. stampa root, versioni e file creati/preservati.

Prima del lavoro, sostituire il Ledger iniziale con un task bounded reale. Un `TASK_PLAN.md` estraneo, ambiguo o incompatibile non viene sovrascritto.

### Contratto lifecycle del Ledger

Gli status ammessi, sia per il task sia per gli item, sono soltanto `PLANNED`, `IN_PROGRESS`, `BLOCKED`, `DONE`, `DROPPED` e `SUPERSEDED`; un item futuro usa `PLANNED`, mai `PENDING`. Durante il lavoro normale il task e l'unico item attivo sono `IN_PROGRESS`, `current_item` identifica quell'item e `next_item` identifica un eventuale item futuro `PLANNED`/`BLOCKED`. Se l'item attivo è l'ultimo, `next_item` è `null`.

Per un blocco esterno, impostare task e item a `BLOCKED`, `current_item=null` e `next_item` all'item bloccato. `next_step` deve indicare blocker, condizione di sblocco e item da riprendere. In generale `current_item` è `null` oppure identifica il solo item `IN_PROGRESS` (mai un item `PLANNED`, `BLOCKED` o `DONE`); `next_item` è `null` oppure identifica un item `PLANNED`/`BLOCKED` e deve sempre differire da `current_item`. Aiopago non converte né ripara automaticamente stati invalidi: il validator blocca il flusso finché `TASK_PLAN.md` non viene corretto esplicitamente.

## Workflow umano read-only (0.2-A)

Senza avviare Pi, selezionare un modello o effettuare provider call, la CLI può mostrare il piano autorevole e il limite corrente dell’osservazione runtime:

```text
aio status
aio why
aio next
```

- `aio status` riassume obiettivo e attività del piano e segnala se l’autorità runtime non è verificabile;
- `aio why` spiega il boundary fail-closed corrente;
- `aio next` non suggerisce avvio o retry senza una verifica runtime canonica e non modifica lo stato.

I comandi accettano `--target <path>` e funzionano anche in un repository Git non ancora inizializzato, senza crearvi file. Non migrano né modificano il runtime SQLite e non creano sessioni, checkpoint o manifest.

`TASK_PLAN.md` resta il piano operativo autorevole, ispezionabile e modificabile direttamente. Le superfici read-only sono:

```text
aio plan
aio plan --raw
aio plan --check
aio plan --technical
```

- `aio plan` mostra una vista leggibile del piano e il path dell'artifact autorevole;
- `aio plan --raw` stampa il testo corrente senza validarlo o rigenerarlo, quindi resta utilizzabile anche durante la riparazione di un Ledger invalido;
- `aio plan --check` esegue il validator canonico senza scritture;
- `aio plan --technical` espone ID, revisione, digest e campi lifecycle come escape hatch esperto.

Una modifica manuale diventa la nuova autorità alla lettura successiva. Nessuno di questi comandi corregge, rigenera o sovrascrive `TASK_PLAN.md`.

Portable Alpha 0.1 applica le invarianti runtime nei percorsi live di safe point, handoff, continuity, admission, dispatch e ownership, ma non espone un verifier read-only complessivo riutilizzabile senza ridefinire quel protocollo. 0.2-A non ricostruisce quindi una seconda state machine da SQLite: il reader osserva soltanto presenza, stabilità dei byte e sidecar del runtime e non interpreta row, journal o projection. Un runtime presente, non osservato, concorrente o comunque privo di un risultato canonico produce sempre “richiede attenzione”; stati o condition futuri non possono produrre “pronto”. `next` non suggerisce avvio o retry.

Una projection runtime completa richiede un futuro **Core Observation Port** posseduto dal core e condiviso con i percorsi live. Tale port, così come un control channel read-only posseduto dal Runner, non fa parte di 0.2-A.

Le proposal conversazionali, `aio start`, `aio stop`, Intent Adapter e modalità di autonomia non fanno parte di questo slice.

## Avviare Pi sotto il Runner

Dal target:

```text
aio
```

Oppure:

```text
aio --target F:/dev/un-altro-progetto
```

Il comando risolve e valida il target, crea il Runner con quel repository esplicito, carica soltanto l'estensione Aiopago prevista e apre il normale TUI Pi. Il Runner possiede sessione e trasporto Pi; non esiste fallback implicito al cwd del source Aiopago. Il Runner portable normale espone `read`, `edit`, `write`, `grep`, `find`, `ls` e il built-in Pi `bash`; ogni invocation shell è tracciata come operazione atomica non read-only e deve raggiungere un outcome terminale noto prima del safe point.

Se il target non è inizializzato, l'avvio termina con `REPOSITORY_NOT_INITIALIZED` e indica di eseguire `aio init`.

## Comandi nel TUI

### Stato

```text
/aio status
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
/aio handoff confirm
```

Aiopago attende un safe point, salva gli artifact del target, crea una nuova sessione Pi vuota e verifica repository, Git, Ledger, modello, reasoning e ownership. Solo dopo un Continuity Check positivo chiede il consenso per una singola resume admission.

Accettando la conferma, la nuova sessione riceve il solo contesto minimo autorevole e prosegue dal `current_item`/`next_step` del Ledger. Non occorre conoscere o copiare ID, database, prompt o artifact.

Nel Ledger, `minimal_reads` contiene esclusivamente direttive semantiche bounded per l'agente. Ogni stringa viene conservata letteralmente nel manifest e nel resume prompt: per esempio `AGENTS.md section 18` o `Complete PR #679 diff against its current base` non viene interpretata come path. Aiopago non usa split, regex o test filesystem su queste direttive.

Le dipendenze locali verificabili sono separate in `required_local_paths`. Il campo Ledger è opzionale, backward-compatible, bounded e accetta solo path repo-relative normalizzati con `/`, senza path assoluti o traversal. Il manifest aggiunge sempre `TASK_PLAN.md`; Continuity verifica l'esistenza di questi soli path e fallisce chiuso se ne manca uno. Checkpoint e Resume Context Manifest non dipendono da questo test generico: `ArtifactStore.verify` ne verifica byte, digest, identità e content digest sealed.

Invii duplicati e conferme duplicate non producono una seconda admission locale. Questo non equivale a dichiarare exactly-once presso il provider.

### Handoff manuale

```text
/aio handoff manual
```

La replacement resta in pausa dopo il Continuity Check. Per autorizzare in seguito:

```text
/aio resume
```

Anche `/aio resume` richiede consenso umano. Non incollare manualmente checkpoint, manifest o chat nel nuovo editor.

### Pause e takeover

I due nomi correnti sono alias:

```text
/aio pause
/aio takeover
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
- il blocco Aiopago in `.gitignore`.

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

La continuity usa la revisione autorevole di `TASK_PLAN.md`, checkpoint e Resume Context Manifest sealed, stato Git, ownership Runner e `required_local_paths` espliciti. I `minimal_reads` dichiarati sono direttive semantiche trasmesse all'agente, non dipendenze filesystem. La relazione parent della sessione serve a verificare la lineage, non a importare history.

## Troubleshooting: Git dubious ownership / `safe.directory`

Git può rifiutare un worktree reale quando il filesystem non registra ownership, oppure quando l'ownership osservata non consente di considerarlo trusted. In questo caso Aiopago fallisce chiuso con `GIT_SAFE_DIRECTORY_REQUIRED`, mostra il repository esatto e il comando manuale corrispondente; non modifica automaticamente la configurazione Git globale.

Eseguire il comando mostrato soltanto se si riconosce e si considera trusted quello specifico repository. Aggiungere esclusivamente il path esatto, non una directory parent più ampia, e non usare `safe.directory=*`, che disabiliterebbe il controllo per tutti i repository.

## Failure recovery

I controlli safety-critical falliscono chiuso.

- `GIT_STATE_MISMATCH`, `PLAN_REVISION_MISMATCH`, `CHECKPOINT_MISMATCH`, `MANIFEST_MISMATCH`: non confermare e non ritentare alla cieca. Ripristinare o riconciliare esplicitamente Git/Ledger/artifact, quindi avviare un nuovo percorso solo quando lo stato è noto.
- `MODEL_POLICY_MISMATCH` o `REASONING_POLICY_MISMATCH`: selezionare la policy dichiarata nel Ledger/manifest; Aiopago non cambia modello automaticamente.
- `RUNNER_OWNERSHIP_ATTESTATION_FAILED`: non usare una sessione Pi creata fuori dal percorso Runner-owned.
- `REQUIRED_LOCAL_PATH_MISSING`: correggere la dipendenza locale esplicitamente dichiarata; una direttiva semantica che non corrisponde a un file non produce questo errore.
- replacement creation fallita/ambigua: il checkpoint resta conservato, ma Aiopago non crea automaticamente un secondo target. Usare `/aio status` e seguire le istruzioni mostrate.
- `RESUME_DISPATCH_UNKNOWN`: il prompt potrebbe essere stato accettato; il redispatch automatico è vietato. Verificare umanamente la sessione prima di ogni azione.
- `HUMAN_TAKEOVER_ACTIVE`: il takeover prevale; una vecchia conferma non può riprendere il lavoro.

Un handoff terminale `CONTINUITY_FAILED` senza alcuna authorization, admission o dispatch può essere riconciliato, anche dopo il riavvio del processo, soltanto da una fresh source session history-zero creata e posseduta dal Runner corrente:

```text
/aio handoff recover <handoff-id>
```

Il comando è una volontà umana distinta da `handoff confirm`: verifica digest, identità e provenance degli artifact sealed del failed handoff (inclusi i manifest legacy `1.0.0`, senza migrarli né rieseguirne la vecchia Continuity), verifica il binding storico del failed target, richiede stato durable `NOT_AUTHORIZED` / `NOT_COMMITTED` / `NOT_STARTED`, Ledger e Git invariati, mantiene il latch `ENGAGED`, supersede esplicitamente il vecchio binding e crea dalla fresh source un nuovo handoff `1.1.0` con nuovo target. Il failed target non viene riattivato e il failed handoff resta immutato e terminale come evidence. Solo dopo la nuova Continuity positiva viene chiesta una nuova singola autorizzazione. Stato mancante, `UNKNOWN`, authorization/admission/dispatch già presente, source non fresh/Runner-owned, source già coinvolta in un handoff o binding storico non dimostrabile falliscono chiuso; non esiste retry automatico del vecchio handoff.

Non cancellare `.guardian/runtime` per aggirare un errore: eliminerebbe lo stato che consente la riconciliazione.

## Procedura manuale di acceptance su fixture esterna

Creare un repository temporaneo, mai un repository di dogfood reale:

```text
mkdir aio-portable-fixture
cd aio-portable-fixture
git init
git config user.email portable@example.invalid
git config user.name "Portable Fixture"
echo portable > app.txt
git add app.txt
git commit -m "initial fixture"
aio init
```

Modificare `TASK_PLAN.md` con due item bounded, per esempio:

1. `ITEM-1`: cambiare `app.txt` in `PORTABLE` e verificarlo;
2. `ITEM-2`: creare `acceptance.txt` senza ripetere `ITEM-1`.

Impostare inizialmente `current_item=ITEM-1`, `next_item=ITEM-2` e `model_policy=null` (oppure una policy Pi esplicita disponibile). Poi:

```text
aio
```

Nel TUI:

```text
/aio status
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
/aio handoff confirm
```

Accettare l'unica conferma mostrata dopo `Continuity passed`. La sessione B deve continuare `ITEM-2`, senza richiedere copie manuali. Infine controllare:

```text
/aio status
```

Atteso: target fixture corretto, sessione replacement Runner-owned, latch rilasciato, handoff `RESUMED`, modello/reasoning invariati, `acceptance.txt` creato e `ITEM-1` non ripetuto.

## Re-init, uninstall e cleanup

`aio init` è re-runnable e preserva config, Ledger, blocco ignore, runtime e artifact esistenti. Path riservati rediretti con symlink/junction o di tipo incompatibile vengono rifiutati.

Rimuovere CLI/link con:

```text
npm unlink --global aiopago
# oppure
npm uninstall --global aiopago
```

Nel target, fermare prima ogni Runner e archiviare gli artifact necessari. Poi, soltanto con stato riconciliato:

1. rimuovere consapevolmente `.guardian/runtime`, `checkpoints` e `manifests`;
2. rimuovere `.guardian/config.json` e la directory se non servono più;
3. rimuovere esattamente il blocco managed Aiopago da `.gitignore`;
4. conservare `TASK_PLAN.md` se è documentazione utile.

Non esiste un comando distruttivo `uninit` nella Portable Alpha.
