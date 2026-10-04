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
} as const;
