// Your app categories (ledger D-67). Edit freely: the daemon reloads this file on save; a broken edit keeps the
// previous version (menubar warning). Categories are recorded per minute for insight only — they never change worked
// time, budgets or the block ("WhatsApp" time counts toward the 9 hours like everything else).
import type { AppContext, CategoryStyle } from '../src/categories/categories.ts';

/** The category of the focused app. Return any short name (≤ 40 chars) except the built-ins Inactive / Blocked /
 * Future. The window title is available but never stored — so never put title text into the returned name (the name
 * IS stored). Keep it fast and simple (it runs on every app/title change; no heavy regexes on the title). */
export function categorize(app: AppContext): string {
  // Match by bundle id: WhatsApp's display name starts with an invisible left-to-right mark.
  if (app.bundleId === 'net.whatsapp.WhatsApp' || app.bundleId === 'desktop.WhatsApp') return 'WhatsApp';
  return 'Work';
}

/** How a category (yours, or a built-in timeline state) looks on daily timelines. */
export function categoryStyle(category: string): CategoryStyle {
  switch (category) {
    case 'Work': return { color: '#3b6e8f', thickness: 7, label: 'Work' };
    case 'WhatsApp': return { color: '#2e9e5b', thickness: 7, label: 'WhatsApp' };
    // Built-in timeline states.
    case 'Inactive': return { color: '#6b6b6b', thickness: 1, label: 'Inactive' };
    case 'Blocked': return { color: '#c0392b', thickness: 5, label: 'Blocked' };
    case 'Future': return { color: '#b5b2ab', thickness: 1, label: 'Future' };
    default: return { color: '#8e7cc3', thickness: 7, label: category };
  }
}
