# `prompt-history` fixtures (synthetic)

Synthetic copies of the **shapes** of Copilot's local chat history stores, for the M5 `prompt-history` provider tests.
Every text field is a placeholder (`prompt text N`, `answer placeholder`, …). The only verbatim strings are the
fixed **runner boilerplate markers** that `execute-copilot-session` appends to prompt files (code-generated, never typed
by a human) — the classifier needs them. The format and the rules (C0…C10, A1–A2, V1…V5, VA1) are documented in
[`.github/copilot-history-formats.md`](../../.github/copilot-history-formats.md); the expected result of every record is in
[`expected.json`](./expected.json).

Regenerate with
`scripts/run-node .github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-02-copilot-history/generate-fixtures.ts`
(from the repo root). All records are on day key **2026-01-11** (Sunday, Asia/Jerusalem = UTC+2), 08:00–10:20 UTC.

## Layout — a fake `$HOME`

```
home/.copilot/session-state/<sessionId>/{events.jsonl, workspace.yaml}          ← CLI / agent store
home/Library/Application Support/Code/agentSessionData/<ahId>/session.sql       ← agent-host turn index (SQL, see below)
home/Library/Application Support/Code/User/workspaceStorage/<hash>/{workspace.json, chatSessions/<id>.jsonl}  ← VS Code native
home/Library/Application Support/Code/User/globalStorage/emptyWindowChatSessions/<id>.jsonl
variants/compacted/…/chatSessions/vs…0001.jsonl                                  ← the same session after VS Code compaction
```

`session.sql` is the real schema subset (`session_metadata`, `turns`) as SQL text, so git holds no binary. Tests
materialise it into a temp copy: `new DatabaseSync(<dir>/session.db).exec(readFileSync(<dir>/session.sql, 'utf8'))`.

## What each fixture is and how it should count

| Fixture | Store / client | Content | Expected |
|---|---|---|---|
| `…0001` | CLI, `vscode-agent-host` | Session typed by the owner: 2 prompts with `request_*` turns, an answered `ask_user`, a subagent (`agentId` + `source: agent-<id>`), a same-text retry 2 min later, a `source: system` steering message with empty content, an `ask_user` never completed, and a **torn last line** (no `\n`) | prompts: 2 human, 1 unclassified (retry), 2 automated; answers: 1 human |
| `…0002` | CLI, `vscode-agent-host` | Launched by `execute-copilot-session`: first message has the runner markers + a bare-UUID turn; owner answered an `ask_user`; later a typed message (`request_*` turn) | prompts: 1 automated, 1 human; answers: 1 human |
| `…0003` | CLI, `vscode-agent-host` | Fully automated runner session | prompts: 1 automated |
| `…0004` | CLI, `vscode-agent-host` | Another AHP client (bare-UUID turns), no markers | prompts: 2 automated |
| `…0005` | CLI, `github/cli` | Headless `copilot -p` one-shot | prompts: 1 unclassified |
| `…0006` | CLI, `vscode` | First 13 events of `…0001` **copied with the same event ids and timestamps** (CLI→VS Code continuation), then one new prompt | copied events: skipped (dedupe by event id); new prompt: 1 human (medium confidence, no turn index) |
| `…0007` | CLI, `copilot-intellij` | Runner-launched (markers), `ask_user` via form elicitation `accept` and `cancel`, a later typed message without any turn index | prompts: 1 automated, 1 unclassified (needs `interactive` corroboration); answers: 1 human (accept), 1 unclassified (cancel) |
| `…0008` | CLI, `vscode-agent-host` | Agent-host session whose turn row never appears | prompts: 1 unclassified (after the deferral window) |
| agentSessionData `a…0001` + `default-<base64>` | turn index | `…0001`'s turns (`request_*`; one turn without `event_id`) + a chat-backing db of the same SDK session with **no** turns (`agentHost.chatProviderData`) | readers must **merge** per `sdkSessionId`, not overwrite |
| agentSessionData `a…0002/3/4/8` | turn index | runner (`autoApprove: autoApprove`, `customTitleSource: user`, bare-UUID first turn), AHP client, and an empty index | — |
| VS Code `vs…0001` | native op-log | `kind:0` snapshot with request 1; `kind:1` set; a `questionCarousel` pushed unanswered then re-pushed answered (`isUsed` + `data`, splice `i`); request 2; a system-initiated request; a **retry** (splice `i:1`, same text, new id); a pure truncate (`kind:2` without `v`); an edited resend (splice, new text); `kind:3` delete | prompts: 3 human, 1 automated, 1 unclassified; answers: 1 human |
| VS Code `vs…0002` | native op-log | Old-style runner launch (pre-2026-09-09 phrase), then a human request | prompts: 1 automated, 1 human |
| VS Code `vs…0003` | empty-window store | One human request in the `kind:0` snapshot | prompts: 1 human |
| `variants/compacted/…/vs…0001.jsonl` | native op-log | `vs…0001` rewritten as a single `kind:0` (the file shrinks) | re-reading after the original adds **nothing** |

Totals: prompts 9 human · 9 automated · 5 unclassified · 1 skipped duplicate; answers 4 human · 1 unclassified ·
1 skipped duplicate.
