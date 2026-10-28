# Unlimited

A weeks-long autonomous agent orchestrator for macOS. You define a project, a trusted
"limit-proof" provider, and the rules — Unlimited keeps a crew of agents working on it
while you are away, with a supervisor copy that watches everything and can kill any
agent that steps out of line.

## The crew

- **Worker main agent** — runs on your trusted source provider, coordinates everything.
- **Supervisor main agent** — a copy of the worker on the same trusted provider. It
  touches nothing; it watches everything against your goal and forbidden list, warns
  offenders once, and kills them on repeat.
- **Coordinators (max 2)** — spawned by the worker when it feels stretched; they
  decompose and dispatch, they do not write files.
- **Sub-agents (1–25)** — each with its own provider/model/key.
- **Delegate (optional)** — instead of built-in tools, the crew can drive an external
  CLI: OpenCode, Claude Code, Codex, or Kimi Code. Health-checked before start.

## Discipline

- **Time budget**: days (required) + hours/minutes (optional). The remaining time is
  injected into every worker turn; the budget only ticks while the daily work window
  is open.
- **Forbidden list** is pinned into every agent's context and enforced by the supervisor.
- **Compaction engine**: nothing is silently truncated. Tool outputs are elided to their
  kernel, episodes are summarized, a live ledger carries state, and everything evicted
  from context lands on disk behind a searchable `recall` tool.
- **Panic**: one button stops every agent and delegate child, immediately.

## Status

Faz 0 — scaffold and locked contracts. See `src/shared/types.ts` for the data model.
The full phase plan lives in the project board / roadmap notes.

## Develop

```bash
npm install
npm run typecheck
npm start          # build + open the desktop app
npm run smoke      # boots headless, captures a screenshot, exits
```

Profiles and run journals live under `~/.unlimited` (override with `UNLIMITED_HOME`).
Profile files contain API keys and are written `0600`.

## License

MIT
