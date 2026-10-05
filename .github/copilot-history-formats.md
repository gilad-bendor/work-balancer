# Copilot local chat-history formats (for the `prompt-history` provider)

**When to read me:** before touching the `prompt-history` provider (M5) or anything else that reads Copilot's local
chat history. This file covers where the history lives on this Mac, what the records look like (shapes only, never real
text), how to tell the owner's own prompts and answers from automated, agent and subagent traffic, which timestamp to
use, and how to read the files incrementally and cheaply. Everything below was verified on 2026-10-05 by
`tbd-02` (`.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-02-copilot-history/report.md`) unless marked
*inferred*. Synthetic fixtures for every rule: [`test-fixtures/prompt-history/`](../test-fixtures/prompt-history/README.md).

> **Privacy:** these stores hold the owner's real prompts and Copilot's output. Readers may look at text **in memory
> only** (to match the runner markers and to compare retries by hash). Persist counts, timestamps and source kinds —
> never text, not even hashes of it.

---

## 1. Stores

| # | Store | Path | Written by | Use for `prompt-history`? |
|---|---|---|---|---|
| S-CLI | Copilot agent/CLI store | `~/.copilot/session-state/<sessionId>/events.jsonl` (+ `workspace.yaml`) | Every Copilot-agent session: **VS Code agent-host** (`client_name: vscode-agent-host`, the owner's mode since ~2026-09-24), VS Code's older CLI integration (`vscode`), JetBrains (`copilot-intellij`), the terminal / headless `copilot -p` (`github/cli`) | **Yes — primary** |
| S-AH | Agent-host turn index | `~/Library/Application Support/Code/agentSessionData/<ahSessionId>/session.db` (SQLite) | VS Code's agent host, one db per agent-host session (≈ 224 dirs) | **Yes — provenance only** (no text, no timestamps) |
| S-VSC | VS Code native chat | `~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl` and `…/User/globalStorage/emptyWindowChatSessions/<sessionId>.jsonl` | VS Code's built-in local agent (`github.copilot.editsAgent`) | **Yes — secondary** (the owner's main mode until ~2026-09-24; still used occasionally: 4 requests on 2026-10-04, 1 on 2026-10-05) |
| — | VS Code **Insiders** | Same layout under `~/Library/Application Support/Code - Insiders/…` | — | **Not installed** on this Mac (checked). Support it as an optional extra root; `~/.copilot` is shared by both editions. |
| — | Copilot session index | `~/.copilot/session-store.db` (SQLite, FTS) | CLI | **No** — derived index, last written 2026-09-25 (stale). |
| — | Agent-host catalog | `…/Code/User/globalStorage/agent-host.db` (`sessions_v2`, …) | VS Code | **No** — session list only; `registration_source` is `explicit` for UI and runner sessions alike. |
| — | Per-session agent db | `~/.copilot/session-state/<id>/session.db` | the agent | **No** — the agent's `todos` scratch tables. |

**No double counting between S-CLI and S-VSC.** Agent-host sessions do **not** appear in S-VSC: the `work-balancer`
workspace storage has no `chatSessions/` dir at all, although agent-host session `f27a4f21` ran there, and no S-VSC
file mentions that session or its agent-host id. **Duplication inside S-CLI exists:** a session continued in another
client (seen: `github/cli` `2f5531e4` → `vscode` `8880d23c`) is **copied** into a new session dir with the **same
event `id`s and original timestamps**. Dedupe every S-CLI event by its `id`, globally.

### 1.1 Volume and growth (2026-10-05)
- S-CLI: 6 565 session dirs, 1.8 GB; events files up to ~7 MB (the busiest ~5 MB/day). 259 sessions touched in 90 days.
- S-VSC: 1 828 files, 8.9 GB in total; single files up to ~23 MB with ~53 KB average lines (streamed responses).
- `stat` of every `events.jsonl` plus every `chatSessions/*.jsonl` takes **~30 ms** (6 565 + 1 828 files). A 30 s
  mtime poll is cheap. On a normal day only 1–10 files change.

---

## 2. Record shapes (redacted)

### 2.1 S-CLI `events.jsonl` — one JSON event per line, append-only

Top-level keys, **always in this order**, so a line prefix identifies the type without parsing:
`{"type":…, "data":{…}, "id":"<uuid>", "timestamp":"<ISO UTC, ms, Z>", "parentId":"<uuid>|null", "agentId"?:"<uuid>"}`.
The first line is always `session.start`. `agentId` is present only on events of a subagent (`task` tool).

```jsonc
// human or automated prompt (the main agent)
{"type":"user.message","data":{"content":"<redacted N chars>","transformedContent":"<current_datetime>2026-10-04T16:18:55.954+03:00</current_datetime>\n\n<redacted>",
  "attachments":[{"type":"file","path":"…","displayName":"…"}],"messageId":"<uuid>","supportedNativeDocumentMimeTypes":[],
  "delivery":"idle","interactionId":"<uuid>","turnId":"0","parentAgentTaskId":"<uuid>",
  "responsesReasoning"?:{"model":"…","initialEffort":"high","effort":"high"}},"id":"<uuid>","timestamp":"2026-10-04T13:18:55.955Z","parentId":"<uuid>"}
// subagent prompt: top-level agentId + data.source = "agent-<parent sessionId>"
{"type":"user.message","data":{"source":"agent-f27a4f21-…","content":"<redacted>",…},"agentId":"a6204063-…",…}
// system steering message: data.source = "system", delivery = "steering", content = "" (no parentAgentTaskId)
// ask_user — question and answer are a tool call pair, matched by data.toolCallId
{"type":"tool.execution_start","data":{"toolCallId":"toolu_…","toolName":"ask_user","arguments":{…}},…}
{"type":"tool.execution_complete","data":{"toolCallId":"toolu_…","success":true,"result":{"content":"<redacted>"},
  "toolTelemetry":{"properties":{"outcome":"answered","had_choices":true,"was_freeform":false},"restrictedProperties":{"question":"<redacted>","choices":"<redacted>","answer":"<redacted>"}}},…}
// variant (github/cli, form elicitation): toolTelemetry.properties.elicitation_action = "accept" | "cancel"
```

Other types seen (90 days): `session.start|resume|shutdown|model_change|usage_checkpoint|compaction_*|truncation|error|warning`,
`system.message`, `assistant.turn_start|message|turn_end`, `hook.start|end`, `tool.execution_*`, `subagent.started|configured|selected|deselected|completed`,
`permission.requested|completed`, `abort`, `external_tool.*`, `model.*`, `system.notification`. All are ignorable for
counting.

**Correction to the earlier fact F-COP-2:** `parentAgentTaskId` is set on **every** `user.message`, human ones
included (all 201 non-system messages in 45 days), so it does **not** identify subagents. Subagents are identified by
top-level `agentId` / `data.source = "agent-…"`.

`workspace.yaml` is flat `key: value`: `id, cwd, git_root, repository, host_type, branch, client_name, name, user_named,
summary_count, fork_count, created_at, updated_at`. **`name` (and `summary`) hold the first prompt as a YAML block
scalar — it is text; do not log it.** `client_name` is the only field used.

### 2.2 S-AH `agentSessionData/<ahId>/session.db`

```sql
session_metadata(key TEXT PRIMARY KEY, value TEXT)   -- keys used: defaultChatProviderData | agentHost.chatProviderData
                                                    --   = {"sdkSessionId":"<S-CLI sessionId>","model":{…}}
                                                    -- also: configValues {"autoApprove":"default|autoApprove",…}, customTitleSource auto|user
turns(id TEXT PRIMARY KEY, event_id TEXT, checkpoint_ref TEXT)   -- event_id = the S-CLI user.message "id"
```

- **Turn id format = who started the turn.** VS Code's chat UI creates `request_<uuid>`. `execute-copilot-session`
  and any other Agent Host Protocol client create a bare `<uuid>` (the runner uses `crypto.randomUUID()` in
  `chat/turnStarted`, `storm/.github/copilot-tools/execute-copilot-session/harness/vscode.ts`).
- Several dbs can name the **same** `sdkSessionId`. For example `default-<base64("copilotcli:/<ahId>")>` is a
  chat-backing db with `agentHost.chatProviderData` and no turns. **Merge the turns per sdkSessionId**; never let a
  later db overwrite an earlier one.
- Subagent messages have **no** turn row. A UI turn can exist with `event_id = NULL` (seen in `f12c492e`: a turn
  aborted before reaching the agent).
- Runner sessions also have `configValues.autoApprove = "autoApprove"` and `customTitleSource = "user"`. These are
  weaker signals: the owner can choose them too.

### 2.3 S-VSC op-log (`chatSessions/*.jsonl`)

Semantics from VS Code's `src/vs/workbench/contrib/chat/common/model/objectMutationLog.ts`. Each line is
`{"kind":K,"k":[path…],"v":…,"i"?:n}`, keys in that order:

| `kind` | Meaning |
|---|---|
| `0` | Initial — the whole state `v` (valid only as the first line) |
| `1` | Set the value at path `k` |
| `2` | Push at array path `k`: if `i` is present, **truncate the array to length `i` first**; `v` may be absent (pure truncate) |
| `3` | Delete at `k` |

```jsonc
{"kind":0,"v":{"version":3,"creationDate":<epochMs>,"customTitle":"<redacted>","initialLocation":"panel","responderUsername":"…",
  "sessionId":"<uuid>","hasPendingEdits":false,"requests":[<request>…],"pendingRequests":[],"inputState":{…}}}
{"kind":2,"k":["requests"],"v":[<request>]}                       // a new request (prompt)
{"kind":2,"k":["requests"],"v":[<request>],"i":1}                 // splice: retry or edit-and-resend from index 1
{"kind":2,"k":["requests",0,"response"],"v":[<parts>…],"i":79}   // streamed response parts
{"kind":1,"k":["requests",0,"result"],"v":{…}}
// <request>:
{"requestId":"request_<uuid>","timestamp":<epochMs>,"agent":{"id":"github.copilot.editsAgent"},"modelId":"…",
 "hiddenFromTranscript":false,"modeInfo":{"kind":"agent",…},"message":{"text":"<redacted>","parts":[…]},"variableData":{…},
 "response":[…],"isSystemInitiated"?:true,"systemInitiatedLabel"?:"<redacted>","terminalExecutionId"?:"…",
 "confirmation"?:"<redacted>","shouldBeRemovedOnSend"?:{"requestId":"…"}, …}
// answered question (vscode_askQuestions): a response part, re-pushed once answered
{"kind":"questionCarousel","resolveId":"toolu_…","allowSkip":true,"questions":[…],"isUsed":true,
 "data":{"toolu_…:0":{"selectedValue"|"selectedValues"|"freeformValue":"<redacted>"}}}
```

- Observed (45 days): all 1 648 requests have `agent.id = github.copilot.editsAgent` and `modeInfo.kind = agent`.
  86 have `isSystemInitiated: true`, most of them with `terminalExecutionId` (VS Code tells the agent that a
  background terminal finished). 142 splices: 16 re-add the same text under a new id (retries), 126 carry new text
  (edit and resend).
- Compaction: after more than **512** entries, the next write **replaces the whole file** with a single `kind:0` line
  (`op: 'replace'`). Strings over 1 MB inside an entry are truncated with a `[VS Code: value truncated…]` marker.

---

## 3. Human vs automated — the classification algorithm

Classes: **`human`** (counted), **`automated`** (never counted), **`unclassified`** (its own bucket, never counted as
human — ledger M5), **`skip`** (duplicate, ignored). Rules apply in order; the first match wins.

### 3.1 Runner markers (both stores)

`execute-copilot-session` appends fixed boilerplate to the prompt file. Match these on the text **in memory**:
- `WORKING AGREEMENT: These interaction preferences govern this task` (always appended since 2026-09-09);
- `TASK OUTCOME: A success signal means substantive task completion` (since 2026-09-09, when completion is signalled);
- `the very LAST thing you do MUST be to (rename the prompt file|create the file)` (runner versions before 2026-09-09).

These are deterministic for every runner version that has completion signalling. A human pasting a runner prompt by
hand would also be classified as automated, which is acceptable. The older Hammerspoon UI harness typed runner prompts
**into the VS Code UI** (a `request_*` turn with markers: session `c744e9c2`, 2026-09-24), so **markers outrank the turn
format**.

### 3.2 S-CLI `user.message`

| Rule | Condition | Class | Confidence |
|---|---|---|---|
| C0 | event `id` already seen (in any session) | `skip` | high |
| C1 | top-level `agentId` set, **or** `data.source` starts with `agent-` | `automated` (subagent) | high |
| C2 | `data.source` set to anything else (seen: `system`), **or** blank `content` | `automated` (system) | high |
| C3 | content matches a runner marker (§3.1) | `automated` (runner); if it is the session's first main message, mark the session *runner-launched* | high |
| C4 | turn id from S-AH exists and does **not** start with `request_` | `automated` (non-UI client); mark the session if first | high |
| C5 | same content (compare hashes in memory) as the previous main prompt of the same session, < 15 min earlier | `unclassified` (retry: `copilot-retry-watcher` or a manual retry) | medium |
| C6 | turn id starts with `request_` | **`human`** | **high** |
| C7 | `client_name: github/cli` | `automated` *(owner, 2026-10-05, Q-14: launched headless by other processes — ignored)* (mostly headless `copilot -p` calls from the owner's tools — `copilot-llm.ts`: find-topics rerank, confluence rerank, diagnosis-graph rerank, describe-image) | medium |
| C8 | session is *runner-launched* (C3/C4 on its first message) and there is no turn index | `human` only if `interactive` recorded input in the preceding 60 s (configurable), else `unclassified` | medium |
| C9 | `client_name: vscode-agent-host` but no turn row yet | wait up to ~5 min (the row may land after the event — *inferred*, timing not measured), then `unclassified` | — |
| C10 | otherwise (`vscode`, `copilot-intellij`, no turn index, no markers) | **`human`** | medium |

### 3.3 S-CLI answers (`ask_user`)

| Rule | Condition | Class |
|---|---|---|
| A1 | a `tool.execution_complete` paired by `toolCallId` with a `tool.execution_start` whose `toolName == "ask_user"`, and `toolTelemetry.properties.outcome == "answered"` **or** `elicitation_action == "accept"` | **`human` answer** (high), also inside runner-launched sessions |
| A2 | the pair with another outcome (`elicitation_action: "cancel"`, missing outcome) | `unclassified` |
| — | a start without a complete (never answered, or the session ended) | nothing |

C0 applies to answers too: copied sessions duplicate the answer events under the same `id`. No `ask_user` from a
subagent has been seen. If one appears, it is still the owner answering, so count it.

### 3.4 S-VSC requests and answers (dedupe by `requestId` and `resolveId` per file, kept across rewrites)

| Rule | Condition | Class | Confidence |
|---|---|---|---|
| V1 | `isSystemInitiated: true` | `automated` | high |
| V2 | runner marker in `message.text` | `automated` (runner, including the older `code chat` and Hammerspoon harnesses) | high |
| V3 | pushed by a splice (`i` present) with the same text as one of the requests that splice removed | `unclassified` (retry) | medium |
| V4 | blank `message.text` | `automated` | high |
| V5 | otherwise (including `confirmation` requests, which are button clicks in the UI) | **`human`** | high |
| VA1 | a `questionCarousel` part with `isUsed: true` and a non-empty `data`, first time for its `resolveId` | **`human` answer** | high (timestamp: see §4) |

### 3.5 Validation against the ground truth (2026-10-05)

| Session | Truth | Algorithm |
|---|---|---|
| `f27a4f21` (agent-host, owner) | typed prompts + several `ask_user` answers | 3 `human` prompts (C6), 3 `human` answers (A1), 4 `automated` subagent prompts (C1) ✅ |
| `f12c492e` (runner, then owner) | 1st automated, 2nd typed | 1st `automated` (C3 + bare-UUID turn); 2nd and 3rd `human` (C6 — both are `request_*` UI turns; the 3rd, 28 chars, was typed in the UI as well) ✅ |
| `9cb9f192` (runner, unattended) | fully automated | 1 `automated` (C3) ✅ |
| this investigation `50c47427` | runner | `automated` (C3, bare-UUID turn) ✅ |

Over the 20 agent-host sessions of the 45 days before 2026-10-05 (44 main-agent messages, all with a turn row), C3
and C4 agree everywhere except 2 sessions from the day the
native harness was built (2026-09-24): `d6d40a0d` (bare-UUID turns, no markers: harness test launches → C4) and
`c744e9c2` (markers on a UI turn: the old UI-typing harness → C3).

---

## 4. Timestamps

| What | Field | Format | Accuracy |
|---|---|---|---|
| S-CLI prompt submitted | `user.message.timestamp` | ISO-8601 UTC with ms and `Z` | Equal to the host's own `<current_datetime>` stamp in `transformedContent` (±1 ms, verified on 10 messages) → the submit instant |
| S-CLI answer given | `tool.execution_complete.timestamp` of the `ask_user` pair | ISO UTC | The moment the answer reached the agent (seen waits: 6 s – 66 min after the question) |
| S-VSC prompt submitted | `request.timestamp` | epoch ms | Request creation = send time |
| S-VSC answer given | **none in the file** | — | Live: the scan in which the answered carousel first appears (≤ poll interval). Catch-up after a restart: use the containing request's `timestamp` as a **lower bound** and flag it as approximate |

- S-CLI timestamps are **not monotonic** within a file: copied events keep old times, and subagents interleave
  (13 regressions > 1 s in 90 days). Route every record by its own timestamp; never use "last timestamp seen" as a
  cursor.
- *Inferred, unverified:* a message the owner types while the agent is busy (queued, or VS Code `pendingRequests`)
  is probably stamped with its delivery time, not its typing time.

---

## 5. Incremental reading

**Discovery (every ~30 s):** `stat` every `session-state/*/events.jsonl` and every `chatSessions/*.jsonl` (+ the
empty-window dir); process files whose `mtimeMs` or `size` changed since the last poll (~30 ms in total). On startup,
process only files with `mtimeMs >= today's 04:00 day start` (R-INFO-4), and records with timestamp ≥ the day start.

**S-CLI events.jsonl is append-only.** Evidence: 51 of 52 `session.resume` events carry `eventsFileSizeBytes`
exactly equal to the byte offset of their own line, compactions and truncations included. The one mismatch was off by
12 bytes. A per-file **byte cursor** is safe:
- consume only up to the last `\n` (the last line may be torn while it is being written);
- if the size is smaller than the cursor, or the first line no longer starts with `{"type":"session.start"`, re-read
  the file from 0 and rely on event-id dedupe (never observed);
- prefilter by line prefix: only `{"type":"user.message"`, `{"type":"tool.execution_start"` containing
  `"toolName":"ask_user"`, and `{"type":"tool.execution_complete"` carrying a pending `toolCallId` need `JSON.parse`;
- keep per session: pending `ask_user` callIds, *runner-launched* flag, previous-prompt hash and time (in memory),
  `client_name`. Keep globally: the set of seen event ids for the current and previous day.

**S-AH:** the dbs use a **rollback journal, not WAL** (header bytes 18–19 = `01 01` on all 231 dbs, no `-wal`/`-shm`;
review 2026-10-05). Opening them in place — even read-only — holds a SHARED lock that can make VS Code's commit fail
with `SQLITE_BUSY`. So the provider reads a **byte copy** (in `var/<env>/tmp/`) and discards it when a hot `-journal`
exists or the file changed during the copy (retried next poll). Re-read a db only when its mtime changes. Build
`sdkSessionId → Map(event_id → turn id)` by merging all dbs.

**S-VSC is NOT append-only.** VS Code rewrites the whole file when it compacts (after > 512 entries); the file then
shrinks to one `kind:0` line. A byte cursor alone is unsafe:
- keep `{cursor, size, the 64 bytes before the cursor}`. If `size < cursor`, or those bytes changed, re-read from 0;
- keep per file the **known `requestId`s and answered `resolveId`s**, so a re-read or rewrite never re-counts;
- a `kind:0` line may be tens of MB, so parse it fully. For other lines, parse only
  `{"kind":2,"k":["requests"]` pushes and response lines containing `"questionCarousel"`; skip the rest unparsed.
- To recognise retries (V3), keep the per-file array of request-text hashes, in memory only.

**Cost:** steady state is a handful of KB per poll. The full catch-up of today (all changed files from 0, including a
23 MB S-VSC file) takes < 0.5 s.

---

## 6. Volume snapshot (counts only; Asia/Jerusalem days with the 04:00 boundary)

| Window | Human prompts | Human answers | Automated | Unclassified |
|---|---|---|---|---|
| Mon 2026-10-05 04:00 → 08:57 | 2 (S-CLI 1, S-VSC 1) | 0 | 5 (1 runner, 4 subagent) | 0 |
| Sun 2026-10-04 (whole day) | 23 (S-CLI 20: 16 agent-host UI + 3 `vscode` + 1 `intellij`; S-VSC 3) | 12 (S-CLI 10, S-VSC 2) | 4 | 1 (S-VSC retry) |
| Week so far (Sun 04:00 → Mon 08:57) | 25 | 12 | 9 | 1 |
| Previous week 2026-09-27 → 10-04 | 0 | 0 | 0 | 0 (no activity in either store) |
| Week 2026-09-20 → 09-27 (mixed modes) | 142 (S-VSC 107) | 13 | 59 (55 runner) | 52 prompts (46 `github/cli`) + 1 answer |

---

## 7. Open risks

1. **Retries in agent-host mode.** It is unknown what `copilot-retry-watcher`'s "Try Again" click produces there.
   Only one same-text repeat was seen in 45 days, and it came 3 h later (counted as human). The watcher logs its
   clicks only to the Hammerspoon console. If retries become visible, a timestamp hook into that module (owner's
   decision) would settle them.
2. **Turn-row timing (C9).** Not measured whether the S-AH turn row can land after the `user.message`; the deferral
   window covers it.
3. **Permission approvals** (`permission.requested/completed`) never appear in agent-host sessions. Elsewhere they
   are mostly auto-approved within 2 s, so they are not counted as answers.
4. **`github/cli` sessions** (C7) are headless tool calls launched by other processes (owner, Q-14): `automated`. A
   prompt the owner might type in a terminal CLI session would not be counted — he works in VS Code (R-INFO-4).
5. **Format drift.** Field names come from unversioned internals (Copilot agent `copilotVersion: "0.0.0"`; VS Code
   op-log `version: 3`; S-AH schema without a version). Readers must skip unknown shapes, never crash, and surface a
   "prompt-history: no records parsed today" warning when a day's activity suddenly drops to zero.
6. **S-VSC answer timing** is approximate (§4).
7. **Runner marker text** belongs to an external tool (F-ENV-3). If its boilerplate changes, C3/V2 degrade to C4
   (agent-host, still deterministic) or to C10/V5 (the other clients, which would over-count). Re-check the markers
   when the runner changes.
