# R1-M-13 native capability boundary PoC

Status: **bounded process/capability sub-proof passes; production architecture remains blocked**.

This directory is non-production and outside the npm `files` allowlist. It proves only that a native P1 can generate a non-derivable capability after process entry, transfer it to one P2 over inherited anonymous pipes, and enforce one fixed semantic sentinel mutation while readable/copied/transformed P2 JavaScript has no broker authority.

It intentionally does **not** modify takeover, GuardianStorage, Pi, the production bins, or package output. Generated binaries and state belong in a temporary directory and must not be committed.

## Process graph

```text
P0 hostile Node/test harness
  -> P1 CGO-free Go executable
       - verifies the fixed P2 source digest
       - chooses a build-bound Node executable independent of P0 process.execPath
       - creates 256-bit CAP_priv using crypto/rand
       - creates anonymous stdin/stdout protocol pipes
       - retains mutation validation and record MAC authority
       -> P2 readable Node test runtime
```

Observed Windows x64 run:

- `P0=8604`, `P1=16340`, `P2=23212`;
- `P0 != P1`, `P1 != P2`, and P2's parent was P1;
- one `POC_OPERATION_TERMINAL / OP-POC-AUTHORIZED` sentinel was accepted;
- attacker-valid mutation count was zero;
- duplicate creation count was zero;
- changed-payload request-ID replay and a fake capability were rejected;
- a P0 direct rewrite retaining the genuine record MAC was detected and rejected by the live broker;
- P2 exited and both private protocol endpoints closed.

PIDs are evidence from one run, not stable values.

## Protocol

Every newline-bounded JSON frame has exactly:

- `version`;
- `requestId`;
- `operationType`;
- optional `capability` on the private P1/P2 channel;
- bounded object `payload`.

The only PoC operations are `HELLO`, `SESSION_BIND`, `AUTHORIZE_MUTATION`, `MUTATION_RESULT`, and `SHUTDOWN`. P1 accepts only the fixed `POC_OPERATION_TERMINAL` payload and exact repository/task/plan/session/lifecycle fields. There is no eval, source transport, module load, function/method name dispatch, generic journal writer, or arbitrary mutation.

## Build and focused run

The experiment used Go 1.24.6. The repository had no native toolchain installed, so the official toolchain was unpacked only under the OS temporary directory.

Conceptual commands (adapt paths for the host):

```text
gofmt -w poc/r1-m-13-native-capability/broker.go
go vet poc/r1-m-13-native-capability/broker.go
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -buildid= \
  -X main.trustedNode=<absolute trusted node> \
  -X main.trustedP2=<absolute p2-runtime.mjs> \
  -X main.trustedP2SHA256=<sha256>" \
  -o <temp>/aiopago-capability-poc[.exe] \
  poc/r1-m-13-native-capability/broker.go
node poc/r1-m-13-native-capability/poc.test.mjs \
  <temp>/aiopago-capability-poc[.exe] \
  poc/r1-m-13-native-capability/p2-runtime.mjs
```

The focused harness covers absolute import, Worker, copied source, data URL, temporary source, genuine-Pi prototype patch, `process.execPath`, spawn/spawnSync plus CJS/ESM synchronization, env/argv, fake capability, replay, duplicate, direct-state forgery, and cleanup. The separate existing reproducer remains:

```text
node test/reproducers/r1-m-13-activated-source.mjs
```

## Static/cross-build evidence

CGO-free, stripped Go 1.24.6 cross-builds completed from Windows:

| Target | Format | Size |
|---|---|---:|
| windows/amd64 | PE32+ console | 2,516,480 bytes |
| linux/amd64 | statically linked ELF x86-64 | 2,408,596 bytes |
| darwin/arm64 | Mach-O arm64 | 2,296,610 bytes |

Only Windows x64 was executed. Linux and macOS outputs were format/static-build evidence, not runtime claims. Production artifacts would require reproducible release builders, provenance, malware scanning, platform signing/notarization, and runtime IPC/TUI tests.

## Blocking result: durable authenticity

The sentinel MAC is enforceable only while P1 retains the ephemeral capability. P0 can write the same state path directly. During the live experiment P1 detected the forged bytes and restored its authentic record, but after P1 exits a new portable P1 has neither the old capability nor a protected trust anchor and reports:

```text
UNVERIFIABLE_WITHOUT_PERSISTENT_TRUST_ANCHOR
```

A public key stored beside the record is replaceable; a package/static secret is forbidden and extractable; same-user filesystem permissions or same-user credential storage do not distinguish hostile P0. Therefore this PoC does not establish that restart-time Aiopago can distinguish an authentic old SQLite/journal/file mutation from an attacker-forged equivalent.

The minimum unresolved architecture decision is one of:

1. an OS-protected persistent identity/trust anchor with credible Windows/Linux/macOS semantics and no P0 signing oracle;
2. a long-lived protected broker/service that remains the sole acceptance authority; or
3. an explicit reduction of cross-process durable authority semantics (currently incompatible with resume/recovery and not authorized).

Until that decision and interactive channel proof exist, this PoC cannot close R1-M-13.
