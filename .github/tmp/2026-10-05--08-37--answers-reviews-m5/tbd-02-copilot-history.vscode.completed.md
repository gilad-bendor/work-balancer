# tbd-02 — investigate Copilot local chat history formats (work-balancer M5, ⟂ investigation)

Read `.github/copilot-instructions.md` and `.github/ledger.md` first (ledger R-INFO-4, §3 M5, facts F-COP-1..5).

Your tmp-folder is `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-02-copilot-history/` (create it; throwaway
artefacts in its `scratch/` sub-folder, which is gitignored).

Write your final report to `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-02-copilot-history/report.md`, ending
with a `## Ledger delta` section (exact proposed ledger changes). **Do not edit `.github/ledger.md` yourself** — the
launching session applies the delta.

## Goal

Produce the knowledge the `prompt-history` provider (M5) needs: how to find **human** interactions (prompts the owner
typed, and the owner's answers to agent questions) with their timestamps, incrementally and cheaply, in both local
stores — and how to tell them apart from automated/agent/subagent traffic.

## PRIVACY — hard rule

You will read real chat history. **Never copy prompt text, answer text or Copilot output into any file** (not the
topic file, not the report, not fixtures, not scratch). Report only structure, field names, counts, timestamps, sizes,
and *redacted* shapes (e.g. `"content": "<redacted 812 chars>"`). Paths and session ids are fine.

## Questions to answer (with evidence: counts, example session ids, field paths)

1. **Stores.** Confirm/extend F-COP-1..5: `~/.copilot/session-state/<id>/{events.jsonl,workspace.yaml}` and VS Code's
   `~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/*.jsonl` +
   `…/globalStorage/emptyWindowChatSessions/*.jsonl`. Also check VS Code **Insiders** paths, and any other store the
   owner's current mode (VS Code sessions via the agent host, `client_name: vscode-agent-host`) writes to. For a VS Code
   agent-host session, is the same human prompt recorded in both stores (double counting risk)? How to de-duplicate?
2. **Human vs automated**, per store, deterministically where possible:
   - sessions launched by `scripts/execute-copilot-session` (its prompt file is the first user message; look for any
     field/marker that identifies such launches — e.g. `delivery`, `source`, an outcome-protocol text pattern you can
     describe without quoting, title, `workspace.yaml` fields);
   - subagent traffic (`parentAgentTaskId` or similar);
   - answers to `ask_user` (F-COP-2) — how they appear in each store, their timestamps;
   - anything else non-human (system/hook messages, retries by `copilot-retry-watcher` clicking "Try again").
   **Ground truth you can use:** session `f27a4f21-46a8-44aa-a677-4dc05cff758c` (a VS Code agent-host session: the owner
   typed its prompts and answered several `ask_user` questions); `f12c492e-6075-4621-b7c1-cd750a8da680` (launched by
   `execute-copilot-session`: first user message automated, the second one was typed by the owner);
   `9cb9f192-882c-4895-9216-f7fc9e8ee96c` (launched by `execute-copilot-session`, fully automated).
3. **Timestamps:** which field gives the moment the owner submitted the prompt / answer (ISO vs epoch, time zone).
4. **Growth & incremental reading:** file sizes, append-only or rewritten, rotation/compaction, how many files change
   per day, cost of scanning by mtime every ~30 s; whether byte cursors are safe (truncation, rewrite, op-log `kind:0`
   snapshots in VS Code files).
5. **Volume today/this week:** counts of human prompts and answers per store (numbers only), to sanity-check a filter.

## Exact scope (files you may create/modify — nothing else)

- `.github/copilot-history-formats.md` — the topic file (start with a one-paragraph "when to read me"; structured:
  stores, record shapes (redacted), human-vs-automated rules with confidence, timestamps, incremental-reading advice,
  open risks). Register nothing yourself; the parent registers it in the instructions' topic index.
- `test-fixtures/prompt-history/` — small **synthetic** fixtures mirroring the real shapes of each store (a human session,
  an `execute-copilot-session` session with a later human message, a subagent exchange, an `ask_user` answer, a VS Code
  op-log file with `kind:0/1/2` lines). All text fields must be obvious placeholders (e.g. `"prompt text 1"`).
  Add a `README.md` there describing each fixture and what it should count as.
- Your tmp-folder.

Do not touch `src/`, `hammerspoon/`, `config/`, `data/`, `var/`, the ledger, or the instructions. Don't commit.

## Acceptance criteria

- Each question above answered with evidence, or explicitly marked unknown with what would settle it.
- A proposed classification algorithm (per store) with an honest confidence level, including the `unclassified` bucket
  for undecidable cases (ledger M5).
- Fixtures cover every rule of the algorithm; no real text anywhere (grep your outputs for long natural-language strings
  before finishing).
