// M3 placeholder: the real tracker (interactive minutes, work digest, menubar text) arrives in M4.
import type { Tracker, TrackerDeps } from './daemon.ts';

export function createTracker(_deps: TrackerDeps): Tracker {
  return {
    ingest() {},
    tick() {},
    flush() {},
    menubar: () => ({ title: '⏱', colour: 'none', tooltip: 'work-balancer: observing (worked time arrives in M4)', warning: null }),
    status: () => null,
  };
}
