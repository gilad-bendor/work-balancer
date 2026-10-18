# Timeline component (D-80) — 2026-10-18

## What was done
- `src/timeline/timeline.ts` (pure):
  - `buildSegments`: precedence layers, then a base state; adjacent segments with the same state are merged.
  - `blockedIntervals`: built from `policy.transition`. Tokens and bypasses are subtracted, and each block ends at 04:00 at the latest.
  - `workTimeline`: precedence is Future > Active > Blocked > Inactive. Styles come from the categories module.
- `src/ui/pages/timeline.ts`: a reusable double bar.
  - Upper half: grouped by state, bottom-aligned.
  - Lower half: in time order, top-aligned.
  - Hover: the segment glows (`box-shadow` in the segment's own colour). A tooltip shows the duration, then the time range (lower half only), then the state.
  - An optional budget tick.
- Styles: `config/categories.ts` built-ins. `Active` is new (#2f6fd6, 7 px). Inactive is #000, 3 px; Blocked is #d0302a, 5 px; Future is #a9a69f, 3 px.
- Summary: in "This week", each day row shows a timeline instead of a bar, and a "Whole week" row was added. "Last 4 weeks" keeps its bars.

## Verified
- `scripts/check`: 243 tests and typecheck pass.
- Isolated dev daemon with a copy of last week's data and a fake clock:
  - visual check;
  - hover over both halves;
  - multi-day labels;
  - tooltip hides when the mouse leaves.
- The live daemon was restarted and is healthy. `/api/ui/model?win=summary` returns the timelines.
- Adversarial review: no significant findings.

## Notes / remaining
- Work done during a token or bypass is shown as Active, inside the red Blocked area. So is the busy-grace minute at the moment the block starts. This keeps the Active total equal to worked time.
- If the summary re-renders while you hover (once a minute), a tooltip can stay visible until the mouse moves.
- Colouring Active time by app category (D-67) is not built yet.

## Round 2 (D-81)
- Every state is now 7 px.
- Active time is split by app category (`categoryLayers`). Before this, WhatsApp was invisible because the timeline never read the per-minute `categories`.
- "Last 20 weeks" now shows a timeline per week. Past days come from `history.days()`, which is cached.
- Review: one high finding, fixed. The history pass was quadratic: the report periods were re-scanned for every input run. Benchmark: `scratch/bench-history.ts` (gitignored).
- Weeks before tracking began (before 2026-10-06) show as Inactive (black). A "Not monitored" state would be a small follow-up if wanted.

## Round 3 (D-82)
- "Last 20 weeks" is now newest first.
- Zoom and move work across the whole page:
  - Cmd+scroll zooms and Shift+scroll moves. Both act on one shared window that applies to every timeline and to both halves.
  - Double-clicking a timeline resets the window.
  - The window survives the summary's re-render.
- Verified in a dev browser (see the ledger session log). No adversarial review yet; one is needed before committing.
- Review (round 3): one high finding, fixed. Detached timelines were kept alive by a module-level set; the per-timeline handles are now in a `WeakMap`. Committed on request (D-80…D-82), not pushed.

## Round 4 (D-83)
- Summary: the week rows are labelled `YYYY-MM-DD`, and the Recent reports section is gone.
- Manage Reports uses compact rows: icons for the part of the day and for each status, energy as 5 stars (with half stars), and ✏️ / 🗑️ / ↩️ icon buttons. Stub days are compact rows too. The edit, add-for-day and skip forms are unchanged.
- Verified in a dev browser; 246 tests pass. Not committed yet; an adversarial review is needed before the commit.
- Round 4b: rows condensed to one line (`timestamp icon - tags` · text · `stars ✏️ 🗑️`), with columns aligned through a subgrid.
- Round 4c: report form (all forms): one heading line "How are you doing? (pick any that fit)", icons in the status chips, and a star preview after the energy buttons.
- Round 4d: stub rows use the same ✏️ (add) / 🗑️ (skip) icon buttons as report rows, in the same column.
- Round 4e: preview of 10-07 without a report (dev copy only); D-84: stubDays changed from 10 to 100.
- Round 4f: D-84 reshaped. Manage Reports lists every day without a report since startDay; stubDays (10) still drives the counts.
- Round 4g: stub row shows only the date, on #F0F0F0; the intro line and the Not now button are gone.
- Round 4h: a darker separator line between days.
- Round 4i: lighter grey stars. Review: one medium finding, fixed — the star preview in a stub's add form had been hidden. Committed on request (D-83/D-84), not pushed.
- Round 5: custom SVG part-of-day icons (day-icons.ts) replace the emoji. Review clean; committed and pushed on request.
