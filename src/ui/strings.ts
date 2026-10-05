// Every user-facing string, in one place, so the tone can be reviewed at once (instructions §1 principle 3:
// kind, neutral, never shaming).
import { formatHM } from '../core/time.ts';

const clockFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const clockTime = (ms: number): string => clockFmt.format(new Date(ms));

export const strings = {
  /** `grantLeft`: seconds of borrowed time left (a token or the bypass), shown as `⏳7m`. */
  menubarTitle: (worked: number, base: number | null, grantLeft: number | null = null): string =>
    (base === null ? `⏱ ${formatHM(worked)}` : `⏱ ${formatHM(worked)} / ${formatHM(base)}`) + (grantLeft === null ? '' : ` ⏳${Math.ceil(grantLeft / 60)}m`),
  tooltipGrant: (until: number): string => `Borrowed time until ${clockTime(until)} — then the screen rests until 04:00.`,
  tooltipTokens: (left: readonly number[]): string =>
    left.length ? `Postpone tokens left today: ${left.map((m) => `${m} min`).join(', ')}.` : 'No postpone tokens left today.',

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
  /** The menubar menu (D-32, R-UI-MENU-3); ids are effect names, `-` is a separator. */
  menu: [
    { id: 'quick', title: 'Quick note…' },
    { id: 'summary', title: 'Show activity summary' },
    { id: 'notes', title: 'Show status notes' },
    { id: '-', title: '' },
    { id: 'quit', title: 'Quit work-balancer…' },
  ],
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

  // Shared
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  edit: 'Edit',
  dismiss: 'Dismiss',
  undismiss: 'Bring back',
  add: 'Add',
  escUnsaved: 'You have unsaved text — press Esc again to close without saving it.',
  saveFailed: "Couldn't save just now — your text is still here. Try again in a moment.",
  nothingToSave: 'Nothing to save yet — write a line or pick how you feel.',
  kindContext: 'Next step',
  kindFeedback: 'Feedback',
  kindNote: 'Note',
  edited: 'edited',
  // Context-memory (R-UI-CTX)
  contextLabel: "What's the next thing you'd do? It will be waiting for you tomorrow.",
  contextPlaceholder: 'e.g. finish the retry logic in the uploader, then run its tests',
  // Feedback (R-UI-FB)
  feedbackTitle: 'How are you doing?',
  feedbackHint: 'Pick any that fit.',
  feedbackComment: 'Anything else? (optional)',
  energyLabel: 'Energy (optional):',
  energyShort: 'Energy',
  energyLow: 'drained',
  energyHigh: 'full of energy',
  // Quick note
  quickTitle: 'Quick note',
  quickIntro: 'Park the thought — once it is written down, it can wait.',
  quickSaved: 'Saved. It will be waiting for you.',
  // Notes manager
  notesTitle: 'Status notes',
  notesIntro: 'Reminders you left for yourself. Dismiss what is done; dismissed notes stay below, in case you want one back.',
  notesAddPlaceholder: 'A new note…',
  notesWaiting: 'Waiting for you',
  notesDismissed: 'Dismissed',
  notesEmpty: 'No notes waiting.',
  // Morning review (R-UI-REVIEW)
  reviewTitle: 'Good morning.',
  reviewIntro: "Here's what you left for yourself. Edit what changed, dismiss what's done — closing keeps the rest.",
  reviewDone: "Let's start this day!",
  reviewEmpty: 'Nothing waiting — a clean start.',
  // Activity summary (R-UI-MENU-3)
  summaryTitle: 'Activity summary',
  summaryToday: 'Today',
  summaryWeek: 'This week',
  summaryWeeks: 'Last 4 weeks',
  summaryFeedback: 'Recent feedback',
  summaryWorked: 'Worked',
  summaryBudget: "Today's budget",
  summaryLeft: 'Left',
  summaryState: 'State',
  summaryNoBudget: 'no budget today',
  summaryReference: 'reference',
  summaryTokens: 'Postpone tokens left',
  summaryBypasses: 'Emergency bypasses',
  summaryPrompts: 'Prompts / answers',
  summaryTopApps: 'Top apps',
  summaryLongest: 'Longest stretch',
  summaryBreaks: 'Breaks',
  summaryStretch: 'Current stretch',
  summaryOnBreak: 'on a break',
  summaryFirstLast: 'First / last activity',
  summaryUnmonitored: 'Not monitored',
  summaryWeekTotal: 'Week total',
  summaryWeekOf: 'Week of',
  summaryThisWeek: '(this week)',
  summaryTokensBypassesWeek: 'Tokens / bypasses this week',
  summaryNoFeedback: 'No feedback yet.',
  summaryNotesWaiting: 'Notes waiting for you',
  summaryNone: '—',
  levelOk: 'all good',
  levelOrange: 'most of the budget is used',
  levelWarn: 'close to the budget',
  levelCountdown: 'last few minutes',
  levelBlocked: "today's budget is used",
  // Inactivity dialog (R-UI-INACT)
  inactTitle: 'Welcome back.',
  inactIntro: 'No keyboard or mouse for a while. If you were working away from the screen — a meeting, a call, thinking on paper — it can count.',
  inactLastAt: 'Last activity at',
  inactAgo: 'ago',
  inactAway: 'Away since',
  inactBack: 'I am back to work!',
  inactWhole: 'I was working the whole time',
  inactOf: 'of',
  inactWorked: 'Worked',
  inactSubmit: 'Submit',
  inactOtherScreen: 'Please answer on the main screen.',
  inactMin: 'min',
  inactHour: 'h',
  // Quit (R-UI-MENU-3)
  quitTitle: 'Stop work-balancer?',
  quitBody: 'Tracking and the menubar stop until the next login or Hammerspoon reload. The time until then is recorded as not monitored.',
  quitConfirm: 'Stop it',
  quitCancel: 'Keep it running',
  quitBye: 'Stopping…',
  quitRefused: "Not now — today's budget is used up, so stopping is off until 04:00.",
  // Placeholders: {n} {m} {k} {t} are filled in by the page (page.ts `fill`).
  // Warn (R-UI-WARN)
  warnTitle: 'About {n} minutes of work left today.',
  warnBody: 'A good moment to start landing what you are on. When {m} minutes are left, a small countdown appears; at the end of the budget the screen rests until 04:00.',
  warnOk: 'Got it',
  // Countdown (R-UI-COUNTDOWN)
  countdownTitle: '≈ {n} min of work left today.',
  countdownDone: 'That is about it for today.',
  countdownIntro: 'Time to park where you are. Write down the next step — it will be waiting for you tomorrow. Saving ends the day: the screen rests until 04:00.',
  countdownSave: 'Save — done for today',
  countdownSaved: 'Saved. That is today — well done.',
  countdownCmdEnter: 'Saving ends the day — press the button when you are ready.',
  countdownCollapse: 'Make it small',
  countdownExpand: 'Open',
  countdownPill: '≈ {n} min left',
  savedForTomorrow: 'Saved. It will be waiting for you tomorrow.',
  // Block (R-UI-BLOCK)
  blockTitle: "That's today's budget.",
  blockBody: 'Friday-you will thank you. The screen rests until 04:00.',
  blockZeroTitle: "This week's budget is already used.",
  blockZeroBody: 'So today has no budget of its own — that is how Friday and Shabbat stay yours. The screen rests until 04:00. If something truly cannot wait, a postpone token or the emergency bypass is on the next screen.',
  blockZeroContinue: 'I understand',
  blockToday: 'Today',
  blockWeek: 'This week',
  blockOf: 'of',
  blockLifts: 'The screen is yours again at',
  blockPark: 'Park the thought',
  blockMoreTitle: 'Need a few more minutes?',
  blockMoreHint: 'A postpone token lifts the screen for a few minutes. Tokens do not carry over to tomorrow.',
  blockToken: '{m} min',
  blockTokenLeft: '{k} left',
  blockNoTokens: 'No postpone tokens left today.',
  blockTokenConfirm: 'Use the {m}-minute token now?',
  blockTokenYes: 'Yes, use it',
  blockNotNow: 'Not now',
  blockBypass: 'Emergency bypass…',
  blockBypassIntro: 'For a real emergency: type the sentence below (pasting is off), and say why. It lifts the screen for {m} minutes.',
  blockBypassType: 'Type it here',
  blockBypassReason: 'Why now? (a few words)',
  blockBypassContinue: 'Continue',
  blockBypassMismatch: 'Not quite the same sentence yet.',
  blockBypassConfirm: 'Borrow {m} minutes from Friday?',
  blockBypassYes: 'Yes, borrow {m} minutes',
  blockBypassUsed: 'Emergency bypasses used today: {k}',
  blockFailed: "That didn't go through — try again in a moment.",
  blockOtherScreen: 'Notes and options are on the main screen.',
  // Break nudge (R-POL-5)
  nudgeTitle: '{t} of work without a real break.',
  nudgeBody: 'A few minutes away from the screen helps — stand up, drink some water, look out of a window.',
  nudgeBreak: 'Taking a break now',
  nudgeSnooze: 'Remind me in {m} min',
} as const;

