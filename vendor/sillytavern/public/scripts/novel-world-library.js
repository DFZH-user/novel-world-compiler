import { getContext } from './st-context.js';
import { isGenerating } from '../script.js';
import { world_names, updateWorldInfoList, loadWorldInfo, importWorldInfo } from './world-info.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';

export function createWorldLibrary(selectCategory) {
    const panel = document.createElement('section');
    panel.id = 'nw-world-library'; panel.className = 'nw-story-settings-panel'; panel.hidden = true;
    document.body.append(panel);
    let revision = 0, selected = '', query = '', limit = 30;
    const el = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
    const button = (text, action) => { const node = el('button', text); node.onclick = action; return node; };
    async function render() {
        const request = ++revision;
        panel.replaceChildren(el('p', '正在读取本地世界书…'));
        try {
            await updateWorldInfoList();
            const context = getContext(), marker = context.chatMetadata?.novel_world_compiler;
            if (!world_names.includes(selected)) selected = marker?.world_id || world_names[0] || '';
            const data = selected ? await loadWorldInfo(selected) : null;
            if (request !== revision || panel.hidden) return;
            panel.replaceChildren();
            panel.append(el('p', '独立查看世界资料。明确采用的外来资料仅影响当前会话；原工程资料保留。'));
            const select = el('select'); select.setAttribute('aria-label', '选择独立世界书');
            for (const name of world_names) { const option = el('option', name); option.value = name; select.append(option); }
            select.value = selected; select.onchange = () => { selected = select.value; query = ''; limit = 30; void render(); };
            panel.append(select);
            const file = el('input'); file.type = 'file'; file.accept = '.json,.png'; file.setAttribute('aria-label', '导入独立世界书');
            file.onchange = async () => { if (!file.files?.[0]) return; file.disabled = true; try { await importWorldInfo(file.files[0]); await render(); } finally { file.disabled = false; } };
            panel.append(file);
            const status = el('p'); status.setAttribute('role', 'status');
            if (marker?.world_id) {
                const adopted = (marker.extra_worlds ?? []).includes(selected);
                panel.append(el('p', selected === marker.world_id ? '这是本书基础世界书。' : adopted ? '已明确用于当前会话。' : '尚未用于当前会话。'));
                if (selected && selected !== marker.world_id) panel.append(button(adopted ? '停止用于本会话' : '用于本会话', async event => {
                    const control = event.currentTarget; control.disabled = true;
                    const chatId = context.chatId;
                    try {
                        if (isGenerating()) throw new Error('请等待本轮生成结束后再调整世界资料。');
                        const confirmed = await callGenericPopup(adopted
                            ? '停止采用这本外来世界书？已有聊天和世界书文件保留。'
                            : '采用后，这本外来世界书将参与当前会话，可能改变原著设定。已有聊天不变；它不受原著阅读位置审核。确认采用？',
                        POPUP_TYPE.CONFIRM, '', { okButton: adopted ? '停止采用' : '确认采用', cancelButton: '取消' });
                        if (!confirmed) return;
                        if (getContext().chatId !== chatId || getContext().chatMetadata.novel_world_compiler !== marker) throw new Error('会话已切换，请在目标会话中重试。');
                        if (!adopted && !data?.entries) throw new Error('这本世界书无法读取。');
                        const previous = marker.extra_worlds ?? [];
                        marker.extra_worlds = adopted ? previous.filter(name => name !== selected) : [...new Set([...previous, selected])];
                        try { await context.saveChat({ throwOnError: true, expectedChatId: context.chatId }); }
                        catch (error) { marker.extra_worlds = previous; throw error; }
                        await render();
                    } catch (error) { status.textContent = error.message || '保存失败，请重试。'; }
                    finally { control.disabled = false; }
                }));
                panel.append(el('small', `本会话额外采用：${(marker.extra_worlds ?? []).join('、') || '无'}`));
            }
            panel.append(status);
            panel.append(button('打开完整世界书编辑器', () => {
                selectCategory('WI-SP-button');
                const index = world_names.indexOf(selected);
                if (index >= 0) window.$('#world_editor_select').val(index).trigger('change');
            }));
            const search = el('input'); search.type = 'search'; search.placeholder = '搜索标题、关键词或资料内容'; search.value = query;
            search.setAttribute('aria-label', '搜索世界书条目');
            const list = el('div'); list.className = 'nw-world-entries';
            const count = el('p');
            const draw = () => {
                query = search.value;
                const matches = Object.values(data?.entries ?? {}).filter(entry =>
                    [entry.comment, entry.content, ...(entry.key ?? [])].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
                list.replaceChildren(); count.textContent = `${matches.length} 条匹配资料`;
                for (const entry of matches.slice(0, limit)) {
                    const details = el('details'); details.append(el('summary', entry.comment || (entry.key ?? []).join('、') || '未命名条目'));
                    const content = el('p', entry.content || '空条目'); content.style.whiteSpace = 'pre-wrap';
                    details.append(el('small', entry.disable ? '已停用' : entry.constant ? '常驻条目' : '按关键词调取'), content); list.append(details);
                }
                if (matches.length > limit) list.append(button('再显示 30 条', () => { limit += 30; draw(); }));
            };
            search.oninput = () => { limit = 30; draw(); }; panel.append(search, count, list); draw();
        } catch (error) { if (request === revision) panel.replaceChildren(el('p', `读取失败：${error.message}`), button('重试', render)); }
    }
    return { show(id) { panel.hidden = id !== 'nw-world-library'; if (!panel.hidden) void render(); else revision += 1; return !panel.hidden; }, hide() { panel.hidden = true; revision += 1; } };
}
