// Display formatting shared by pages (worked time floored to h:mm — ledger R-INFO-3; dates as "Sun 4 Oct").

export function hm(seconds: number): string {
  const m = Math.floor(Math.max(0, seconds) / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const shortFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

/** A day key (YYYY-MM-DD, the 04:00-bounded day) as "Sun 4 Oct". */
export function dayLabel(day: string, opts: { weekday?: boolean } = {}): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y!, m! - 1, d!, 12);
  return (opts.weekday === false ? shortFmt : dayFmt).format(date);
}

export function timeLabel(ms: number): string {
  return timeFmt.format(new Date(ms));
}
