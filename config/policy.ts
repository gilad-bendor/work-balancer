// The owner's policy (ledger R-POL-2). Edit freely: the daemon hot-reloads it; an invalid edit keeps the previous
// policy and shows a menubar warning. All durations are worked minutes unless stated otherwise.
import type { PolicyConfig } from '../src/policy/config.ts';

const H = 60;

const officeWorkday = {
  menubar: true, colours: true, dailyBudgetMin: 8.5 * H, referenceMin: null, enforce: true,
  inactivityDialog: true, breakNudge: true, morningReview: true,
};
const homeWorkday = { ...officeWorkday, dailyBudgetMin: 8 * H };
// Occasional personal-day laptop use still counts toward the weekly budget, without automatic interruptions.
const personalDay = {
  menubar: true, colours: false, dailyBudgetMin: null, referenceMin: null, enforce: false,
  inactivityDialog: false, breakNudge: false, morningReview: false,
};

export default {
  reports: {
    // Days without a report (last `stubDays`, from this day on) are asked for — e.g. in the morning welcome.
    startDay: '2026-10-06',
    statuses: ['Too much work', 'Feeling tired', 'Anxious', 'Stuck / frustrated', 'Productive', 'Good day'],
    // Stage by time of day: morning from 04:00, afternoon from 11:00, evening from 14:00. A catch-up report picks a
    // stage instead of a time: it is timed at the middle of that range, or at 23:59 for end-of-workday.
    stages: { afternoonFrom: '11:00', eveningFrom: '14:00', endOfWorkdayAt: '23:59' },
    listMax: 1000,
    stubDays: 10,
  },
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
  // Live gate: dialogs, dims, nudges, countdown and block run on this Mac (approved by you 2026-10-05, M10).
  // false = observe mode again (menubar only) — takes effect on save.
  liveEffects: true,
  // Opacity of full-screen effects (block, overlays, inactivity dialog): 1 = solid; 0.8 still lets you read what is behind.
  overlayOpacity: 0.8,
  days: {
    sun: officeWorkday,
    mon: homeWorkday,
    tue: officeWorkday,
    wed: homeWorkday,
    thu: officeWorkday,
    fri: personalDay,
    sat: personalDay,
  },
} satisfies PolicyConfig;
