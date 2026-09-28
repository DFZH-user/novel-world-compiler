import { initializeStory } from './novel-story.js';
import './novel-project.js';
import { createWorldLibrary } from './novel-world-library.js';
import { createReadingControls } from './novel-reading-controls.js';
import { eventSource, event_types } from './events.js';
import { extension_settings } from './extensions.js';
import { saveSettingsDebounced } from '../script.js';

// Presentation adapter: original controls, IDs, event handlers and chat DOM stay intact.
function initialize() {
  if (document.getElementById('nw-bar')) return;
  const body = document.body;
  const settings = extension_settings.novel_world ??= { whale: true, ripple: true, strength: 2, fontSize: 18 };
  const save = () => saveSettingsDebounced();
  const bar = document.createElement('header'); bar.id = 'nw-bar';
  bar.innerHTML = '<div class="nw-breadcrumb"><span>READING ROOM</span><strong id="nw-story-title">故事，正在这里发生</strong></div><nav aria-label="酒馆页面"><button id="nw-read" class="active">沉浸阅读</button><button id="nw-settings">参数设置</button></nav><div class="nw-bar-actions"><button id="nw-characters">选择角色 ↗</button><button id="nw-sessions">会话记录</button></div>';
  const sidebar = document.createElement('aside'); sidebar.id = 'nw-settings-sidebar';
  sidebar.innerHTML = '<p>让故事按你的方式发生</p><h1>阅读设置</h1><label class="nw-search"><input id="nw-search" type="search" placeholder="搜索参数或功能…" aria-label="搜索参数或功能"></label><div id="nw-search-results"></div><nav id="nw-categories" aria-label="阅读设置"></nav><nav id="nw-subcategories" aria-label="本组设置"></nav><button id="nw-native">原生布局 / 扩展工具 ↗</button>';
  const heading = document.createElement('div'); heading.id = 'nw-setting-heading'; heading.innerHTML = '<small>YOUR READING PREFERENCES</small><h2 id="nw-setting-title">模型连接</h2><p id="nw-setting-description">配置模型服务，开始与故事对话。</p>';
  const effectPanel = document.createElement('section'); effectPanel.id = 'nw-effect-panel';
  effectPanel.innerHTML = '<div class="nw-effect-preview"><span>≈</span><h3>字句间，有微风经过。</h3><p>把鼠标轻轻移过文字，感受水波。</p></div><label class="nw-setting-row"><span><strong>小鲸鱼光标</strong><small>简笔画小鲸鱼 · 约 38 像素</small></span><input data-pref="whale" type="checkbox"></label><label class="nw-setting-row"><span><strong>文字水波纹</strong><small>选择文字、编辑或减少动态效果时暂停</small></span><input data-pref="ripple" type="checkbox"></label><label class="nw-setting-row"><span><strong>涟漪强度</strong><small>轻轻晕开，保持文字清晰</small></span><input aria-label="涟漪强度" data-pref="strength" type="range" min="1" max="5"></label><label class="nw-setting-row"><span><strong>阅读字号</strong><small>适用于正文，不改变参数控件大小</small></span><input aria-label="阅读字号" data-pref="fontSize" type="range" min="16" max="24"></label>';
  const returnButton = document.createElement('button'); returnButton.id = 'nw-native-return'; returnButton.textContent = '← 返回小说世界阅读界面';
  body.append(bar, sidebar, heading, effectPanel, returnButton);
  const effects = window.NovelWorldEffects?.({ selector: '.mes_text, .nw-prose p, .nw-effect-preview p', preferences: settings, enabled: () => body.classList.contains('nw-theme') && !body.classList.contains('nw-generating'), onChange: value => { Object.assign(settings, value); save(); } });
  const story = initializeStory({ preferences: settings, saveSettings: save, effects });
  const categories = [
    ['nw-play-tuning', '游玩调节', '调整回复长度、创造性、流式显示和故事规则。'],
    ['sys-settings-button', '模型连接', '配置模型服务，开始与故事对话。'],
    ['ai-config-button', '生成参数', '调整采样与回复，让叙事保持合适的节奏。'],
    ['advanced-formatting-button', '提示词与上下文', '组织指令、上下文和模型输入格式。'],
    ['rightNavHolder', '角色与群组', '选择陪你进入故事的人，管理角色卡与群组。'],
    ['persona-management-button', '我的身份', '设定你在故事里的名字与身份。'],
    ['nw-world-library', '独立世界书工作台', '查看、搜索、导入并选择本会话采用的世界资料。'],
    ['WI-SP-button', '世界书', '让人物记住这个世界的背景与规则。'],
    ['nw-story-assistance', '剧情辅助', '当前状态与不同立场的行动建议。'],
    ['nw-story-checks', '行动合理性', '依据玩家能力和公开设定检查行动，可随时关闭。'],
    ['nw-story-settlement', '剧情结算', '独立分析已完成的正文，不干扰故事生成。'],
    ['nw-story-reading', '阅读排版', '连续小说、人物对白与字体。'],
    ['nw-story-avatars', '人物外观', '关联角色卡与管理本会话头像。'],
    ['nw-effects', '阅读与动效', '留一点安静，也留一点水的流动。'],
    ['user-settings-button', '界面与高级设置', '完整保留酒馆的界面、账户与高级选项。'],
    ['backgrounds-button', '背景管理', '管理原生布局使用的背景素材。'],
    ['extensions-settings-button', '扩展工具', '管理已安装扩展及其完整配置。'],
  ];
  document.querySelectorAll('#top-settings-holder > .drawer').forEach(drawer => { if (!categories.some(c => c[0] === drawer.id) && drawer.id) categories.push([drawer.id, drawer.querySelector('.drawer-icon')?.getAttribute('title') || '其他工具', '扩展提供的原生功能。']); });
  let selected = 'sys-settings-button', scrollTop = 0, activeBefore = null, searching = false;
  const q = id => document.getElementById(id);
  const groups = [
    ['AI 扮演／角色卡', ['rightNavHolder']],
    ['世界设定／世界书', ['nw-world-library', 'WI-SP-button']],
    ['我的身份', ['persona-management-button']],
    ['模型连接', ['sys-settings-button']],
    ['游玩调节', ['nw-play-tuning', 'nw-story-checks', 'nw-story-assistance', 'nw-story-settlement']],
    ['其他设置', categories.map(item => item[0]).filter(id => !['rightNavHolder','nw-world-library','WI-SP-button','persona-management-button','sys-settings-button','nw-play-tuning','nw-story-checks','nw-story-assistance','nw-story-settlement'].includes(id))],
  ];
  const controls = createReadingControls({ settings, save, selectCategory });
  const worldLibrary = createWorldLibrary(selectCategory);
  function renderNavigation(id) {
    const group = groups.find(item => item[1].includes(id)) || groups[5];
    q('nw-subcategories').replaceChildren();
    for (const button of q('nw-categories').children) {
      const active = button.dataset.group === group[0]; button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    }
    if (group[1].length > 1) for (const child of group[1]) {
      const category = categories.find(item => item[0] === child); if (!category) continue;
      const button = document.createElement('button'); button.textContent = category[1];
      button.classList.toggle('active', child === id); button.onclick = () => selectCategory(child);
      q('nw-subcategories').append(button);
    }
  }
  function closeDrawers() {
    document.querySelectorAll('#top-settings-holder > .drawer').forEach(drawer => { const panel = drawer.querySelector('.drawer-content'); if (panel?.classList.contains('openDrawer')) drawer.querySelector('.drawer-toggle')?.click(); });
    document.querySelectorAll('.nw-selected-panel').forEach(panel => panel.classList.remove('nw-selected-panel'));
  }
  function selectCategory(id) {
    const category = categories.find(c => c[0] === id); if (!category) return;
    selected = id; effects?.clear(); closeDrawers();
    q('nw-setting-title').textContent = category[1]; q('nw-setting-description').textContent = category[2];
    renderNavigation(id);
    story?.select(id);
    effectPanel.hidden = id !== 'nw-effects';
    const controlPanel = controls.show(id);
    const libraryPanel = worldLibrary.show(id);
    const custom = controlPanel || libraryPanel;
    if (id !== 'nw-effects' && !custom) {
      const drawer = q(id); const panel = drawer?.querySelector('.drawer-content');
      if (panel) { if (!panel.classList.contains('openDrawer')) drawer.querySelector('.drawer-toggle')?.click(); panel.classList.add('nw-selected-panel'); }
    }
  }
  function setMode(mode, category) {
    effects?.clear();
    if (mode === 'settings' && !body.classList.contains('nw-settings')) { scrollTop = q('chat')?.scrollTop || 0; activeBefore = document.activeElement; }
    body.classList.add('nw-theme'); body.classList.toggle('nw-settings', mode === 'settings'); body.classList.toggle('nw-reading', mode === 'reading');
    q('nw-read').classList.toggle('active', mode === 'reading'); q('nw-settings').classList.toggle('active', mode === 'settings');
    if (mode === 'settings') selectCategory(category || selected);
    else { closeDrawers(); story?.hide(); controls.hide(); worldLibrary.hide(); effectPanel.hidden = true; requestAnimationFrame(() => { if (q('chat')) q('chat').scrollTop = scrollTop; if (activeBefore?.isConnected && activeBefore.closest('#sheld')) activeBefore.focus({ preventScroll: true }); }); }
  }
  for (const [label, ids] of groups) { const button = document.createElement('button'); button.dataset.group = label; button.textContent = label; button.onclick = () => selectCategory(ids[0]); q('nw-categories').append(button); }
  window.novelWorldReadingSettings = { open(page) {
    const target = { model: 'sys-settings-button', tuning: 'nw-play-tuning', other: 'advanced-formatting-button' }[page];
    if (target) setMode('settings', target);
  } };
  q('nw-read').onclick = () => setMode('reading'); q('nw-settings').onclick = () => setMode('settings'); q('nw-characters').onclick = () => setMode('settings', 'rightNavHolder');
  q('nw-sessions').onclick = () => { setMode('reading'); q('option_select_chat')?.click(); };
  q('nw-native').onclick = () => { effects?.clear(); closeDrawers(); story?.hide(); controls.hide(); worldLibrary.hide(); body.classList.remove('nw-theme', 'nw-settings', 'nw-reading'); };
  returnButton.onclick = () => setMode('reading');
  const font = () => body.style.setProperty('--nw-reading-size', Math.max(16, Math.min(24, Number(settings.fontSize) || 18)) + 'px'); font();
  effectPanel.querySelectorAll('[data-pref]').forEach(input => {
    const key = input.dataset.pref; if (input.type === 'checkbox') input.checked = settings[key] !== false; else input.value = String(settings[key] || (key === 'fontSize' ? 18 : 2));
    input.addEventListener('input', () => { settings[key] = input.type === 'checkbox' ? input.checked : Number(input.value); effects?.update(settings); font(); save(); });
  });
  q('nw-search').addEventListener('input', () => {
    const query = q('nw-search').value.trim().toLocaleLowerCase(); const results = q('nw-search-results'); results.replaceChildren(); searching = Boolean(query);
    if (!query) return;
    let count = 0;
    for (const [id, title] of categories) {
      const root = id === 'nw-effects' ? effectPanel : q(id); if (!root) continue;
      const labels = [...root.querySelectorAll('label, h3, h4, .inline-drawer-header')].filter(el => el.textContent.trim().toLocaleLowerCase().includes(query));
      if (title.toLocaleLowerCase().includes(query)) labels.unshift(null);
      for (const label of labels.slice(0, 4)) {
        if (count++ >= 15) break;
        const button = document.createElement('button'); button.textContent = title + (label ? ' · ' + label.textContent.trim().replace(/\s+/g, ' ').slice(0, 44) : '');
        button.onclick = () => { selectCategory(id); if (label) { let parent = label.parentElement; while (parent && parent !== root) { if (parent.classList.contains('inline-drawer-content') && getComputedStyle(parent).display === 'none') parent.parentElement.querySelector('.inline-drawer-toggle')?.click(); parent = parent.parentElement; } label.scrollIntoView({ block: 'center', behavior: 'smooth' }); label.classList.add('nw-found'); setTimeout(() => label.classList.remove('nw-found'), 1800); } }; results.append(button);
      }
    }
    if (!results.children.length) { const hint = document.createElement('small'); hint.textContent = '未找到参数，可试试英文名称。'; results.append(hint); }
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && body.classList.contains('nw-settings') && !document.querySelector('dialog[open],.popup:not([hidden])')) { if (searching) { q('nw-search').value = ''; q('nw-search').dispatchEvent(new Event('input')); } else setMode('reading'); } });
  function title() { const names = document.querySelectorAll('#chat .mes:not([is_user="true"]) .name_text'); q('nw-story-title').textContent = names.length ? names[names.length - 1].textContent.trim() : '故事，正在这里发生'; }
  eventSource.on(event_types.CHAT_CHANGED, () => { effects?.clear(); title(); }); eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, title); eventSource.on(event_types.MESSAGE_EDITED, () => effects?.clear());
  setMode('reading'); title();
  // Native welcome actions and extension shortcuts still enter the matching full page.
  const nativeNavigation = new MutationObserver(() => {
    if (!body.classList.contains('nw-reading')) return;
    const opened = categories.find(([id]) => q(id)?.querySelector('.drawer-content.openDrawer'));
    if (opened) setMode('settings', opened[0]);
  });
  document.querySelectorAll('#top-settings-holder .drawer-content').forEach(panel => nativeNavigation.observe(panel, { attributes: true, attributeFilter: ['class'] }));
  addEventListener('pagehide', () => { nativeNavigation.disconnect(); effects?.dispose(); }, { once: true });
}
eventSource.once(event_types.APP_READY, initialize);
