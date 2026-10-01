import type { Page } from 'playwright-core';

/**
 * X moved the XChat UI (inbox, conversation list, message threads) into a shadow root under
 * `[data-testid="xchatEmbedRoute"]`. Playwright's own selector engine pierces open shadow roots,
 * but every DOM lookup inside xctl runs through `page.evaluate`, where `document.querySelector`
 * stops at the shadow boundary and returns null.
 *
 * Fix: install a document-level shim that retries the same query inside open shadow roots. It is
 * injected as an init script so it survives every navigation, and it only changes behaviour when
 * the light DOM has no match, so plain-document lookups keep their exact previous semantics.
 */
export const SHADOW_PIERCE_INIT = `(() => {
  const docQ = Document.prototype.querySelector;
  const docQA = Document.prototype.querySelectorAll;
  // ShadowRoot extends DocumentFragment, not Document, so its natives must be captured separately.
  const fragQ = ShadowRoot.prototype.querySelector;
  const fragQA = ShadowRoot.prototype.querySelectorAll;
  if (docQ.__xctlShadowPatched) return;
  const MAX_DEPTH = 24;

  // Use captured natives only: calling this.look would re-enter the patched versions.
  // Each node must be queried with its own native pair: Document and ShadowRoot are unrelated
  // hierarchies, and passing the wrong one throws "Illegal invocation".
  const collect = (node, out, depth) => {
    if (depth > MAX_DEPTH) return;
    const els = qaFor(node).call(node, '*');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el.shadowRoot) {
        out.push(el.shadowRoot);
        collect(el.shadowRoot, out, depth + 1);
      }
    }
  };
  const shadowRoots = (root) => { const out = []; collect(root, out, 0); return out; };
  // A root is a Document or a ShadowRoot; pick the matching native pair.
  const qFor = (root) => (root.nodeType === 9 ? docQ : fragQ);
  const qaFor = (root) => (root.nodeType === 9 ? docQA : fragQA);

  const querySelector = function (selector) {
    const direct = docQ.call(this, selector);
    if (direct || !selector || selector.charCodeAt(0) === 58 /* ':' */) return direct;
    const roots = shadowRoots(this);
    for (let i = 0; i < roots.length; i++) {
      const found = qFor(roots[i]).call(roots[i], selector);
      if (found) return found;
    }
    return null;
  };

  const querySelectorAll = function (selector) {
    const direct = docQA.call(this, selector);
    if ((!direct || direct.length === 0) && selector && selector.charCodeAt(0) !== 58) {
      const out = [];
      const seen = new Set();
      const roots = shadowRoots(this);
      for (let i = 0; i < roots.length; i++) {
        const els = qaFor(roots[i]).call(roots[i], selector);
        for (let j = 0; j < els.length; j++) {
          if (!seen.has(els[j])) { seen.add(els[j]); out.push(els[j]); }
        }
      }
      // Callers expect a NodeList, so keep item() semantics on the merged list.
      out.item = function (n) { return this[n] || null; };
      return out;
    }
    return direct;
  };

  querySelector.__xctlShadowPatched = true;
  Document.prototype.querySelector = querySelector;
  Document.prototype.querySelectorAll = querySelectorAll;
})();`;

/** Install the shadow-piercing DOM shim on every new document for this page. */
export async function installShadowPierce(page: Page): Promise<void> {
  await page.addInitScript({ content: SHADOW_PIERCE_INIT });
  // addInitScript only applies to future documents, so apply to the current one too.
  await page.evaluate(SHADOW_PIERCE_INIT).catch(() => {});
}
