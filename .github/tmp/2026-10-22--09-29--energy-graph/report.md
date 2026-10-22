# Energy Graph (D-91) — 2026-10-22

**Done:** menu item *Energy Graph* → user window `energy` (`src/effects/product.ts`); model `energyDays()` in
`src/reports/energy.ts` (+ `energy.test.ts`); page `src/ui/pages/energy.{html,ts}` + CSS in `style.css`; menu strings
and page strings in `src/ui/strings.ts`; menu tests updated (`effects.test.ts`, `product.test.ts`).

**Verified:** `scripts/check` — 255 tests + typecheck. Dev daemon on port 47623 over a scratch copy of `data/` (+ ~600
synthetic reports 2025–2026, scratch deleted): bars and grey rows, label thinning (every 28th day on Sundays at full
zoom-out), ⌘-wheel zoom, Shift-wheel move, double-click reset, hover tooltip beside the pointer. Live daemon restarted
(0.9.0), `WorkBalancer.health()` ok.

**Remaining:** owner's look in the real window.

**Follow-ups (owner, same day):** 500 px plot, hover only over the plot, full-width tooltip; one 100 px cell per
value; week separators; end labels centred on lines 1 / 5. Adversarial review: no high; fixes listed in the ledger's
session log. Committed and pushed.

**Choices to confirm with the owner:** a single-value day is a short ±5 px bar; dates thin to 2-day, then 7/14/28…-day
steps aligned to Sundays; tooltip lists reports oldest first; the graph starts at the first report (not `startDay`).
