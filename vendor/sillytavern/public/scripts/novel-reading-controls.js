import { getContext } from './st-context.js';

export function createReadingControls({ settings, save, selectCategory }) {
  const panel = document.createElement('section'); panel.id = 'nw-play-tuning';
  panel.className = 'nw-story-settings-panel'; panel.hidden = true;
  const personaPanel = document.createElement('section'); personaPanel.id = 'nw-project-persona';
  personaPanel.className = 'nw-story-settings-panel'; personaPanel.hidden = true;
  document.body.append(panel, personaPanel);
  function button(label, action) { const value = document.createElement('button'); value.textContent = label; value.onclick = action; return value; }
  function row(root, label, input, description) {
    const wrapper = document.createElement('label'); wrapper.className = 'nw-setting-row';
    const copy = document.createElement('span'); const title = document.createElement('strong'); title.textContent = label;
    const hint = document.createElement('small'); hint.textContent = description; copy.append(title, hint); wrapper.append(copy, input); root.append(wrapper);
  }
  function show(id) {
    panel.hidden = id !== 'nw-play-tuning'; personaPanel.hidden = true;
    if (id === 'nw-play-tuning') {
      panel.replaceChildren();
      if (getContext().mainApi === 'openai') {
        for (const [nativeId, title, hint] of [
          ['openai_max_tokens', '回复长度上限', '使用当前模型的输出预算；实际可用上限由服务决定。'],
          ['temp_openai', '创造性／温度', '沿用当前连接的采样参数，不预设模型能力。'],
          ['stream_toggle', '边生成边显示', '模型支持流式输出时生效。'],
        ]) {
          const native = document.getElementById(nativeId); if (!native) continue;
          const input = document.createElement('input'); input.type = native.type === 'checkbox' ? 'checkbox' : 'number';
          input.value = native.value; input.checked = native.checked; input.disabled = native.disabled;
          for (const name of ['min', 'max', 'step']) if (native.hasAttribute(name)) input.setAttribute(name, native.getAttribute(name));
          input.onchange = () => { if (!input.checkValidity()) return; native.value = input.value; native.checked = input.checked;
            native.dispatchEvent(new Event('input', { bubbles: true })); native.dispatchEvent(new Event('change', { bubbles: true })); };
          row(panel, title, input, hint);
        }
      } else {
        const text = document.createElement('p'); text.textContent = '当前连接的生成参数请在高级生成参数中调整。'; panel.append(text);
      }
      panel.append(button('行动合理性', () => selectCategory('nw-story-checks')),
        button('剧情辅助与额外调用设置', () => selectCategory('nw-story-assistance')),
        button('高级生成参数', () => selectCategory('ai-config-button')));
    }
    const marker = getContext().chatMetadata?.novel_world_compiler;
    if (id === 'persona-management-button' && marker?.persona) {
      personaPanel.hidden = false; personaPanel.replaceChildren();
      const name = document.createElement('input'); name.value = marker.persona.name; name.maxLength = 80;
      const description = document.createElement('textarea'); description.value = marker.persona.description || ''; description.rows = 8; description.maxLength = 3500;
      row(personaPanel, '本会话姓名', name, '只修改当前游玩会话。');
      row(personaPanel, '身份与背景', description, '你的行动、心理与台词始终由你控制。');
      const message = document.createElement('p'); message.setAttribute('role', 'status');
      personaPanel.append(button('保存本会话身份', async () => {
        if (!name.value.trim()) { message.textContent = '请填写姓名。'; return; }
        if (marker.mode === 'character' && name.value.trim() === getContext().characters[getContext().characterId]?.name) {
          message.textContent = '你和 AI 不能同时扮演同一人物。'; return;
        }
        const context = getContext();
        if (context.chatMetadata?.novel_world_compiler !== marker) { message.textContent = '会话已切换，请重新打开身份设置。'; return; }
        const previous = marker.persona;
        const next = { name: name.value.trim(), description: description.value.trim() };
        marker.persona = next;
        try { await context.saveChat({ throwOnError: true, expectedChatId: context.chatId }); message.textContent = '本会话身份已保存。'; }
        catch { if (marker.persona === next) marker.persona = previous; message.textContent = '保存失败，已保留原身份，请重试。'; }
      }), message);
      return true;
    }
    return id === 'nw-play-tuning';
  }
  settings.layout ??= {};
  function applyLayout() {
    for (const [key, variable] of [['width', '--nw-resizable-width'], ['input', '--nw-input-height'], ['actionRail', '--nw-action-rail-width'], ['statusRail', '--nw-status-rail-width'], ['sidebar', '--nw-sidebar-width']]) {
      if (settings.layout[key]) document.body.style.setProperty(variable, `${settings.layout[key]}px`);
      else document.body.style.removeProperty(variable);
    }
  }
  function splitter(parent, key, label, axis, min, max, initial) {
    if (!parent) return;
    const handle = document.createElement('div'); handle.className = `nw-resize-handle nw-resize-${key}`;
    handle.tabIndex = 0; handle.setAttribute('role', 'separator'); handle.setAttribute('aria-label', label);
    handle.setAttribute('aria-orientation', axis === 'x' ? 'vertical' : 'horizontal');
    const update = value => { settings.layout[key] = Math.round(Math.max(min, Math.min(max(), value))); applyLayout(); };
    handle.onpointerdown = event => {
      event.preventDefault(); const start = axis === 'x' ? event.clientX : event.clientY;
      const value = settings.layout[key] || initial(); handle.setPointerCapture(event.pointerId);
      handle.onpointermove = move => update(value + ((axis === 'x' ? move.clientX : move.clientY) - start) * (key === 'width' ? 2 : key === 'input' || key === 'statusRail' ? -1 : 1));
      handle.onpointerup = () => { handle.onpointermove = null; save(); };
      handle.onpointercancel = () => { handle.onpointermove = null; save(); };
    };
    handle.onkeydown = event => { if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); update((settings.layout[key] || initial()) + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -20 : 20)); save();
    } };
    handle.ondblclick = () => { delete settings.layout[key]; applyLayout(); save(); };
    parent.append(handle);
  }
  splitter(document.getElementById('sheld'), 'width', '调整正文宽度，双击恢复', 'x', 500, () => innerWidth - 40, () => 880);
  splitter(document.getElementById('send_form'), 'input', '调整输入区高度，双击恢复', 'y', 45, () => innerHeight * 0.3, () => 80);
  splitter(document.getElementById('nw-action-rail'), 'actionRail', '调整行动建议栏宽度，双击恢复', 'x', 200, () => Math.min(380, innerWidth * 0.3), () => 280);
  splitter(document.getElementById('nw-story-dock'), 'statusRail', '调整当前剧情栏宽度，双击恢复', 'x', 200, () => Math.min(380, innerWidth * 0.3), () => 280);
  splitter(document.getElementById('nw-settings-sidebar'), 'sidebar', '调整设置侧栏宽度，双击恢复', 'x', 180,
    () => Math.min(420, innerWidth * 0.4), () => document.getElementById('nw-settings-sidebar').getBoundingClientRect().width || 238);
  applyLayout();
  return { show, hide() { panel.hidden = true; personaPanel.hidden = true; } };
}
