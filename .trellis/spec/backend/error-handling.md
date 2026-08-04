# Error Handling

> How errors are handled in this project.

---

## Overview

Two principles drive everything below.

**1. Expected absence is a state, not an error.** KataGo not being installed, an LLM key not being configured, Fox sync being unreachable — these are normal conditions with a UI representation, not exceptions. Modelling them as errors is what produces apps that crash instead of degrading.

**2. Errors are typed and carry a discriminant.** A thrown string cannot be handled differently by the caller, cannot be translated for the user, and cannot be asserted on in a test. Every error crossing a boundary has a `code`.

---

## Error Types

A single `AppError` base with a discriminating `code`, defined in `packages/shared`:

```
AppError { code: string, message: string, cause?: unknown, context?: Record<string, unknown> }
```

Domain code families:

| Prefix | Domain | Examples |
|---|---|---|
| `SGF_` | SGF parsing | `SGF_TRUNCATED`, `SGF_EMPTY`, `SGF_NOT_SGF`, `SGF_INVALID_PROPERTY` |
| `ENGINE_` | KataGo | `ENGINE_NOT_FOUND`, `ENGINE_START_TIMEOUT`, `ENGINE_CRASHED`, `ENGINE_CIRCUIT_OPEN` |
| `LLM_` | provider | `LLM_NO_KEY`, `LLM_UNAUTHORIZED`, `LLM_RATE_LIMITED`, `LLM_TIMEOUT`, `LLM_ABORTED`, `LLM_NO_TOOL_SUPPORT` |
| `IPC_` | contract | `IPC_INVALID_REQUEST`, `IPC_INVALID_RESPONSE` |
| `SETTINGS_` | config | `SETTINGS_INVALID`, `SETTINGS_ENCRYPTION_UNAVAILABLE` |
| `SOURCE_` | integrations | `SOURCE_UNREACHABLE`, `SOURCE_AUTH_EXPIRED`, `SOURCE_SCHEMA_CHANGED` |

`SGF_TRUNCATED`, `SGF_EMPTY`, and `SGF_NOT_SGF` are **distinct** codes deliberately — the user-facing message differs for each, and tests assert on the specific code.

---

## Error Handling Patterns

**Parsers return typed errors and never hang.** Malformed input must fail fast with a distinct code. A parser that loops forever on a truncated file freezes the import flow with no recovery path — tests assert termination under a timeout, not just correctness.

**Child processes fail into a state machine, not an exception.** KataGo lifecycle is `unavailable | downloading | starting | ready | failed`. An unexpected exit triggers exponential-backoff restart with a **circuit breaker after 3 consecutive failures** (`ENGINE_CIRCUIT_OPEN`). Restarting forever against a broken GPU driver burns the user's machine.

**Cancellation is not failure.** `LLM_ABORTED` from an `AbortSignal` is an expected outcome of the user hitting cancel. Log it at `debug`, never surface it as an error toast.

**Integrations are allowed to be defensive.** `integrations/fox/` wraps an API we do not own. Failures surface as a per-source status, never a crash, and never block a core flow.

**Capability gaps degrade, they don't throw.** If `probeCapabilities` finds a local model without tool support, record it and switch to a no-tools prompt strategy. Failing at the first tool dispatch would be a worse outcome than a slightly weaker answer.

---

## Errors across the IPC boundary

Errors do not cross IPC as exceptions — `ipc/register.ts` maps every throw to a typed envelope:

```
{ ok: false, error: { code, message, context? } }
```

Rules:

- **Never send `cause` or a stack trace to the renderer.** Stacks can contain filesystem paths and, worse, argument values. Log them in main; send the `code`.
- The renderer translates `code` → localised message via the `errors` i18n namespace. It must never display a raw `message` from main as primary UI text.
- Request validation failures produce `IPC_INVALID_REQUEST` **always**. Response validation runs in dev builds only — fail loud in dev, fast in prod.

---

## Logging errors

- `error` — unexpected, actionable. Include `code`, `context`, and `cause`
- `warn` — expected-but-notable degradation (engine restart, source unreachable, tool support absent)
- `debug` — expected outcomes (`LLM_ABORTED`), plus KataGo stderr, which is chatty

**Never log a secret.** The logger's redaction serializer strips key-shaped fields and values, but do not rely on it — don't put a key in a log call in the first place. Never log SGF content, chat text, or prompts: this app handles private study material.

---

## Common Mistakes

**Modelling absence as an exception.** KataGo missing, no API key configured, no games imported — all states with a UI. Throwing here is how you get an app that won't open.

**Swallowing errors.** `catch {}` with no log and no state change makes the failure invisible and the bug unfindable. If it is genuinely ignorable, log at `debug` and say why.

**Throwing bare strings or `Error` without a code.** The caller can't branch, the UI can't translate, the test can't assert.

**Letting a stack trace reach the renderer.** It leaks paths and argument values into a process with weaker guarantees.

**Retrying what shouldn't be retried.** The local LLM gets **zero retries** — a 4090 loading a large model legitimately takes a minute on first token, and retrying multiplies GPU load. Cloud gets 2. Never retry a `4xx` other than `429`.

**Treating a redaction serializer as permission to log secrets.** It's a backstop, not a license.

**Falling back to plaintext when encryption is unavailable.** If `safeStorage.isEncryptionAvailable()` is false, **refuse to persist** (`SETTINGS_ENCRYPTION_UNAVAILABLE`) and hold in memory for the session with an explicit UI warning. A silent plaintext fallback is a security downgrade the user never agreed to.
