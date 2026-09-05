import type { Page } from '@playwright/test';

const HOST_OWNED_ENTRY = 'https://lokuyow.github.io/ehagaki/web-component/host-owned/ehagaki-composer.js';

export async function installHostOwnedStub(page: Page): Promise<{ requests: () => number }> {
	let requests = 0;
	await page.route(HOST_OWNED_ENTRY, async (route) => {
		requests += 1;
		await route.fulfill({
			contentType: 'application/javascript',
			body: `class EhagakiComposer extends HTMLElement {
  editorIsEmpty = null;
  editor = null;
  reply = null;
  submitting = false;
  emit(name, detail) {
    if (name === 'ehagaki-post-success' || name === 'ehagaki-post-error') window.__ehagakiTerminalCount = (window.__ehagakiTerminalCount || 0) + 1;
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }));
  }
  contextUpdated() { this.emit('ehagaki-composer-context-updated', { reply: this.reply, quotes: [], channel: null }); }
  async setContext(patch) {
    if (this.submitting) throw new Error('submission_in_progress');
    (window.__ehagakiContextCalls ||= []).push(patch);
    if (patch.content === null) { this.editor.value = ''; this.updateEditorEmpty(); }
    if (Object.hasOwn(patch, 'reply')) this.reply = patch.reply;
    this.renderReply(patch.preloadedEvents);
    this.contextUpdated();
  }
  replyId() {
    if (!this.reply) return null;
    // The PBF wrapper writes canonical note identifiers. Decode their 32-byte payload for the stub Output.
    const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    let value = 0, bits = 0, hex = '';
    for (const character of this.reply.slice(5, -6)) {
      value = (value << 5) | alphabet.indexOf(character); bits += 5;
      if (bits >= 8) { bits -= 8; hex += ((value >> bits) & 255).toString(16).padStart(2, '0'); }
    }
    return hex;
  }
  renderReply(preloadedEvents) {
    this.shadowRoot.querySelector('[aria-label="Reply preview"]')?.remove();
    if (!this.reply) return;
    const preview = document.createElement('div'); preview.setAttribute('aria-label', 'Reply preview');
    preview.dataset.replyId = this.replyId();
    const body = document.createElement('span'); body.textContent = preloadedEvents?.[this.replyId()]?.content || 'Reply';
    const clear = document.createElement('button'); clear.textContent = '×'; clear.setAttribute('aria-label', 'Clear reply');
    clear.onclick = () => { this.reply = null; this.renderReply(); this.contextUpdated(); };
    preview.append(body, clear); this.shadowRoot.prepend(preview);
  }
  constructor() { super(); this.attachShadow({ mode: 'open' }); }
  configureHostOwned(options) { this.options = options; window.__ehagakiHostOwnedOptions = options; }
  whenReady() { return Promise.resolve(); }
  focusEditor() { this.editor?.focus(); }
  blurEditor() { this.editor?.blur(); }
  connectedCallback() {
    if (this.shadowRoot.childElementCount) return;
    window.__ehagakiAbortActiveSubmit = () => this.activeController?.abort();
    const textarea = document.createElement('textarea');
    textarea.setAttribute('contenteditable', 'true');
    textarea.setAttribute('aria-label', '投稿エディター');
    const updateEditorEmpty = () => {
      this.editorIsEmpty = textarea.value.length === 0;
      this.dispatchEvent(new CustomEvent('ehagaki-editor-empty-change', { bubbles: true, composed: true, detail: { isEmpty: this.editorIsEmpty } }));
    };
    textarea.addEventListener('input', updateEditorEmpty);
    textarea.addEventListener('keydown', (event) => {
      if (event.key.startsWith('Arrow')) window.__ehagakiEditorArrowPrevented = event.defaultPrevented;

      if ((event.key !== 'Enter' && event.code !== 'NumpadEnter') || event.isComposing || event.shiftKey) return;
      const shortcut = (this.options.submitShortcuts || []).find((candidate) => {
        if (candidate.modifiers.length !== 1) return false;
        if (candidate.modifiers[0] === 'ctrlOrMeta') return (event.ctrlKey !== event.metaKey) && !event.altKey;
        if (candidate.modifiers[0] === 'alt') return event.altKey && !event.ctrlKey && !event.metaKey;
        return false;
      });
      if (event.ctrlKey || event.metaKey || event.altKey) {
        if (!shortcut) return;
      }
      event.preventDefault();
      void submit(shortcut?.id);
    });
    const submit = async (shortcutId) => {
      if (this.submitting) return;
      this.submitting = true;
      const controller = new AbortController();
      if (window.__ehagakiAbortNextSubmit) { window.__ehagakiAbortNextSubmit = false; controller.abort(); }
      this.activeController = controller; window.__ehagakiSubmitStarted = true;
      try {
        const reply = Object.hasOwn(window, '__ehagakiSubmitReplyOverride') ? window.__ehagakiSubmitReplyOverride : this.replyId() ? {
          eventId: this.replyId(), relayHints: ['wss://untrusted-composer.test/'], authorPubkey: 'f'.repeat(64)
        } : null;
        const result = await this.options.submit({ content: textarea.value, tags: [['e', 'f'.repeat(64)]], context: { reply, quotes: [], channel: null } }, { signal: controller.signal, shortcutId });
        this.emit('ehagaki-post-success', result);
        this.reply = null; this.renderReply();
        textarea.value = '';
        updateEditorEmpty();
      } catch { this.emit('ehagaki-post-error', { code: 'post_failed' }); }
      finally { this.activeController = null; this.submitting = false; }
    };
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Send';
    button.addEventListener('click', () => void submit());
    this.editor = textarea; this.updateEditorEmpty = updateEditorEmpty;
    this.shadowRoot.append(textarea, button);
    window.__ehagakiSetPreferredHeight = (height) => this.dispatchEvent(new CustomEvent('ehagaki-preferred-height-change', { bubbles: true, composed: true, detail: { height } }));
    if (window.__ehagakiDeferComposerEmptyState) {
      window.__ehagakiResolveComposerEmptyState = updateEditorEmpty;
    } else {
      updateEditorEmpty();
    }
  }
}
customElements.define('ehagaki-composer', EhagakiComposer);`
		});
	});
	return { requests: () => requests };
}
