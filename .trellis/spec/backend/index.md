# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

Guidelines for the **Electron main process** and the two shared packages (`packages/shared`, `packages/core`). There is no server — this is a local-first desktop app, and main plays the backend role as the sole holder of OS authority.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Main-process layout, workspace dependency rules | **Filled** |
| [Error Handling](./error-handling.md) | Typed error codes, state-not-exception, IPC error envelope | **Filled** |
| [Quality Guidelines](./quality-guidelines.md) | Forbidden patterns, testing requirements, review checklist | **Filled** |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, levels, what must never be logged | **Filled** |
| [Database Guidelines](./database-guidelines.md) | SQLite patterns, migrations | Deferred to M2 (no DB in M1) |

`database-guidelines.md` is intentionally unfilled: M1 has no persistence layer (the library store is in-memory) so that `better-sqlite3`'s native-rebuild risk stays out of M1's toolchain bring-up. Fill it when M2 introduces SQLite.

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.
