import { t } from './i18n.js';

const words = Object.fromEntries(['heading', 'tool', 'first', 'project', 'source', 'missing', 'copy', 'id', 'reveal', 'close', 'failed']
  .map(key => [key, t('convoInfo_' + key)]));

export function showConvoInfo(c, agentLabel, copyText, postOp) {
  const dialog = document.createElement('dialog');
  dialog.className = 'convo-dialog';
  const heading = document.createElement('h2');
  heading.id = 'convo-info-heading';
  heading.textContent = words.heading;
  dialog.setAttribute('aria-labelledby', heading.id);
  const nativeId = c.sessionId || '';
  const paths = Array.isArray(c.transcriptPaths) ? c.transcriptPaths.filter(p => typeof p === 'string') : [];
  const text = [c.title || words.missing, `${words.tool}: ${agentLabel}`,
    `Session ID: ${nativeId || words.missing}`, `${words.project}: ${c.project || words.missing}`,
    `${words.first}: ${c.firstPrompt || words.missing}`,
    `${words.source}:\n${paths.join('\n') || words.missing}`].join('\n\n');
  const pre = document.createElement('pre');
  pre.textContent = text;
  const footer = document.createElement('footer');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const button = (label, action) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label;
    b.addEventListener('click', () => Promise.resolve().then(action).catch(e => { status.textContent = words.failed + ': ' + e.message; }));
    footer.append(b); return b;
  };
  button(words.id, () => copyText(nativeId)).disabled = !nativeId;
  button(words.copy, () => copyText(text));
  paths.forEach((path, i) => button(words.reveal + (paths.length > 1 ? ` ${i + 1}` : ''), () => postOp('/api/reveal', { path })));
  button(words.close, () => dialog.close());
  dialog.append(heading, pre, footer, status);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
}

export const convoInfoLabel = words.heading;
