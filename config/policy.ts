// The owner's policy (ledger R-POL-2). Edit freely: the daemon hot-reloads it; an invalid edit keeps the previous
// policy and shows a menubar warning. All durations are worked minutes unless stated otherwise.
import type { PolicyConfig } from '../src/policy/config.ts';

const H = 60;

const enforcingWorkday = {
  menubar: true, colours: true, dailyBudgetMin: 9 * H, referenceMin: null, enforce: true,
  inactivityDialog: true, breakNudge: true, morningReview: true,
};
const relaxedWorkday = {
  menubar: true, colours: true, dailyBudgetMin: null, referenceMin: 9 * H, enforce: false,
  inactivityDialog: true, breakNudge: true, morningReview: true,
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
  feedbackChoices: ['Too much work', 'Feeling tired', 'Anxious', 'Stuck / frustrated', 'Productive', 'Good day', 'Other'],
  days: {
    sun: enforcingWorkday,
    mon: relaxedWorkday,
    tue: enforcingWorkday,
    wed: relaxedWorkday,
    thu: enforcingWorkday,
    // Private day: tracked, no budget, no morning review.
    fri: { ...relaxedWorkday, referenceMin: null, morningReview: false },
    // Shabbat: tracking only — no colours, no popups at all.
    sat: {
      menubar: true, colours: false, dailyBudgetMin: null, referenceMin: null, enforce: false,
      inactivityDialog: false, breakNudge: false, morningReview: false,
    },
  },
} satisfies PolicyConfig;
