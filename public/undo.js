// undo.js — Ctrl+Z undo for rename / trash via POST /api/undo.
// Kept OUT of main.js so the parallel teammate's main.js edits collide less:
// main.js only imports createUndo + newGroup and hooks three call sites.
import { t } from './i18n.js';

export function newGroup() {
  return 'g' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// deps: { toast(msg, action?) , onRestored(result) — refresh UI after a restore }
export function createUndo({ toast, onRestored }) {
  let busy = false;

  async function undoLast() {
    if (busy) return;
    busy = true;
    try {
      const r = await fetch('/api/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      let d = null;
      try { d = await r.json(); } catch (_) {}
      if (r.status === 404) { toast(t('undoNone')); return; }
      if (!r.ok || !d || d.ok === false) {
        toast(t('undoFail', { msg: (d && (d.error || (d.failed && d.failed[0] && d.failed[0].error))) || ('http ' + r.status) }));
        return;
      }
      if (d.failed && d.failed.length && !(d.restored && d.restored.length)) {
        toast(t('undoFail', { msg: d.failed[0].error }));
        return;
      }
      const names = (d.restored || []).slice(0, 3);
      const extra = (d.restored || []).length > 3 ? ` (+${(d.restored || []).length - 3})` : '';
      const fails = (d.failed && d.failed.length) ? ` (${d.failed.length} ✗: ${d.failed[0].error})` : '';
      toast(t('undoDone', { v: names.join('、') + extra + fails }));
      if (onRestored) onRestored(d);
    } catch (e) {
      toast(t('undoFail', { msg: e && e.message || String(e) }));
    } finally {
      busy = false;
    }
  }

  // action object for the op toast's 復原 link
  function undoAction() { return { label: t('undoLink'), fn: undoLast }; }

  // keydown hook: Ctrl/Cmd+Z (not while typing — the caller already skips inputs)
  function onKeydown(e) {
    if (!(e.ctrlKey || e.metaKey)) return false;
    if (e.key !== 'z' && e.key !== 'Z') return false;
    undoLast();
    return true;
  }

  return { undoLast, undoAction, onKeydown };
}
