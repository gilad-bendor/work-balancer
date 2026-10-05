// The owner's policy (ledger R-POL-2). Edit freely: the daemon hot-reloads it; an invalid edit keeps the previous
// policy and shows a menubar warning. All durations are worked minutes unless stated otherwise.
import type { PolicyConfig } from '../src/policy/config.ts';

const H = 60;

const enforcingWorkday = {
  menubar: true, colours: true, dailyBudgetMin: 9 * H, referenceMin: null, enforce: true,
  inactivityDialog: true, breakNudge: true, morningReview: true,
};
// Only Sun/Tue/Thu are intrusive at all; the other days show the menubar status and nothing more.
const relaxedWorkday = {
  menubar: true, colours: true, dailyBudgetMin: null, referenceMin: 9 * H, enforce: false,
  inactivityDialog: false, breakNudge: false, morningReview: false,
};

export default {
  weeklyBudgetMin: 44 * H,
  busyGraceMin: 5,
  ladder: { orangeAtFraction: 0.75, warnBeforeMin: 30, countdownBeforeMin: 10 },
  tokensMin: [10, 5, 5],
  bypass: {
    minutes: 30,
    phrase: 'I am choosing to borrow this time from my Friday and my family. I accept the cost, and I will stop as soon as I can.',
  },
  breakNudge: { afterMin: 90, snoozeMin: 15 },
  // No effect (dialog, dim, …) starts within 10 s of typing/mouse input — unless it has waited 2 min already.
  quiet: { afterInputSec: 10, maxDeferSec: 120 },
  // Live gate: dialogs, dims, countdown and block stay OFF on this Mac until you approve enforcement (milestone M10).
  liveEffects: false,
  // Opacity of full-screen effects (block, overlays): 1 = solid; 0.7 lets you read what is behind.
  overlayOpacity: 0.7,
  feedbackChoices: ['Too much work', 'Feeling tired', 'Anxious', 'Stuck / frustrated', 'Productive', 'Good day', 'Other'],
  days: {
    sun: enforcingWorkday,
    mon: relaxedWorkday,
    tue: enforcingWorkday,
    wed: relaxedWorkday,
    thu: enforcingWorkday,
    // Private day: tracked, no budget, no reference colour.
    fri: { ...relaxedWorkday, referenceMin: null },
    // Shabbat: tracking only — no colours, no popups at all.
    sat: {
      menubar: true, colours: false, dailyBudgetMin: null, referenceMin: null, enforce: false,
      inactivityDialog: false, breakNudge: false, morningReview: false,
    },
  },
} satisfies PolicyConfig;
