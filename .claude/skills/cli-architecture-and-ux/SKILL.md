---
name: cli-architecture-and-ux
description: Node.js CLI (ESM) architecture and terminal UX for RING-HUNTER AI — layer separation, configuration, error handling, figlet banner, @inquirer/prompts menus, cli-progress per real stage, ora spinner, cli-table3 tables, no-color fallback, Ctrl+C. Use this skill whenever changing src/cli/, src/index.js, the menu flow, report display, or adding a new module to the project structure.
---

# CLI Architecture & Terminal UX

## Layers (one-way dependencies)
`cli/` → `scanner/` → `adapters/` → `utils/`; `scoring/`, `ai/`, `reports/` only receive normalized data. **The scanner must not import chalk/ora/inquirer**; it calls an `onStage(stageId, status, detail)` callback so it can be tested without a terminal.

## UX rules
1. **Honest progress**: the bar advances only when a stage finishes (or when a real log chunk has been fetched). No fake timers.
2. **AI spinner** only while an AI request is actually running; stop it with `succeed`/`fail`/`warn` based on the result.
3. **Color is never the only signal**: always include text (`HIGH OBSERVED RISK`), not just red. Respect `NO_COLOR` and non-TTY (chalk handles this; don't force a color level).
4. **Width**: summary tables ≤ ~100 columns; shorten addresses to `0x1234…abcd` in tables, show them in full in detail/JSON.
5. **Unavailable features** (e.g. needing an API key) appear as `disabled` in the menu with a reason, never pretending to work.
6. **Ctrl+C**: catch inquirer's `ExitPromptError` and SIGINT → stop progress/spinner, restore the cursor, exit with code 130 without a stack trace.
7. **Non-interactive**: `node src/index.js scan <address> [--json] [--no-ai]` must run without prompts (for scripts/CI).

## Error handling
- Use the classes in `utils/errors.js` (`ConfigError`, `NetworkMismatchError`, `RpcError`, `InputError`, `DataUnavailableError`). User-facing messages are in English + a suggested action.
- Never print a raw error object that might contain a keyed RPC URL; pass it through `redact()`.

## Success criteria
- `npm run check` passes; the menu is navigable; the non-interactive scan produces correct output and exit codes (0 success, 1 error, 2 invalid input, 130 cancelled).
