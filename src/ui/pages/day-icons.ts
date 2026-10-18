// Part-of-day icons (owner 2026-10-18, D-83): one flat style — a rounded tile, the same horizon, the sun (or the moon)
// where it stands at that part of the day. Inline SVG (no files to serve, no ids, so any number can share a page).
import { el } from './page.ts';

const tile = (sky: string, ground: string, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">`
  + `<rect x="1" y="1" width="22" height="22" rx="5" fill="${sky}"/>${body}`
  + `<path d="M1 17h22v1a5 5 0 0 1-5 5H6a5 5 0 0 1-5-5z" fill="${ground}"/></svg>`;

const ICONS: Record<string, string> = {
  morning: tile('#ffe2b8', '#6f9a5c',
    '<circle cx="8" cy="17" r="4.6" fill="#f59e0b"/>'
    + '<path d="M8 9.6v1.6M3.2 12.2l1.1 1.1M12.8 12.2l-1.1 1.1" stroke="#f59e0b" stroke-width="1.4" stroke-linecap="round"/>'),
  afternoon: tile('#9fd3f5', '#6f9a5c',
    '<circle cx="12" cy="8.5" r="3.6" fill="#fbbf24"/>'
    + '<path d="M12 2.6v1.2M12 13.2v1.2M6.1 8.5h1.2M16.7 8.5h1.2M7.8 4.3l.9.9M15.3 11.8l.9.9M16.2 4.3l-.9.9M8.7 11.8l-.9.9" stroke="#fbbf24" stroke-width="1.3" stroke-linecap="round"/>'),
  evening: tile('#f6a77c', '#7a6152',
    '<circle cx="16" cy="17" r="4.6" fill="#e0532a"/>'
    + '<path d="M4 7.5h5M6 10h4" stroke="#fde3d2" stroke-width="1.3" stroke-linecap="round" opacity=".8"/>'),
  'end-of-workday': tile('#26345f', '#1b2547',
    '<circle cx="14" cy="9.5" r="4.4" fill="#f6e7a6"/><circle cx="16.1" cy="8" r="3.9" fill="#26345f"/>'
    + '<circle cx="6.5" cy="6" r=".9" fill="#fff"/><circle cx="9" cy="11.5" r=".7" fill="#fff"/><circle cx="18.5" cy="14" r=".6" fill="#fff"/>'),
};

/** The icon of a part of the day, with its name as tooltip / label (empty label = decorative, e.g. beside the name);
 * unknown stages show the name. */
export function stageIcon(stage: string, label: string): HTMLElement {
  const markup = ICONS[stage];
  if (!markup) return el('span', { class: 'r-tag' }, label);
  const box = el('span', label ? { class: 'stage-icon', title: label, role: 'img', 'aria-label': label } : { class: 'stage-icon', 'aria-hidden': 'true' });
  const t = document.createElement('template');
  t.innerHTML = markup; // constant markup from this module only
  box.append(t.content);
  return box;
}
