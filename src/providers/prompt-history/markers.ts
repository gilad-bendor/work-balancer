// The fixed boilerplate `execute-copilot-session` appends to every prompt file (F-COP-9). Matched on text in memory
// only — never persisted. If the runner's boilerplate changes, re-check these (copilot-history-formats.md §7.7).
const RUNNER_MARKERS: readonly RegExp[] = [
  /WORKING AGREEMENT: These interaction preferences govern this task/,
  /TASK OUTCOME: A success signal means substantive task completion/,
  /the very LAST thing you do MUST be to (rename the prompt file|create the file)/,
];

export function hasRunnerMarker(text: string): boolean {
  return RUNNER_MARKERS.some((re) => re.test(text));
}
