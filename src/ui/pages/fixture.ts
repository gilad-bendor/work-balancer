// M7 fixture page: renders in every window mode and exercises the page plumbing (strings, model, action, text
// entry, closing through Lua). Never part of a product flow.
import { act, boot, closeOnEscape, el, focusOnInteract, inHammerspoon, isPrimary, tellLua } from './page.ts';

interface FixtureModel {
  mode: string;
  perScreen: boolean;
  focus: boolean;
  secondsLeft: number;
}

void boot<FixtureModel | null>(({ strings, model }) => {
  closeOnEscape(strings.escUnsaved!);
  if (!model?.focus) focusOnInteract();
  const mode = model?.mode ?? new URLSearchParams(location.search).get('mode') ?? 'normal';
  document.body.classList.add(`mode-${mode}`);
  const left = el('span', {}, String(model?.secondsLeft ?? '–'));
  const input = el('input', { type: 'text', placeholder: strings.fixtureTypeHere! });
  const echoed = el('p', { class: 'muted' });
  const send = el('button', {}, strings.fixtureEcho!);
  send.addEventListener('click', () => {
    void act<{ echo: string }>('echo', { text: input.value }).then((r) => { echoed.textContent = `${strings.fixtureEchoed}: “${r.echo}”`; });
  });
  const close = el('button', { class: 'primary' }, strings.close!);
  close.addEventListener('click', () => void act('close').catch(() => tellLua('close')));
  const main = el('main', { class: 'card' },
    el('h1', {}, strings.fixtureTitle!),
    el('p', {}, strings.fixtureBody!),
    el('p', { class: 'muted' }, `${strings.fixtureMode}: ${mode}${model?.perScreen ? (isPrimary ? ' · per screen (primary)' : ' · per screen') : ''}`),
    el('p', { class: 'muted' }, `${strings.fixtureSecondsLeft} `, left, ' s'),
    ...(isPrimary ? [el('div', { class: 'row' }, input, send), echoed] : []),
    el('div', { class: 'row' }, close),
    ...(inHammerspoon ? [] : [el('p', { class: 'muted' }, strings.fixtureNotInHammerspoon!)]),
  );
  document.body.replaceChildren(main);
  if (model?.focus && isPrimary) input.focus();
  let n = model?.secondsLeft ?? 0;
  setInterval(() => { n = Math.max(0, n - 1); left.textContent = String(n); }, 1000);
});
