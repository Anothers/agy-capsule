// The desktop host owns the options and the selection. Re-read both from the
// current button before writing; a retained composer may belong to another chat.
export function readPickerState(trigger) {
  if (!trigger) return null;
  const key = Object.keys(trigger).find(key => key.startsWith('__reactFiber$'));
  let fiber = trigger[key];
  if (!fiber) return null;
  if (fiber.alternate) {
    let root = fiber;
    while (root.return) root = root.return;
    if (root.stateNode?.current && root !== root.stateNode.current) fiber = fiber.alternate;
  }

  let conversationId, provider, options;
  for (let node = fiber; node; node = node.return) {
    const props = node.memoizedProps;
    if (!props || typeof props !== 'object') continue;
    if (conversationId === undefined && 'placement' in props && 'conversationId' in props) {
      conversationId = props.conversationId;
    }
    if (!options) options = props.modelOptions ?? props.value?.modelOptions;
    if (!provider && typeof props.value?.getModelConfigForConversation === 'function' &&
        typeof props.value?.setModelConfigByLabelForConversation === 'function') provider = props.value;
  }
  if (!provider || typeof conversationId !== 'string' || !conversationId) return null;
  options ??= provider.visibleModelConfigs;
  if (!Array.isArray(options)) return null;
  const labels = [...new Set(options.filter(option => option && !option.disabled && !option.isDisabled &&
    option.isAvailable !== false && !option.isHidden && typeof option.label === 'string' && option.label.trim()).map(option => option.label))];
  const selected = provider.getModelConfigForConversation(conversationId)?.label;
  if (!labels.includes(selected)) return null;
  return { conversationId, labels, selected, choose(label) {
    // Experimental conversation-only path. Desktop default persistence needs live verification.
    return provider.setModelConfigByLabelForConversation(label, conversationId, false);
  } };
}

export function syncModelPicker(root, footer, enabled, title, findFooterLeft) {
  const previous = root._modelPicker;
  if (!enabled && !previous) return;
  const trigger = enabled && footer.querySelector('button[data-testid="model-selector-trigger"]');
  const read = () => {
    try { return readPickerState(trigger); } catch { return null; }
  };
  const state = trigger && read();
  if (previous && (!state || previous.trigger !== trigger || previous.id !== state.conversationId)) {
    previous.dispose();
  }
  if (!state) return;
  if (root._modelPicker) {
    root._modelPicker.refresh(state, title);
    return;
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dk-pill';
  button.dataset.el = 'modelPicker';
  const panel = document.createElement('div');
  panel.className = 'dk-model-options';
  panel.popover = 'auto';
  panel.setAttribute('role', 'group');
  const options = document.createElement('div');
  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  panel.append(options, status);
  root.prepend(button, panel);
  button.popoverTargetElement = panel;
  trigger.setAttribute('data-deck-model-bubble', '');
  let signature, pending = null, expiry;
  const close = () => { if (panel.matches(':popover-open')) panel.hidePopover(); };
  const isCurrent = () => findFooterLeft() === footer && trigger.isConnected &&
    footer.querySelector('button[data-testid="model-selector-trigger"]') === trigger;
  const picker = {
    trigger, id: state.conversationId,
    dispose() {
      clearTimeout(expiry);
      close();
      button.remove();
      panel.remove();
      trigger.removeAttribute('data-deck-model-bubble');
      delete root._modelPicker;
    },
    refresh(next, caption) {
      if (button.textContent !== next.selected) button.textContent = next.selected;
      button.title = caption;
      panel.setAttribute('aria-label', caption);
      if (pending && next.selected === pending) {
        clearTimeout(expiry);
        pending = null;
        status.textContent = '';
        close();
      }
      const key = JSON.stringify([next.labels, next.selected, pending]);
      if (key === signature) return;
      signature = key;
      const rows = new Map();
      options.replaceChildren();
      for (const label of next.labels) {
        const match = /^(.*?)\s*\((off|low|medium|high|extra|xhigh|max|minimal)(?:\s+thinking)?\)$/i.exec(label);
        const name = match ? match[1].trim() : label;
        let row = rows.get(name);
        if (!row) {
          row = document.createElement('div');
          rows.set(name, row);
          options.append(row);
          if (match) {
            const heading = document.createElement('span');
            heading.textContent = name;
            row.append(heading);
          }
        }
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.textContent = match ? match[2] : label;
        choice.dataset.label = label;
        choice.setAttribute('aria-label', label);
        choice.setAttribute('aria-pressed', String(label === next.selected));
        choice.disabled = pending !== null;
        row.append(choice);
      }
    },
  };
  root._modelPicker = picker;
  panel.addEventListener('beforetoggle', event => {
    if (event.newState !== 'open') return;
    const rect = button.getBoundingClientRect();
    panel.style.left = Math.max(4, Math.min(rect.left, innerWidth - Math.min(440, innerWidth - 8) - 4)) + 'px';
    panel.style.bottom = Math.max(4, innerHeight - rect.top + 4) + 'px';
    panel.style.maxHeight = Math.max(32, rect.top - 8) + 'px';
  });
  options.addEventListener('click', async event => {
    const choice = event.target.closest('button[data-label]');
    if (!choice || pending || !isCurrent()) return;
    const current = read();
    const label = choice.dataset.label;
    if (!current || current.conversationId !== picker.id || !current.labels.includes(label)) {
      picker.dispose();
      return;
    }
    if (label === current.selected) { close(); return; }
    pending = label;
    picker.refresh(current, button.title);
    const fail = () => {
      if (root._modelPicker !== picker || pending !== label) return;
      pending = null;
      status.textContent = document.documentElement.lang.startsWith('zh') ?
        '尚未确认切换，请查看原生菜单。' : 'Selection unconfirmed. Check the native menu.';
      const next = read();
      if (next && next.conversationId === picker.id) picker.refresh(next, button.title);
      else picker.dispose();
    };
    expiry = setTimeout(fail, 3000);
    try {
      await current.choose(label);
      if (root._modelPicker !== picker) return;
      const next = read();
      if (isCurrent() && next?.conversationId === picker.id) picker.refresh(next, button.title);
      else picker.dispose();
    } catch { fail(); }
  });
  picker.refresh(state, title);
}
