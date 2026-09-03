# ADR-0024 — Runtime authority deployment profiles

- **Status:** PROPOSED / REQUIRED TO RESOLVE R1-C-01
- **Date:** 2026-09-03
- **Issues:** #30 (0.2-E), #46 (OS-isolated secure profile)
- **Depends on:** ADR-0015
- **Evidence:** R1-M-13 process-capability spike, persistent-authority oracle, seven authority-domain migrations, whole-candidate finding R1-C-01

## 1. Context

Aiopago 0.2-E is a unified human UX slice. Its explicit product scope is shared CLI/TUI projection, progressive presentation, simplified guided handoff and deterministic read-only UX while preserving existing authority/latch/handoff semantics. The 0.2-E design itself states that the slice **does not add authority**.

ADR-0015 already freezes authority by data type at the application level. For example, Guardian SQLite is canonical for runtime control state and only deterministic transition services are compliant writers. The M0 contracts require fail-closed reads, idempotency, append-only evidence and precise transition ownership. They do not claim that an arbitrary hostile process running under the same OS account is cryptographically or DAC-isolated from the underlying SQLite/files.

Fresh independent security review expanded the attacker model. R1-M-13 deliberately allowed a hostile same-user P0 to:

- execute arbitrary JavaScript in a consumer process;
- read and reconstruct installed package bytes;
- patch Node/Pi and create attacker-owned processes;
- directly open or replace project-owned `.guardian` SQLite/files.

Under that stronger attacker, package-private JavaScript, closures, Workers, child processes, current-user DPAPI/Credential Locker/CNG/TPM keys and an ephemeral native capability cannot establish restart-authentic durable authority. The Windows physical oracle proved that a distinct service identity plus protected `%ProgramData%` storage can establish that stronger property.

Whole-candidate closure then found R1-C-01: the normal supported `aio -> GuardianRunner.create({ repository })` path still uses project-owned portable authority, while the protected service remains a `testScope=true` / `scenario.json` oracle. The two evidence halves are not one product runtime.

This ADR resolves the resulting scope/deployment conflict instead of hiding it behind another JavaScript gate.

## 2. Decision proposed

Aiopago should explicitly distinguish **PORTABLE** and **SECURE** runtime-authority deployment profiles.

### D1 — PORTABLE preserves ADR-0015 application-level authority

`PROPOSED`

PORTABLE remains the npm-first/default Aiopago deployment used by the 0.2 sequence.

Its authority model is the ADR-0015 model:

- one application-level source of truth per data category;
- only documented Aiopago transition services are compliant writers;
- stale/revision/schema/digest/race conflicts fail closed;
- public package APIs do not expose privileged runtime mutation capabilities;
- human consent, handoff, takeover, admission and dispatch remain bound to exact application identities and durable state.

PORTABLE does **not** claim isolation from arbitrary malicious code that already executes as the same OS user and deliberately edits Aiopago's project-owned DB/files or reconstructs private package implementation.

That attacker class is classified as **host/account/process compromise relative to the PORTABLE profile**, not as a compliant package consumer.

This is a threat-boundary clarification, not permission for Aiopago code to bypass its own authority APIs.

### D2 — SECURE is a stronger optional deployment profile

`PROPOSED`

SECURE adds the stronger R1-M-13 property:

```text
same-user untrusted P0
        X
        |  cannot mint/read/write canonical runtime authority
        v
OS-isolated privileged authority
```

SECURE requires a distinct OS security boundary, protected persistent state and an authenticated interactive runtime path. It is tracked separately in #46.

SECURE must never silently degrade to PORTABLE while presenting secure claims.

### D3 — 0.2-E acceptance is evaluated under PORTABLE

`PROPOSED`

Issue #30 remains a UX slice and does not acquire a mandatory administrator/service/native deployment requirement.

For 0.2-E:

- shared human projection and CLI/TUI parity are product scope;
- guided handoff/takeover/resume must preserve the existing ADR-0015 authority semantics and all accepted race/idempotency/fail-closed invariants;
- package API confinement and trusted Runner construction remain useful hardening and should be retained where they do not depend on false same-user isolation claims;
- direct same-user project-DB/file tampering is not an 0.2-E acceptance attacker under PORTABLE;
- no SECURE claim may be shown by the normal `aio` runtime.

R1-C-01 therefore becomes a **profile-boundary finding**, not a requirement to convert 0.2-E into a service-based product.

### D4 — R1-M-13 OS-isolated work is preserved as evidence, not discarded

`PROPOSED`

The process-capability PoC, same-user anchor rejection matrix, service-SID persistent-authority oracle and seven protected authority-domain state machines remain valuable evidence for #46.

They must be labelled correctly:

- protected state-machine/oracle evidence: validated where physically tested;
- SECURE production activation: not implemented;
- PORTABLE product authority: application-level, not OS-isolated.

No document may use the protected oracle to claim that the ordinary PORTABLE `aio` process resists malicious same-user direct storage mutation.

### D5 — No generic broker/HAB is introduced to bridge the profiles

`PROPOSED`

A same-user semantic IPC endpoint would create a confused-deputy risk and is not an acceptable shortcut.

SECURE work must independently solve trusted runtime/human-input activation. It may use a service, protected launcher, high-integrity runtime or another OS primitive only after evidence proves the full caller/interactive boundary. It must not become a generic Human Action Broker by accident.

### D6 — Fail-closed profile identity

`PROPOSED`

If profile identity becomes configurable, it must be explicit and observable.

Minimum semantics:

```text
PORTABLE
  authority_security = application-level
  same_user_tamper_resistance = not_claimed

SECURE
  authority_security = os-isolated
  same_user_tamper_resistance = required
  activation_missing/invalid = fail closed
```

A SECURE configuration with missing broker/service/protected state is an error. It must never continue on project SQLite as if secure.

## 3. Why this is preferred to making SECURE mandatory in 0.2-E

Making the R1-M-13 oracle a mandatory 0.2-E runtime would change several product contracts at once:

- npm-only/portable deployment -> privileged platform installation;
- current-user process -> service/high-integrity/native runtime;
- JavaScript package release -> platform binaries/provisioning/signing lifecycle;
- ordinary Pi/TUI attachment -> authenticated cross-identity interactive channel;
- one portable implementation -> platform-specific Windows/Linux/macOS security evidence.

Those changes are materially larger than issue #30 and were explicitly classified by the R1-M-13 feasibility spike as outside a bounded 0.2-E patch.

The stronger profile is worthwhile, but it should be designed and accepted as such rather than smuggled into an interactive UX slice.

## 4. Consequences if accepted

### For PR #31 / 0.2-E

Whole-candidate closure must be rerun with two explicit checks:

1. PORTABLE claims match ADR-0015 and do not imply hostile same-user isolation;
2. dormant/experimental SECURE code and documentation cannot cause the PORTABLE package/UX to claim a security property it does not implement.

The two independent acceptance rounds remain 0/2 until that closure is CLEAN.

### For #46

The R1-M-13 stronger attacker becomes the normative SECURE-profile threat model. #46 owns the missing production activation and cross-platform deployment proof.

### For documentation/UI

Status and technical diagnostics must name the profile/security level if that distinction is user-relevant. A future `SECURE` label is allowed only when an OS-isolated authority is actually active and attested.

### For storage

PORTABLE can continue using project-owned Guardian SQLite under ADR-0015 ownership semantics. SECURE canonical state must live under the protected authority and may project compatibility/read data into the project runtime without reverse authority.

## 5. Explicit non-goals

This ADR does not:

- implement SECURE activation;
- weaken application-level state-machine/race/idempotency rules;
- authorize arbitrary direct DB edits by normal Aiopago components;
- add 0.2-F durable stop/resume;
- add a Human Action Broker;
- make automatic handoff/resume acceptable;
- claim Linux/macOS OS-isolation from Windows evidence;
- make package/private code a cryptographic security boundary.

## 6. Acceptance gate

ADR-0024 may become ACCEPTED only after review confirms all of the following:

- ADR-0015/M0 contracts contain no pre-existing same-user OS-isolation promise contradicted by PORTABLE;
- issue #30 remains within its stated 0.2-E scope;
- every ordinary `aio` security statement is corrected to application-level/PORTABLE where necessary;
- the R1-M-13 protected oracle remains clearly preserved and assigned to #46;
- no SECURE fallback-to-PORTABLE behavior is introduced;
- PR #31 whole-candidate closure is rerun after the documentation/claim cleanup;
- no independent 0.2-E acceptance round is counted by this ADR work.

## 7. Current recommendation

**Accept the two-profile boundary.**

It preserves the original Aiopago product contract, keeps 0.2-E bounded, retains all valuable R1-M-13 security research, and turns the actual missing service/runtime composition into an explicit security-profile feature rather than a hidden blocker inside a UX milestone.
