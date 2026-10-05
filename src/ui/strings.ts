// Every user-facing string, in one place, so the tone can be reviewed at once (instructions §1 principle 3:
// kind, neutral, never shaming).
import { formatHM } from '../core/time.ts';

export const strings = {
  menubarTitle: (worked: number, base: number | null): string => (base === null ? `⏱ ${formatHM(worked)}` : `⏱ ${formatHM(worked)} / ${formatHM(base)}`),

  tooltipToday(worked: number, limit: number | null, reference: number | null): string {
    if (limit !== null) {
      const left = limit - worked;
      return left > 0
        ? `Today: ${formatHM(worked)} of ${formatHM(limit)} — ${formatHM(left)} left.`
        : `Today: ${formatHM(worked)} — that's today's budget. Friday-you will thank you.`;
    }
    if (reference !== null) return `Today: ${formatHM(worked)} (a ${formatHM(reference)} day is plenty).`;
    return `Today: ${formatHM(worked)}.`;
  },
  tooltipWeek: (week: number, weeklyBudget: number): string => `This week: ${formatHM(week)} of ${formatHM(weeklyBudget)}.`,
  tooltipStretch: (seconds: number | null): string =>
    seconds === null ? 'On a break right now.' : `Current stretch: ${formatHM(seconds)}.`,
  tooltipFriday: 'Friday — your private day. Tracking only.',
  tooltipShabbat: 'Shabbat — tracking only. Shabbat shalom.',
  trackingOnly: 'No valid policy — tracking only.',
  observeMode: 'Observe mode: nothing is enforced yet.',
  promptHistoryTurnsDrift: 'Copilot history: agent-host prompts cannot be matched to their turns (format change?) — prompts are not counted.',
  promptHistoryNothingParsed: 'Copilot history: nothing parsed today (format change?) — prompts are not counted.',
} as const;

/** Plain strings the pages fetch (`GET /api/ui/strings`); pages never hard-code user-facing text. */
export const pageStrings = {
  devBadge: 'DEV',
  loading: 'One moment…',
  loadFailed: "This window couldn't load its content. It will close by itself in a minute — nothing is blocked.",
  close: 'Close',
  fixtureTitle: 'work-balancer — test window',
  fixtureBody: 'A harmless test window. It closes by itself.',
  fixtureMode: 'Mode',
  fixtureSecondsLeft: 'Closes by itself in',
  fixtureTypeHere: 'Type here to check that text entry works',
  fixtureEcho: 'Send to the daemon',
  fixtureEchoed: 'The daemon received',
  fixtureNotInHammerspoon: '(Opened in a browser: closing is up to you.)',
} as const;

