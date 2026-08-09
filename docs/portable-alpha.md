# Eiopago Portable Alpha — installazione, init e layout

Questa guida descrive **M1-P0-A**. Eiopago rimane un prodotto separato dal repository su cui lavora: `eio init` non copia il source di Eiopago, non installa dipendenze nel target e non modifica file applicativi.

## Prerequisiti supportati

- Node.js **22.19.0 o successivo** (`node:sqlite` è richiesto);
- Git disponibile su `PATH` e un normale Git worktree, inclusi i linked worktree;
- `@earendil-works/pi-coding-agent` **0.83.x**;
- una configurazione Pi/provider utilizzabile per l'avvio interattivo.

Eiopago rileva questi prerequisiti e fallisce prima del bootstrap se mancano. Non aggiorna e non installa automaticamente Node, Git o Pi. Pi viene risolto accanto all'installazione Eiopago (nested/hoisted o installazione globale), non dal `node_modules` arbitrario del repository target. Per una installazione Pi non risolvibile automaticamente si può impostare `PI_CODING_AGENT_ROOT` alla directory del package `@earendil-works/pi-coding-agent`; l'override è autorevole e un path errato fallisce chiuso senza fallback.

## Installazione locale alpha

Il metodo preferito per l'alpha personale è il linking npm standard, eseguito nel repository Eiopago:

```text
cd F:/dev/eiopago-m1-p0
npm link
```

Questo registra il bin `eio` senza copiare Eiopago nei repository target. In alternativa è possibile installare globalmente dal path locale:

```text
npm install --global F:/dev/eiopago-m1-p0
```

Non è richiesta né prevista in P0-A una pubblicazione npm pubblica. Il package dichiara un vero `bin`, l'entrypoint ESM e il peer Pi supportato; `npm pack --dry-run` consente di ispezionare il contenuto del package.

## Root contract

Le root non vengono più dedotte come se fossero una sola directory:

- **installation root**: directory del package Eiopago; contiene `bin/` e `src/`;
- **target root**: top-level reale restituito da Git per il worktree selezionato;
- **config root**: `<target>/.guardian`;
- **runtime root**: `<target>/.guardian/runtime`, separata dal config persistente;
- **artifact root**: `<target>/.guardian`, con artifact sealed nelle sottodirectory `checkpoints/` e `manifests/` quando un handoff le crea.

Tutte sono risolte e passate esplicitamente al Runner. Un path nested viene ricondotto al relativo top-level Git. Path con spazi e linked worktree sono supportati; il design usa API Node/Git portabili e non richiede una lettera drive Windows.

## Inizializzazione

Dentro una qualsiasi directory del worktree:

```text
eio init
```

Oppure indicando il target:

```text
eio init F:/dev/un-altro-progetto
eio init --target "F:/dev/progetto con spazi"
```

`eio init`:

1. verifica Node, Git, Pi e il worktree target;
2. valida prima qualsiasi config o `TASK_PLAN.md` preesistente;
3. crea solo gli elementi Eiopago mancanti;
4. aggiunge a `.gitignore` un solo blocco delimitato e idempotente;
5. stampa root, versioni e liste `Created`, `Updated`, `Preserved`.

Terminato init, rivedere il Ledger e poi avviare:

```text
eio
# oppure
eio --target F:/dev/un-altro-progetto
```

Il normale entrypoint avvia Pi con l'estensione Eiopago inline. Non scrive configurazioni extension in `.pi`, non modifica la configurazione Pi globale e disabilita il caricamento accidentale di altre extension/skill/prompt template nel Runner. Il completo launcher acceptance/dogfood multi-repository appartiene a P0-B.

## Layout creato

```text
<target>/
├── .gitignore
├── TASK_PLAN.md
└── .guardian/
    ├── config.json
    └── runtime/
```

Config iniziale:

```json
{
  "schema_version": "eiopago.repository/1.0.0",
  "task_ledger": "TASK_PLAN.md",
  "runtime_root": ".guardian/runtime",
  "artifact_root": ".guardian"
}
```

La config non contiene root assolute ricavabili da Git, secret, credenziali o conversation history.

### File da versionare

- `.guardian/config.json` — piccolo contratto repository Eiopago;
- `TASK_PLAN.md` — Ledger canonico;
- `.gitignore` — se il blocco è stato creato o aggiunto.

### Stato locale ignorato

- `.guardian/runtime/` — SQLite, WAL e stato operativo;
- `.guardian/checkpoints/` — checkpoint sealed locali;
- `.guardian/manifests/` — Resume Context Manifest locali;
- `.guardian/test-runs/` e `.guardian/calibration/` — aree locali già riservate.

Il blocco `.gitignore` contiene eccezioni esplicite per rendere versionabili config e Ledger anche se una regola precedente ignorava `.guardian/`. Il contenuto preesistente non viene sostituito. Se esiste un blocco managed parziale o alterato, init fallisce chiuso e richiede una revisione umana.

## Policy per `TASK_PLAN.md`

- assente: viene creato un template Ledger `0.1.0` minimo e valido;
- Ledger Eiopago valido: viene preservato byte-per-byte;
- file non riconosciuto, JSON invalido o schema incompatibile: `TASK_PLAN_NOT_EIOPAGO_LEDGER`, senza sovrascrittura e prima di creare stato Eiopago.

Il template è intenzionalmente generico: prima di un task reale occorre sostituire objective, criteri e item con un piano bounded. Non contiene conversation history.

## Re-init e safety

`eio init` è re-runnable. Config, Ledger, blocco ignore e runtime esistenti vengono preservati; database, artifact e file sconosciuti sotto `.guardian` non vengono cancellati. Una directory `.guardian` parziale viene completata soltanto con gli elementi mancanti. Path Eiopago riservati che sono symlink/junction o hanno un tipo incompatibile vengono rifiutati prima di scrivere, così config, runtime e artifact non possono essere rediretti fuori dal target.

Init modifica al massimo i file infrastrutturali dichiarati sopra. Non modifica `package.json`, source, test o altri file applicativi del target.

## Errori comuni

- `TARGET_PATH_NOT_FOUND`: il path non esiste;
- `TARGET_NOT_GIT_WORKTREE`: il path non appartiene a un worktree Git supportato;
- `REPOSITORY_NOT_INITIALIZED`: eseguire prima `eio init` nel target corretto;
- `TASK_PLAN_NOT_EIOPAGO_LEDGER`: decidere esplicitamente come rinominare/migrare il piano esistente; Eiopago non lo sovrascrive;
- `REPOSITORY_CONFIG_*`: config JSON invalida, schema non supportato o path che esce dal target;
- `GITIGNORE_EIO_BLOCK_INVALID`: ripristinare o rimuovere consapevolmente il blocco managed prima del re-init;
- `NODE_VERSION_UNSUPPORTED`, `GIT_UNAVAILABLE`, `PI_UNAVAILABLE`, `PI_VERSION_UNSUPPORTED`: installare/selezionare manualmente una versione supportata.

## Disinstallazione e cleanup manuale

Rimuovere il link/package CLI con uno dei comandi npm appropriati all'installazione:

```text
npm unlink --global eiopago
# oppure
npm uninstall --global eiopago
```

Nel target, prima di eliminare `.guardian`, fermare ogni Runner e conservare gli artifact necessari. La rimozione è intenzionalmente manuale:

1. archiviare o eliminare consapevolmente `.guardian/runtime`, `checkpoints` e `manifests`;
2. rimuovere `.guardian/config.json` e la directory solo se non serve più;
3. rimuovere esattamente il blocco `.gitignore` delimitato dai commenti Eiopago;
4. conservare `TASK_PLAN.md` se è diventato documentazione di progetto; non eliminarlo automaticamente.

Eiopago non offre un comando distruttivo `uninit` in P0-A.
