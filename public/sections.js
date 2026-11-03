// Persistent, keyboard-accessible sidebar groups. Rebuilding rows keeps their fold state.
export function foldSection(host, label, key) {
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'sec gsec fold-head';
  head.dataset.section = key;
  const arrow = document.createElement('span');
  arrow.className = 'gcar';
  arrow.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.textContent = label;
  const body = document.createElement('div');
  body.id = 'section-' + key;
  head.setAttribute('aria-controls', body.id);
  let open = true;
  try { open = localStorage.getItem('riffleFold:' + key) !== '0'; } catch (_) {}
  const render = () => {
    arrow.textContent = open ? '▾' : '▸';
    head.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
  };
  head.append(arrow, text);
  head.addEventListener('click', () => {
    open = !open;
    try { localStorage.setItem('riffleFold:' + key, open ? '1' : '0'); } catch (_) {}
    render();
  });
  render();
  host.append(head, body);
  return body;
}
