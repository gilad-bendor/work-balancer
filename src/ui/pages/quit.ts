// Quit (menu → "Quit work-balancer…", R-UI-MENU-3): confirm, then Lua stops everything until the next module load.
import { act, boot, closeOnEscape, closeWindow, el, tellLua } from './page.ts';

void boot<{ allowed?: boolean } | null>(({ strings: s, model }) => {
  closeOnEscape(s.escUnsaved!);
  const msg = el('p', { class: 'msg', role: 'status' });
  const stop = el('button', { class: 'primary' }, s.quitConfirm!);
  const keep = el('button', {}, s.quitCancel!);
  stop.addEventListener('click', async () => {
    stop.disabled = true;
    try {
      const r = await act<{ quit?: boolean }>('confirm');
      if (r.ok && r.quit) {
        msg.textContent = s.quitBye!;
        tellLua('quit');
        return;
      }
      if (r.error === 'enforcing') {
        msg.textContent = s.quitRefused!;
        return; // stays disabled
      }
    } catch {
      // the daemon is unreachable: Lua can still stop (it confirms on its own when the daemon is down)
      tellLua('quit');
      return;
    }
    stop.disabled = false;
  });
  keep.addEventListener('click', closeWindow);
  document.body.replaceChildren(el('main', { class: 'card' },
    el('h1', {}, s.quitTitle!),
    el('p', {}, s.quitBody!),
    msg,
    el('div', { class: 'row end' }, keep, stop),
  ));
  if (model?.allowed === false) {
    msg.textContent = s.quitRefused!;
    stop.disabled = true;
  }
  keep.focus();
});
