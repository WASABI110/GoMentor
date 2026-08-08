# Logging Guidelines

> How logging is done in this project.

---

## Overview

**`electron-log`**, wrapped in `main/logger.ts`. Never import `electron-log` directly — the wrapper is what enforces structure and runs the secret-redaction serializer.

File + console transports with rotation. Renderer logs forward to main over IPC so there is one log stream, not two.

A **"Reveal logs"** menu item ships from M1. It is the single highest-value support affordance: it turns "the app is broken" into a file a user can attach.

---

## Log Levels

| Level | Use for | Examples |
|---|---|---|
| `error` | Unexpected and actionable | engine crashed unrecoverably, settings file corrupt, unhandled rejection |
| `warn` | Expected but notable degradation | engine restarting, Fox source unreachable, model lacks tool support, encryption unavailable |
| `info` | Significant lifecycle events | app start/quit, engine ready with backend + measured visits/s, provider connected, N games imported |
| `debug` | Diagnostic detail | IPC channel invocations, KataGo stderr, `LLM_ABORTED`, cache hits |

Two calibrations that matter here:

- **KataGo stderr is `debug`.** The engine is extremely chatty; at `info` it drowns the log.
- **Cancellation is `debug`, not `warn`.** `LLM_ABORTED` from a user pressing cancel is a successful outcome.

`debug` is off by default in production builds, toggleable in settings so a user can produce a useful log without a rebuild.

---

## Structured Logging

Every entry carries:

```
{ level, ts, scope, msg, ...fields }
```

- `scope` — the module, matching its path (`main:katago:process`, `main:llm:service`, `renderer:board`). Makes grep-by-subsystem work.
- `msg` — a **stable, non-interpolated** string. Put variables in `fields`, not in `msg`.

```
// Wrong — unstable message, ungreppable
log.info(`Engine started with ${backend} at ${visits} visits/s`)

// Right
log.info('engine started', { backend, visitsPerSecond: visits })
```

Errors are logged with `code` and `context` (see `error-handling.md`), and with `cause` in main only.

---

## What to Log

- App lifecycle: start (with version, platform, arch), quit, single-instance rejection
- Engine: backend detection results **including the losing candidates and why**, start/ready with measured throughput, restarts with attempt count, circuit-breaker trips
- LLM: provider connect, resolved `baseUrl` **host only**, model id, capability-probe result, per-run token counts and duration
- Library: import counts, dedupe hits, watcher events (`debug`)
- IPC: channel name and duration at `debug`; validation failures at `warn` with the channel and the zod issue path
- Settings: load, migration applied, encryption availability

Backend detection is worth logging in full because "why is analysis slow" is answered by seeing which backends were probed and which failed.

---

## What NOT to Log

**Never, under any level:**

- **API keys or any secret.** Not even redacted-looking prefixes.
- **SGF content or game records.** A user's private study material.
- **Chat text, prompts, or LLM completions.** Same reason, plus prompts can contain pasted game context.
- **Full LLM `baseUrl` with credentials.** Log the host, never userinfo or query params.
- **Filesystem paths containing a username**, when the path itself is the point — prefer a path relative to a known root.
- **Stack traces sent to the renderer.** Log them in main; the renderer gets a `code`.

The redaction serializer strips key-shaped fields and values as a **backstop**. Do not treat it as permission — the rule is not to pass these values to a log call at all.

**Error messages are log payloads.** The rule above is easy to read as being about log call sites, but the leak path that actually occurs has no log call anywhere near it. An error message is built from raw input, that error becomes another error's `cause`, and `cause` is logged in main (line 54) — so a file that makes no log call at all can still put forbidden content in the log. `AppError.toEnvelope()` does not help here: it protects the *renderer* by stripping `cause`, and the main-process log is exactly where `cause` survives.

So: **any error message interpolating a value that came from a file, a prompt, or a network response must bound that value at the point it is built** — not at the point it is logged, because the author of the log call cannot see what the message contains. `sgf/diagnostic.ts` and `board/coords.ts` both implement this; the pattern is to quote short values (the diagnostic is the point) and replace long ones with their length (the length is the anomaly). Reviewing a message for this means asking where its interpolated values came from, not whether the file logs.

This is not generic caution. This app holds a user's LLM credentials and their private game study; a log file that leaks either is a real harm, and log files get attached to bug reports and pasted into chats.

---

## Telemetry

Separate from logging, and **opt-in with default off**. Until consent, `telemetry.ts` is a no-op that makes **no network call whatsoever**.

When enabled: crashes only. Never gameplay content, SGF, chat text, or prompts. Content telemetry is permanently off the table for this project.
