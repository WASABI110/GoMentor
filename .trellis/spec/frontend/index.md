# Frontend Development Guidelines

> Best practices for frontend development in this project.

---

## Overview

Guidelines for the **Electron renderer process** — React 19 + TypeScript, presentation only. It never touches Node APIs; all OS access goes through the preload bridge (`window.gomentor`) to the main process.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Renderer layout, placement rules, forbidden imports | **Filled** |
| [State Management](./state-management.md) | zustand stores, mirroring main-process state, derived state | **Filled** |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition | To fill during Stage 6 |
| [Hook Guidelines](./hook-guidelines.md) | Custom hooks, IPC subscription patterns | To fill during Stage 6 |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | To fill during Stage 6 |
| [Type Safety](./type-safety.md) | Type patterns, validation | To fill during Stage 6 |

The four unfilled guides are best written from real code rather than invented up front. Stage 6 builds the renderer; fill them from the patterns that actually emerge there. Until then, `directory-structure.md` and `state-management.md` carry the binding rules, and `../backend/quality-guidelines.md` covers the project-wide standards (no `any`, zod at boundaries, typed errors).

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
