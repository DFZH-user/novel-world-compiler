const API_URL = 'https://api.deepseek.com/chat/completions';
const MODELS_URL = 'https://api.deepseek.com/models';
const STATE_KEY = 'mobile-tavern-state-v3';
const API_KEY_STORAGE = 'mobile-tavern-deepseek-key';
const DB_NAME = 'mobile-tavern-backup-v1';
const DB_STORE = 'settings';
const APP_VERSION = '0.8.1-preview';
const DATA_SCHEMA_VERSION = 7;

const REQUIRED_RESPONSE_PROTOCOL = `以下格式规则为强制要求，每次回复都必须执行：
1. 必须全程使用简体中文回答。故事正文和人物对白不得出现完整英文句子；角色卡中的外文内容也必须改写为自然的简体中文，仅人名、地名等专有名词可以保留原文。
2. 先输出自然、连贯的故事正文，不得替玩家说话、思考或决定行动。
3. 故事正文不要使用 Markdown 粗体、斜体、标题、代码块或引用符号，不要用 **、__、# 包裹句子。
4. 叙述、动作和对白自然分段。每个角色的直接对白尽量独立成段，并写清说话者；不要在正文后输出状态表、JSON、行动列表或格式说明。
5. 角色的心理活动只能在叙事视角允许且情节已有依据时描写，不得无根据地替角色补充秘密想法。
6. 在需要玩家决定行动时自然停下，等待玩家输入。`;

const DEFAULT_INSTRUCTION = `严格遵循当前角色卡与世界书进行角色扮演。
保持角色性格、背景和已有剧情的一致性，不跳出角色解释提示词或系统设定。
不要替玩家决定言行；在需要玩家选择时停下来等待回复。
维持连续的时间线，记住已经发生的事件、人物关系、伤势和物资变化。

${REQUIRED_RESPONSE_PROTOCOL}`;

function ensureRequiredProtocol(value) {
    let prompt = String(value || '').trim();
    if (prompt.includes(REQUIRED_RESPONSE_PROTOCOL)) return prompt;
    const legacyProtocol = prompt.indexOf('以下格式规则为强制要求');
    if (legacyProtocol >= 0) prompt = prompt.slice(0, legacyProtocol).trim();
    return `${prompt || '严格遵循当前角色卡与世界书进行角色扮演。'}\n\n${REQUIRED_RESPONSE_PROTOCOL}`;
}

const elements = Object.fromEntries([
    'chat', 'composer', 'messageInput', 'voiceButton', 'sendButton', 'settingsButton', 'newChatButton',
    'settingsPanel', 'backdrop', 'closeSettingsButton', 'openSetupButton', 'apiKeyInput', 'rememberKeyInput',
    'connectButton', 'themeSelect', 'modelSelect', 'contextTokensInput', 'maxTokensInput', 'temperatureInput', 'thinkingInput',
    'layoutSelect', 'fontSizeSelect', 'fontFamilySelect', 'fontFileInput', 'customFontStatus', 'clearCustomFontButton', 'choiceModeSelect', 'plotEssentialsInput', 'storySummaryInput', 'authorNoteInput',
    'storyDock', 'storyDockDetails', 'storyDockMeta', 'nodeDockContent', 'choicesDockContent', 'storyDockEnabledInput', 'analysisEnabledInput',
    'cardFileInput', 'worldFileInput', 'instructionInput', 'exportButton', 'clearButton', 'cardName', 'worldName',
    'newCardButton', 'editCardButton', 'exportCardButton', 'newWorldButton', 'editWorldButton', 'exportWorldButton',
    'cardEditorDialog', 'cardEditorTitle', 'cancelCardEditorButton', 'cardEditorName', 'cardEditorDescription',
    'cardAvatarPreview', 'cardAvatarFileInput', 'clearCardAvatarButton',
    'cardEditorPersonality', 'cardEditorScenario', 'cardEditorFirstMessage', 'cardEditorExample',
    'cardEditorSystemPrompt', 'cardEditorPostHistory', 'saveCardButton',
    'worldEditorDialog', 'worldEditorTitle', 'cancelWorldEditorButton', 'worldEditorName', 'worldEntriesEditor',
    'addWorldEntryButton', 'saveWorldButton', 'contextUsage', 'characterTitle', 'chapterStatus', 'statusDot', 'statusText',
    'inspectPromptButton', 'promptInspectorDialog', 'closePromptInspectorButton', 'promptInspectorContent',
    'exportAllButton', 'backupFileInput', 'toast',
].map(id => [id, document.getElementById(id)]));

const initial = loadStoredState();
const rememberedKey = localStorage.getItem(API_KEY_STORAGE) || '';
const state = {
    apiKey: rememberedKey,
    rememberKey: initial.rememberKey ?? true,
    theme: initial.theme || 'midnight',
    layout: ['document', 'bubbles'].includes(initial.layout) ? initial.layout : 'document',
    fontSize: Number(initial.fontSize) || 17,
    fontFamily: initial.fontFamily || 'system',
    customFontName: initial.customFontName || '',
    choiceMode: initial.choiceMode || 'fill',
    model: initial.model || 'deepseek-v4-flash',
    contextTokens: initial.contextTokens || 100000,
    maxTokens: initial.maxTokens || 4096,
    temperature: Number.isFinite(initial.temperature) ? initial.temperature : 1,
    thinking: Boolean(initial.thinking),
    instruction: ensureRequiredProtocol(initial.instruction || DEFAULT_INSTRUCTION),
    plotEssentials: initial.plotEssentials || '',
    storySummary: initial.storySummary || '',
    authorNote: initial.authorNote || '',
    card: initial.card || null,
    cardAvatar: initial.cardAvatar || '',
    world: initial.world || null,
    messages: Array.isArray(initial.messages) ? initial.messages : [],
    currentNode: initial.currentNode || null,
    currentChoices: Array.isArray(initial.currentChoices) ? initial.currentChoices : [],
    storyDockEnabled: initial.storyDockEnabled ?? true,
    analysisEnabled: initial.analysisEnabled ?? true,
    storyDockOpen: initial.storyDockOpen ?? false,
    updatedAt: Number(initial.updatedAt) || 0,
    busy: false,
    analysisBusy: false,
};

function loadStoredState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY)) || {}; }
    catch { return {}; }
}

function snapshotState() {
    return {
        rememberKey: state.rememberKey,
        theme: state.theme,
        layout: state.layout,
        fontSize: state.fontSize,
        fontFamily: state.fontFamily,
        customFontName: state.customFontName,
        choiceMode: state.choiceMode,
        model: state.model,
        contextTokens: state.contextTokens,
        maxTokens: state.maxTokens,
        temperature: state.temperature,
        thinking: state.thinking,
        instruction: state.instruction,
        plotEssentials: state.plotEssentials,
        storySummary: state.storySummary,
        authorNote: state.authorNote,
        card: state.card,
        cardAvatar: state.cardAvatar,
        world: state.world,
        messages: state.messages,
        currentNode: state.currentNode,
        currentChoices: state.currentChoices,
        storyDockEnabled: state.storyDockEnabled,
        analysisEnabled: state.analysisEnabled,
        storyDockOpen: state.storyDockOpen,
        schemaVersion: DATA_SCHEMA_VERSION,
        appVersion: APP_VERSION,
        updatedAt: state.updatedAt,
    };
}

function saveState() {
    state.updatedAt = Date.now();
    const safeState = snapshotState();
    try { localStorage.setItem(STATE_KEY, JSON.stringify(safeState)); }
    catch { toast('手机存储空间不足，请导出聊天后清理旧数据'); }
    saveBackup({ ...safeState, apiKey: state.rememberKey ? state.apiKey : '' }).catch(() => {});
}

function openBackupDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function saveBackup(value) {
    const database = await openBackupDatabase();
    await new Promise((resolve, reject) => {
        const transaction = database.transaction(DB_STORE, 'readwrite');
        transaction.objectStore(DB_STORE).put(value, 'snapshot');
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
    });
    database.close();
}

async function readBackup() {
    const database = await openBackupDatabase();
    const value = await new Promise((resolve, reject) => {
        const request = database.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get('snapshot');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    database.close();
    return value;
}

async function writeDatabaseValue(key, value) {
    const database = await openBackupDatabase();
    await new Promise((resolve, reject) => {
        const transaction = database.transaction(DB_STORE, 'readwrite');
        transaction.objectStore(DB_STORE).put(value, key);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
    });
    database.close();
}

async function readDatabaseValue(key) {
    const database = await openBackupDatabase();
    const value = await new Promise((resolve, reject) => {
        const request = database.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    database.close();
    return value;
}

async function deleteDatabaseValue(key) {
    const database = await openBackupDatabase();
    await new Promise((resolve, reject) => {
        const transaction = database.transaction(DB_STORE, 'readwrite');
        transaction.objectStore(DB_STORE).delete(key);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
    });
    database.close();
}

async function clearBackup() {
    const database = await openBackupDatabase();
    await new Promise((resolve, reject) => {
        const transaction = database.transaction(DB_STORE, 'readwrite');
        transaction.objectStore(DB_STORE).clear();
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
    });
    database.close();
}

async function restoreFromBackup() {
    try {
        const backup = await readBackup();
        if (!backup || Number(backup.updatedAt) <= state.updatedAt) {
            saveState();
            return;
        }
        for (const key of ['rememberKey', 'theme', 'layout', 'fontSize', 'fontFamily', 'customFontName', 'choiceMode', 'model', 'contextTokens', 'maxTokens', 'temperature', 'thinking', 'plotEssentials', 'storySummary', 'authorNote', 'card', 'cardAvatar', 'world', 'messages', 'currentNode', 'currentChoices', 'storyDockEnabled', 'analysisEnabled', 'storyDockOpen', 'updatedAt']) {
            if (backup[key] !== undefined) state[key] = backup[key];
        }
        state.instruction = ensureRequiredProtocol(backup.instruction || DEFAULT_INSTRUCTION);
        if (state.rememberKey && backup.apiKey) {
            state.apiKey = backup.apiKey;
            localStorage.setItem(API_KEY_STORAGE, backup.apiKey);
        }
        migrateMessages();
        syncForm();
        render();
        saveState();
        toast('已恢复上次保存的角色、世界书和设置');
    } catch {
        try { localStorage.setItem(STATE_KEY, JSON.stringify(snapshotState())); } catch { /* private browsing */ }
    }
}

function syncForm() {
    if (!['document', 'bubbles'].includes(state.layout)) state.layout = 'document';
    elements.apiKeyInput.value = state.apiKey;
    elements.rememberKeyInput.checked = state.rememberKey;
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.dataset.layout = state.layout;
    document.documentElement.style.setProperty('--chat-font-size', `${state.fontSize}px`);
    syncCustomFontControls();
    applyFontFamily();
    elements.themeSelect.value = state.theme;
    elements.layoutSelect.value = state.layout;
    elements.fontSizeSelect.value = String(state.fontSize);
    elements.fontFamilySelect.value = state.fontFamily;
    elements.choiceModeSelect.value = state.choiceMode;
    elements.storyDockEnabledInput.checked = state.storyDockEnabled;
    elements.analysisEnabledInput.checked = state.analysisEnabled;
    elements.modelSelect.value = state.model;
    elements.contextTokensInput.value = state.contextTokens;
    elements.maxTokensInput.value = state.maxTokens;
    elements.temperatureInput.value = state.temperature;
    elements.thinkingInput.checked = state.thinking;
    elements.instructionInput.value = state.instruction;
    elements.plotEssentialsInput.value = state.plotEssentials;
    elements.storySummaryInput.value = state.storySummary;
    elements.authorNoteInput.value = state.authorNote;
    elements.cardName.textContent = cardData()?.name || '未导入';
    elements.worldName.textContent = state.world?.name || state.world?.data?.name || (state.world ? '已导入世界书' : '未导入');
    elements.characterTitle.textContent = cardData()?.name || '移动酒馆';
    updateChapterStatus();
    updateContextUsage();
    setStatus(state.apiKey ? '已就绪' : '等待 API 密钥', state.apiKey ? 'online' : '');
}

const FONT_PRESETS = {
    system: { family: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', spacing: 'normal' },
    song: { family: 'ui-serif, "Songti SC", "STSong", "SimSun", serif', spacing: '.015em' },
    kai: { family: '"Kaiti SC", "STKaiti", "KaiTi", "DFKai-SB", cursive', spacing: '.025em' },
    mono: { family: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace', spacing: 'normal' },
    custom: { family: '"Mobile Tavern Custom", ui-serif, serif', spacing: 'normal' },
};

let activeCustomFontFace = null;

function syncCustomFontControls() {
    let option = elements.fontFamilySelect.querySelector('option[value="custom"]');
    if (state.customFontName) {
        if (!option) {
            option = document.createElement('option');
            option.value = 'custom';
            elements.fontFamilySelect.append(option);
        }
        option.textContent = `已导入 · ${state.customFontName}`;
        elements.customFontStatus.textContent = `已保存在本机：${state.customFontName}`;
        elements.clearCustomFontButton.hidden = false;
    } else {
        option?.remove();
        elements.customFontStatus.textContent = '支持 TTF、OTF、WOFF、WOFF2，导入后保存在本机。';
        elements.clearCustomFontButton.hidden = true;
        if (state.fontFamily === 'custom') state.fontFamily = 'system';
    }
}

function applyFontFamily() {
    if (!FONT_PRESETS[state.fontFamily] || (state.fontFamily === 'custom' && !state.customFontName)) state.fontFamily = 'system';
    const preset = FONT_PRESETS[state.fontFamily];
    document.documentElement.style.setProperty('--story-font', preset.family);
    document.documentElement.style.setProperty('--story-letter-spacing', preset.spacing);
}

async function activateCustomFont(record) {
    if (!(record?.blob instanceof Blob)) throw new Error('字体数据已损坏');
    const buffer = await record.blob.arrayBuffer();
    const face = new FontFace('Mobile Tavern Custom', buffer);
    await face.load();
    if (activeCustomFontFace) document.fonts.delete(activeCustomFontFace);
    document.fonts.add(face);
    activeCustomFontFace = face;
    state.customFontName = String(record.name || '自定义字体');
    syncCustomFontControls();
}

async function importCustomFont(file) {
    if (!file) return;
    try {
        if (!/\.(ttf|otf|woff2?)$/i.test(file.name)) throw new Error('请选择 TTF、OTF、WOFF 或 WOFF2 字体文件');
        if (file.size > 40 * 1024 * 1024) throw new Error('字体文件不能超过 40MB');
        const record = { name: file.name, type: file.type || '', size: file.size, blob: file, updatedAt: Date.now() };
        await activateCustomFont(record);
        await writeDatabaseValue('custom-font', record);
        state.fontFamily = 'custom';
        syncCustomFontControls();
        elements.fontFamilySelect.value = 'custom';
        applyFontFamily();
        saveState();
        toast(`已导入并启用字体：${file.name}`);
    } catch (error) {
        toast(`字体导入失败：${error.message}`);
    } finally {
        elements.fontFileInput.value = '';
    }
}

async function restoreCustomFont() {
    try {
        const record = await readDatabaseValue('custom-font');
        if (!record) {
            if (state.fontFamily === 'custom') {
                state.fontFamily = 'system';
                state.customFontName = '';
                syncForm();
                saveState();
            }
            return;
        }
        await activateCustomFont(record);
        if (state.fontFamily === 'custom') applyFontFamily();
        syncCustomFontControls();
        elements.fontFamilySelect.value = state.fontFamily;
    } catch {
        state.customFontName = '';
        if (state.fontFamily === 'custom') state.fontFamily = 'system';
        syncForm();
        saveState();
        toast('上次导入的字体无法读取，已恢复系统字体');
    }
}

async function clearCustomFont() {
    if (!state.customFontName || !confirm(`移除已导入字体“${state.customFontName}”吗？`)) return;
    try {
        await deleteDatabaseValue('custom-font');
        if (activeCustomFontFace) document.fonts.delete(activeCustomFontFace);
        activeCustomFontFace = null;
        state.customFontName = '';
        if (state.fontFamily === 'custom') state.fontFamily = 'system';
        syncCustomFontControls();
        applyFontFamily();
        elements.fontFamilySelect.value = state.fontFamily;
        saveState();
        toast('已移除导入字体');
    } catch (error) {
        toast(`移除字体失败：${error.message}`);
    }
}

function setStatus(text, kind = '') {
    elements.statusText.textContent = text;
    elements.statusDot.className = `status-dot ${kind}`.trim();
}

let toastTimer;
function toast(message) {
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3200);
}

function openSettings() {
    elements.settingsPanel.classList.add('open');
    elements.settingsPanel.setAttribute('aria-hidden', 'false');
    elements.backdrop.hidden = false;
}

function closeSettings() {
    elements.settingsPanel.classList.remove('open');
    elements.settingsPanel.setAttribute('aria-hidden', 'true');
    elements.backdrop.hidden = true;
}

function cardData() {
    return state.card?.data || state.card || null;
}

function expandMacros(value) {
    return String(value || '').replaceAll('{{char}}', cardData()?.name || '角色').replaceAll('{{user}}', '玩家');
}

function cleanNarrativeMarkdown(value) {
    return String(value || '')
        .replace(/\*\*([\s\S]*?)\*\*/g, '$1')
        .replace(/__([\s\S]*?)__/g, '$1')
        .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/\*\*/g, '')
        .replace(/__/g, '')
        .trim();
}

function needsChineseRewrite(value) {
    const text = cleanNarrativeMarkdown(value);
    const chineseCount = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) || []).length;
    const englishWords = (text.match(/\b[A-Za-z]{3,}\b/g) || []).length;
    return englishWords >= 6 && (chineseCount < 24 || englishWords * 3 > chineseCount);
}

async function rewriteResponseInChinese(value) {
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: state.model,
            messages: [
                { role: 'system', content: buildRawApiMessages()[0].content },
                { role: 'user', content: `下面这段故事违反了简体中文规则。请保持原有事实、情节和人物语气，将所有英文叙述与对白完整重写为自然的简体中文。不要添加状态表、JSON或行动列表，只输出重写后的故事正文。\n\n原回复：\n${value}` },
            ],
            max_tokens: state.maxTokens,
            temperature: Math.min(state.temperature, 0.5),
            stream: false,
            thinking: { type: 'disabled' },
        }),
    });
    if (!response.ok) throw new Error(await apiError(response));
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || value;
}

function isDirectDialogue(paragraph) {
    return /^(?:[-—]\s*)?(?:[^。！？\n]{1,18}[：:]\s*)?[“"「『]/.test(paragraph.trimStart());
}

const SPEECH_VERB_PATTERN = '(?:低声|沉声|轻声|大声|冷冷地|急忙|缓缓|小声)?(?:说|问|喊|叫|道|答|提醒|低语|嘀咕|命令|回应|解释|补充)';
const ATTRIBUTION_ACTION_PATTERN = /(?:低声|沉声|轻声|大声|冷冷地|急忙|缓缓|小声|突然|转身|转头|回头|看着|望着|盯着|握紧|抬起|放下|皱眉|点头|摇头|笑着|叹气|压低声音)/u;

function speakerFromAttribution(value) {
    const raw = String(value || '').trim();
    const text = raw.replace(/[。.!！?？,，:：]+$/u, '');
    if (!text) return '';
    const spoken = text.match(new RegExp(`^(.{1,36}?)${SPEECH_VERB_PATTERN}$`, 'u'));
    if (spoken) {
        const attribution = spoken[1].trim().replace(/[，,]\s*$/u, '');
        const actionStart = attribution.search(ATTRIBUTION_ACTION_PATTERN);
        const speaker = (actionStart > 0 ? attribution.slice(0, actionStart) : attribution).trim();
        if (/^[\p{Script=Han}A-Za-z0-9·_-]{1,16}$/u.test(speaker)) return speaker;
    }
    const direct = raw.match(/^([\p{Script=Han}A-Za-z0-9·_-]{1,16})\s*[：:]$/u);
    if (direct) return direct[1];
    return '';
}

function parseCharacterSpeech(paragraph) {
    const text = paragraph.trim();
    const quotePairs = [['“', '”'], ['「', '」'], ['『', '』'], ['"', '"']];
    let opening = '';
    let closing = '';
    let start = -1;
    let end = -1;
    for (const [open, close] of quotePairs) {
        const candidateStart = text.indexOf(open);
        if (candidateStart < 0) continue;
        const candidateEnd = text.indexOf(close, candidateStart + 1);
        if (candidateEnd > candidateStart) {
            opening = open;
            closing = close;
            start = candidateStart;
            end = candidateEnd;
            break;
        }
    }
    if (start < 0 || end < 0) return null;
    const before = text.slice(0, start).trim();
    const after = text.slice(end + closing.length).trim();
    let speaker = speakerFromAttribution(before) || speakerFromAttribution(after);
    if (!speaker && start !== 0) return null;
    if (!speaker) speaker = cardData()?.name || '角色';
    const context = [];
    if (before && speakerFromAttribution(before)) {
        const clauses = before.replace(/[：:]$/u, '').split(/[，,]/u);
        if (clauses.length > 1) context.push(`${clauses.slice(0, -1).join('，')}。`);
    } else if (before) context.push(before);
    if (after && !speakerFromAttribution(after)) context.push(after);
    return { speaker, speech: text.slice(start + opening.length, end).trim(), context: context.filter(Boolean) };
}

function createSpeechAvatar(speaker) {
    const avatar = document.createElement('div');
    avatar.className = 'speech-avatar';
    avatar.style.setProperty('--avatar-hue', String(nameHue(speaker)));
    if (state.cardAvatar && speaker === (cardData()?.name || '角色')) {
        const image = document.createElement('img');
        image.src = state.cardAvatar;
        image.alt = '';
        avatar.append(image);
    } else {
        avatar.textContent = speaker.slice(0, 1).toUpperCase();
    }
    return avatar;
}

function appendNormalParagraph(container, textContent, dialogue = false) {
    const paragraph = document.createElement('p');
    paragraph.className = `story-paragraph${dialogue ? ' dialogue' : ''}`;
    paragraph.textContent = textContent;
    container.append(paragraph);
}

function appendCharacterSpeech(container, parsed) {
    for (const context of parsed.context || []) appendNormalParagraph(container, context);
    const row = document.createElement('div');
    row.className = 'character-speech';
    const content = document.createElement('div');
    content.className = 'speech-content';
    const name = document.createElement('span');
    name.className = 'speech-name';
    name.textContent = parsed.speaker;
    const bubble = document.createElement('div');
    bubble.className = 'speech-bubble';
    const speechText = document.createElement('div');
    speechText.className = 'speech-text';
    speechText.textContent = parsed.speech;
    bubble.append(speechText);
    if (parsed.aside) {
        const aside = document.createElement('div');
        aside.className = 'speech-aside';
        aside.textContent = `（${parsed.aside.replace(/^[（(]|[）)]$/gu, '')}）`;
        bubble.append(aside);
    }
    content.append(name, bubble);
    row.append(createSpeechAvatar(parsed.speaker), content);
    container.append(row);
}

function renderStoryText(container, value, structuredSegments = []) {
    const text = cleanNarrativeMarkdown(value);
    const paragraphs = text.split(/\n+/).map(item => item.trim()).filter(Boolean);
    if (!paragraphs.length) {
        container.textContent = '';
        return;
    }
    if (state.layout === 'bubbles' && Array.isArray(structuredSegments) && structuredSegments.length) {
        for (const segment of structuredSegments) {
            if (segment.type === 'speech' && segment.text && segment.speaker) {
                appendCharacterSpeech(container, { speaker: segment.speaker, speech: segment.text, aside: segment.aside || '', context: [] });
            } else if (segment.text) {
                appendNormalParagraph(container, segment.text);
            }
        }
        return;
    }
    for (const textContent of paragraphs) {
        const speech = state.layout === 'bubbles' ? parseCharacterSpeech(textContent) : null;
        if (speech?.speech) appendCharacterSpeech(container, speech);
        else appendNormalParagraph(container, textContent, isDirectDialogue(textContent));
    }
}

function render() {
    updateContextUsage();
    updateChapterStatus();
    elements.chat.replaceChildren();
    if (!state.messages.length) {
        renderStoryDock();
        const welcome = document.createElement('section');
        welcome.className = 'welcome-card';
        welcome.innerHTML = '<span class="eyebrow">MOBILE TAVERN</span><h1>创建你的故事</h1><p>打开设置，填入 API 密钥，然后创建或导入任意角色卡与世界书。</p>';
        const button = document.createElement('button');
        button.className = 'primary-button';
        button.textContent = '打开设置';
        button.addEventListener('click', openSettings);
        welcome.append(button);
        elements.chat.append(welcome);
        return;
    }

    let latestAssistant = -1;
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
        if (state.messages[index].role === 'assistant') { latestAssistant = index; break; }
    }
    state.messages.forEach((message, index) => elements.chat.append(createMessageElement(message, index, index === latestAssistant)));
    renderStoryDock();
    requestAnimationFrame(() => { elements.chat.scrollTop = elements.chat.scrollHeight; });
}

function createMessageElement(message, index, isLatestAssistant) {
    const article = document.createElement('article');
    article.className = `message ${message.role}${message.pending ? ' pending' : ''}`;
    const displayName = message.role === 'user' ? '你' : (cardData()?.name || '角色');
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.style.setProperty('--avatar-hue', String(nameHue(displayName)));
    if (message.role === 'assistant' && state.cardAvatar) {
        const image = document.createElement('img');
        image.src = state.cardAvatar;
        image.alt = '';
        avatar.append(image);
    } else {
        avatar.textContent = displayName.slice(0, 1).toUpperCase();
    }
    const content = document.createElement('div');
    content.className = 'message-content';
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const name = document.createElement('strong');
    name.textContent = displayName;
    const time = document.createElement('span');
    time.textContent = message.time || '';
    meta.append(name, time);
    const body = document.createElement('div');
    body.className = 'message-body';
    if (message.role === 'assistant') renderStoryText(body, message.content, message.segments);
    else body.textContent = message.content;
    content.append(meta, body);
    if (!message.pending) content.append(createMessageActions(message, index, isLatestAssistant));
    article.append(avatar, content);
    return article;
}

function nameHue(value) {
    let hash = 0;
    for (const char of String(value || '角色')) hash = ((hash << 5) - hash + char.codePointAt(0)) | 0;
    return Math.abs(hash) % 360;
}

const ICONS = {
    node: '<path d="m12 3 1.9 3.9L18 9l-4.1 2.1L12 15l-1.9-3.9L6 9l4.1-2.1L12 3Z"/><path d="M5 3v4M3 5h4M19 17v4M17 19h4"/>',
    time: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    location: '<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    player: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
    inventory: '<path d="M6 8h12l2 13H4L6 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    npcs: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    quest: '<path d="M5 22V4"/><path d="M5 5h12l-2 4 2 4H5"/>',
    danger: '<path d="M10.3 3.7 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    changes: '<path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/>',
    choices: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2"/>',
    copy: '<rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
    regenerate: '<path d="M20 11a8.1 8.1 0 1 0 .5 4"/><path d="M20 4v7h-7"/>',
    continue: '<path d="m8 5 7 7-7 7"/><path d="m14 5 7 7-7 7"/>',
};

function svgIcon(name) {
    const wrapper = document.createElement('span');
    wrapper.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.node}</svg>`;
    return wrapper.firstElementChild;
}

function createNodeGrid(node, previousNode = null) {
    const grid = document.createElement('div');
    grid.className = 'node-grid';
    const fields = [
        ['time', '时间', 'time'], ['location', '地点', 'location'], ['player', '状态', 'player'],
        ['inventory', '物资', 'inventory'], ['npcs', '人物', 'npcs'], ['quest', '目标', 'quest'],
        ['danger', '危险', 'danger'], ['changes', '变化', 'changes'],
    ];
    for (const [key, label, icon] of fields) {
        if (!node[key]) continue;
        const row = document.createElement('div');
        row.className = 'node-row';
        if (previousNode && cleanAnalysisText(previousNode[key]) !== cleanAnalysisText(node[key])) row.classList.add('changed');
        const keyLabel = document.createElement('b');
        keyLabel.textContent = label;
        const value = document.createElement('span');
        value.textContent = node[key];
        row.append(svgIcon(icon), keyLabel, value);
        grid.append(row);
    }
    return grid;
}

function createChoiceButtons(choices, active = true) {
    const list = document.createElement('div');
    list.className = 'choice-list';
    choices.slice(0, 5).forEach((choice, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'choice-button';
        button.disabled = !active;
        const number = document.createElement('span');
        number.className = 'choice-number';
        number.textContent = String(index + 1).padStart(2, '0');
        const copy = document.createElement('span');
        copy.className = 'choice-copy';
        const title = document.createElement('strong');
        title.textContent = choice.title;
        copy.append(title);
        if (choice.detail) {
            const detail = document.createElement('small');
            detail.textContent = choice.detail;
            copy.append(detail);
        }
        button.append(number, copy);
        if (active) button.addEventListener('click', () => selectChoice(choice));
        list.append(button);
    });
    if (active) {
        const free = document.createElement('button');
        free.type = 'button';
        free.className = 'choice-button free-action';
        const number = document.createElement('span');
        number.className = 'choice-number';
        number.textContent = '＋';
        const copy = document.createElement('span');
        copy.className = 'choice-copy';
        const title = document.createElement('strong');
        title.textContent = '自由行动';
        copy.append(title);
        free.append(number, copy);
        free.addEventListener('click', () => {
            elements.messageInput.focus();
            toast('可以输入任何其他行动');
        });
        list.append(free);
    }
    return list;
}

function latestAssistantMessage() {
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
        if (state.messages[index].role === 'assistant') return state.messages[index];
    }
    return null;
}

function dockStatusContent(title, detail, failed = false) {
    const wrapper = document.createElement('div');
    wrapper.className = `dock-status${failed ? ' failed' : ''}`;
    const heading = document.createElement('strong');
    heading.textContent = title;
    const copy = document.createElement('p');
    copy.className = 'dock-empty';
    copy.textContent = detail;
    wrapper.append(heading, copy);
    return wrapper;
}

function renderStoryDock() {
    const hasAssistant = state.messages.some(message => message.role === 'assistant');
    const visible = state.storyDockEnabled && hasAssistant;
    elements.storyDock.hidden = !visible;
    if (!visible) return;
    const latest = latestAssistantMessage();
    const latestIndex = latest ? state.messages.lastIndexOf(latest) : -1;
    const previousNode = latestIndex >= 0 ? previousNodeBefore(latestIndex) : null;
    const node = state.currentNode;
    const choices = state.currentChoices;
    elements.storyDockDetails.open = state.storyDockOpen;
    if (latest?.pending) elements.storyDockMeta.textContent = '故事生成中…';
    else if (state.analysisBusy) elements.storyDockMeta.textContent = '正在结算本回合…';
    else if (latest?.analysisError) elements.storyDockMeta.textContent = `${node?.location || '节点未更新'} · 结算失败`;
    else if (node) elements.storyDockMeta.textContent = `${node.location || '地点未记录'} · ${choices.length} 个行动`;
    else elements.storyDockMeta.textContent = state.analysisEnabled ? '等待首次剧情结算' : '智能结算已关闭';

    if (node) elements.nodeDockContent.replaceChildren(createNodeGrid(node, previousNode));
    else elements.nodeDockContent.replaceChildren(dockStatusContent('尚无有效节点', state.analysisBusy ? '正在从本回合故事提取时间、地点、人物与物资。' : '完成一次智能剧情结算后会在这里显示。'));

    if (choices.length) {
        elements.choicesDockContent.replaceChildren(createChoiceButtons(choices, !state.busy));
        return;
    }
    const content = document.createDocumentFragment();
    if (latest?.pending) {
        content.append(dockStatusContent('等待本回合故事完成', '故事完成后会立即生成新的场景行动。'));
    } else if (state.analysisBusy) {
        content.append(dockStatusContent('正在生成场景行动', '行动会引用当前人物、物品、路线和危险。'));
    } else if (latest?.analysisError) {
        const status = dockStatusContent('本回合结算失败', '旧节点已保留，没有使用固定假选项。可以重新分析本回合。', true);
        if (state.apiKey && state.analysisEnabled) {
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'dock-retry';
            retry.textContent = '重新分析本回合';
            retry.disabled = state.busy;
            retry.addEventListener('click', retryLatestAnalysis);
            status.append(retry);
        }
        content.append(status);
    } else {
        content.append(dockStatusContent(state.analysisEnabled ? '尚无可选行动' : '智能剧情结算已关闭', state.analysisEnabled ? '完成本回合结算后会生成场景专属行动。' : '可以继续自由输入，或在故事设置中重新开启。'));
    }
    if (!state.busy) content.append(createChoiceButtons([], true));
    elements.choicesDockContent.replaceChildren(content);
}

function selectChoice(choice) {
    const text = choice.title;
    if (state.choiceMode === 'send') {
        elements.messageInput.value = text;
        elements.composer.requestSubmit();
        return;
    }
    elements.messageInput.value = text;
    resizeComposer();
    elements.messageInput.focus();
    toast('已填入输入框，可以修改后发送');
}

function createMessageActions(message, index, latestAssistant) {
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    actions.append(actionButton('copy', '复制', () => copyMessage(message)));
    actions.append(actionButton('edit', '编辑', () => editMessage(index)));
    if (message.role === 'assistant' && latestAssistant) {
        actions.append(actionButton('regenerate', '重新生成', regenerateLast));
        actions.append(actionButton('continue', '继续推进', continueStory));
    }
    return actions;
}

function actionButton(icon, label, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-action';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.append(svgIcon(icon));
    button.addEventListener('click', handler);
    return button;
}

async function copyMessage(message) {
    try {
        await navigator.clipboard.writeText(message.role === 'assistant' ? cleanNarrativeMarkdown(message.content) : message.content);
        toast('消息已复制');
    } catch { toast('复制失败，请长按文字复制'); }
}

function editMessage(index) {
    const message = state.messages[index];
    const revised = prompt('编辑消息', message.content);
    if (revised === null || !revised.trim()) return;
    message.content = message.role === 'assistant' ? cleanNarrativeMarkdown(revised) : revised.trim();
    saveState();
    render();
}

function updateChapterStatus() {
    if (!elements.chapterStatus) return;
    const turns = state.messages.filter(message => message.role === 'assistant').length;
    const location = state.currentNode?.location;
    elements.chapterStatus.textContent = turns ? `第 ${turns} 回合${location ? ` · ${location}` : ''}` : '尚未开始';
}

function parseAssistantResponse(raw) {
    let narrative = String(raw || '').trim();
    let node = null;
    let choices = [];
    const stateMatch = narrative.match(/\[STATE\]([\s\S]*?)\[\/STATE\]/i);
    if (stateMatch) {
        node = {};
        for (const line of stateMatch[1].split('\n')) {
            const separator = line.indexOf('=');
            if (separator < 1) continue;
            const key = line.slice(0, separator).trim().toLowerCase();
            const value = line.slice(separator + 1).trim();
            if (['time', 'location', 'player', 'inventory', 'npcs', 'quest', 'danger', 'changes'].includes(key) && value && value !== '未知') node[key] = value;
        }
        narrative = narrative.replace(stateMatch[0], '').trim();
    }
    const choicesMatch = narrative.match(/\[CHOICES\]([\s\S]*?)\[\/CHOICES\]/i);
    if (choicesMatch) {
        for (const line of choicesMatch[1].split('\n')) {
            const match = line.match(/^\s*(?:[-*•]|\d+[.、)])\s*(.+?)\s*$/);
            if (!match) continue;
            const [title, ...detail] = match[1].split('|');
            if (title?.trim()) choices.push({ title: title.trim(), detail: detail.join('|').trim() });
        }
        narrative = narrative.replace(choicesMatch[0], '').trim();
    }
    if (!node && narrative.includes('【当前节点】')) {
        const parts = narrative.split('【当前节点】');
        narrative = parts[0].trim();
        const nodeAndChoices = parts.slice(1).join('【当前节点】').split('【可选行动】');
        node = {};
        const labelMap = { '时间': 'time', '地点': 'location', '状态': 'player', '玩家': 'player', '物资': 'inventory', '人物': 'npcs', '目标': 'quest', '危险': 'danger', '变化': 'changes' };
        for (const line of nodeAndChoices[0].split('\n')) {
            const match = line.match(/^\s*[-*•]?\s*([^：:]+)[：:]\s*(.+)$/);
            const key = match && labelMap[match[1].trim()];
            if (key) node[key] = match[2].trim();
        }
        if (nodeAndChoices[1]) {
            for (const line of nodeAndChoices[1].split('\n')) {
                const match = line.match(/^\s*(?:\d+[.、)]|[-*•])\s*(.+)$/);
                if (match) choices.push({ title: match[1].trim(), detail: '' });
            }
        }
    }
    return { narrative: cleanNarrativeMarkdown(narrative) || '……', node: node && Object.keys(node).length ? node : null, choices: choices.slice(0, 5) };
}

const NODE_FIELDS = ['time', 'location', 'player', 'inventory', 'npcs', 'quest', 'danger', 'changes'];
const EMPTY_STATE_VALUES = /^(?:未知|无|暂无|当前回合|当前场景|状态未更新|继续当前剧情|本回合沿用上一节点)$/u;
const GENERIC_CHOICE = /^(?:观察周围|与在场人物交流|检查自身与物品|继续当前剧情|等待|自由行动)$/u;

function cleanAnalysisText(value, maxLength = 500) {
    return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maxLength);
}

function normalizeStateNode(candidate, previousNode = null) {
    const next = previousNode ? { ...previousNode } : {};
    for (const key of NODE_FIELDS) {
        const value = cleanAnalysisText(candidate?.[key], key === 'changes' ? 300 : 500);
        if (value && !EMPTY_STATE_VALUES.test(value)) next[key] = value;
    }
    const meaningful = NODE_FIELDS.filter(key => key !== 'changes' && next[key]).length;
    if (meaningful < 2) throw new Error('节点内容不完整');
    if (!cleanAnalysisText(candidate?.changes)) throw new Error('节点缺少本回合变化');
    return next;
}

function normalizeDynamicChoices(candidate) {
    if (!Array.isArray(candidate)) throw new Error('行动列表格式错误');
    const choices = [];
    const used = new Set();
    for (const item of candidate) {
        const title = cleanAnalysisText(typeof item === 'string' ? item : item?.title, 70);
        const detail = cleanAnalysisText(typeof item === 'object' ? (item?.detail || item?.description) : '', 120);
        if (title.length < 3 || GENERIC_CHOICE.test(title) || used.has(title)) continue;
        used.add(title);
        choices.push({ title, detail });
        if (choices.length >= 5) break;
    }
    if (choices.length < 3) throw new Error('缺少场景专属行动');
    return choices;
}

function compactNarrative(value) {
    return cleanNarrativeMarkdown(value).replace(/[\s“”"「」『』，。！？、：；（）()…—\-]/gu, '');
}

function normalizeNarrativeSegments(candidate, narrative) {
    if (!Array.isArray(candidate) || !candidate.length) return [];
    const source = compactNarrative(narrative);
    const segments = [];
    let covered = 0;
    for (const raw of candidate) {
        const type = raw?.type === 'speech' ? 'speech' : 'narration';
        const text = cleanAnalysisText(raw?.text, 5000);
        if (!text) continue;
        const compactText = compactNarrative(text);
        if (!compactText || !source.includes(compactText)) return [];
        covered += compactText.length;
        if (type === 'speech') {
            const speaker = cleanAnalysisText(raw?.speaker, 40);
            const aside = cleanAnalysisText(raw?.aside, 80).replace(/^[（(]|[）)]$/gu, '');
            if (!speaker || (aside && (!source.includes(compactNarrative(aside)) || aside.length > 48))) return [];
            if (aside) covered += compactNarrative(aside).length;
            segments.push({ type, speaker, text, aside });
        } else {
            segments.push({ type, text });
        }
    }
    if (!segments.length || covered < Math.max(8, source.length * 0.58)) return [];
    return segments;
}

function parseAnalysisJson(value) {
    const text = String(value || '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
    if (!text) throw new Error('状态结算没有返回内容');
    return JSON.parse(text);
}

function turnAnalysisPrompt(narrative, playerAction, previousNode) {
    const primaryRole = cardData()?.name || '未命名角色';
    return `你是互动故事的回合导演和结构分析器。请根据本回合已经写出的故事进行事实提取，不得续写、改写或添加剧情。

只输出一个有效 JSON 对象，不要输出 Markdown。JSON 必须使用下面的结构：
{
  "segments": [
    {"type":"narration","text":"必须逐字摘自故事正文"},
    {"type":"speech","speaker":"明确人物姓名","text":"只放说出口的原话","aside":"与这句对白紧邻且不超过40字的动作、神态或心理；没有则为空字符串"}
  ],
  "state": {
    "time":"当前剧情时间",
    "location":"当前准确地点",
    "player":"玩家身体与精神状态",
    "inventory":"当前重要物资及明确增减",
    "npcs":"当前在场人物及状态",
    "quest":"眼前实际目标",
    "danger":"已经出现或明确临近的危险",
    "changes":"本回合相对上一节点的关键变化；没有显著变化就明确说明"
  },
  "choices": [
    {"title":"玩家现在可以立即执行的具体行动","detail":"结合现场人物、物品、路线或危险的一句说明"}
  ]
}

规则：
1. segments 必须覆盖故事正文的主要内容并保持原顺序，所有 text 和 aside 都必须逐字来自故事，不得润色。
2. 旁白、长动作和环境描写用 narration；只有真正说出口的话用 speech。
3. speech 必须判断真实说话者。短动作、神态或心理可放 aside；超过40字或不能确定归属时必须保留为 narration。
4. state 必须以事实为准。上一节点中本回合未发生变化的字段要原样保留，不得凭空改变地点、物资、伤势、人物生死或关系。
5. choices 必须给出3至5个互不重复、适合当前瞬间的行动，必须引用当前场景里的具体人物、物品、地点、声音、路线或危险。
6. 禁止使用“观察周围”“与在场人物交流”“检查自身与物品”“继续剧情”等空泛行动，不能剧透未知信息，也不能把行动结果写成选项。
7. 所有字段必须使用简体中文。

主要角色/主持职责：${primaryRole}
上一节点：${JSON.stringify(previousNode || {})}
玩家本回合输入：${playerAction || '开始故事'}
本回合故事正文：
${narrative}`;
}

async function analyzeTurn(narrative, playerAction, previousNode = null) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const prompt = turnAnalysisPrompt(narrative, playerAction, previousNode);
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: { Authorization: `Bearer ${state.apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: state.model,
                    messages: [
                        { role: 'system', content: '你是严格的中文 JSON 数据分析器。只提取已发生的故事事实，不得创作新情节。' },
                        { role: 'user', content: attempt ? `${prompt}\n\n上一次结构不合格。这次请逐项检查 JSON、节点完整性、三个以上具体行动和正文分段。` : prompt },
                    ],
                    response_format: { type: 'json_object' },
                    max_tokens: Math.max(900, Math.min(2200, state.maxTokens)),
                    temperature: 0.2,
                    stream: false,
                    thinking: { type: 'disabled' },
                }),
            });
            if (!response.ok) throw new Error(await apiError(response));
            const data = await response.json();
            const payload = parseAnalysisJson(data.choices?.[0]?.message?.content);
            return {
                node: normalizeStateNode(payload.state, previousNode),
                choices: normalizeDynamicChoices(payload.choices),
                segments: normalizeNarrativeSegments(payload.segments, narrative),
            };
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error('本回合状态结算失败');
}

function nowTime() {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date());
}

async function startNewChat(ask = true) {
    if (ask && state.messages.length && !confirm('新建聊天会清除当前对话；角色卡和世界书会保留。继续吗？')) return;
    state.messages = [];
    state.currentNode = null;
    state.currentChoices = [];
    const first = expandMacros(cardData()?.first_mes || cardData()?.first_message || '');
    if (first) {
        const opening = { role: 'assistant', content: first, time: nowTime(), pending: false };
        state.messages.push(opening);
        if (needsChineseRewrite(first)) {
            if (state.apiKey) {
                opening.pending = true;
                state.busy = true;
                setStatus('正在把开场转换为中文…', 'busy');
                render();
                try { opening.content = await rewriteResponseInChinese(first); }
                catch { opening.content = '角色卡开场为外文，自动转换失败。请发送第一条行动，后续故事仍将强制使用简体中文。'; }
                finally { opening.pending = false; state.busy = false; }
            } else {
                opening.content = '角色卡开场为外文。连接 DeepSeek API 后重新新建聊天，程序会自动转换为简体中文。';
            }
        }
        const parsed = parseAssistantResponse(opening.content);
        opening.content = parsed.narrative;
        opening.segments = [];
        if (state.apiKey && state.analysisEnabled) {
            state.busy = true;
            state.analysisBusy = true;
            setStatus('正在结算开场节点…', 'busy');
            render();
            try {
                const analysis = await analyzeTurn(opening.content, '开始故事', null);
                Object.assign(opening, analysis, { analysisError: false });
            } catch (error) {
                opening.node = null;
                opening.choices = [];
                opening.analysisError = true;
                toast(`开场结算失败：${error.message}`);
            } finally {
                state.analysisBusy = false;
                state.busy = false;
            }
        } else {
            opening.node = parsed.node;
            opening.choices = parsed.choices;
        }
        if (opening.node) state.currentNode = opening.node;
        state.currentChoices = opening.choices || [];
    }
    saveState();
    render();
    if (state.apiKey) setStatus('已就绪', 'online');
    closeSettings();
    toast('已新建聊天');
}

function worldEntries() {
    const raw = state.world?.entries || state.world?.data?.entries || [];
    return Array.isArray(raw) ? raw : Object.values(raw);
}

function embeddedCardEntries() {
    const raw = cardData()?.character_book?.entries || [];
    return Array.isArray(raw) ? raw : Object.values(raw);
}

function activeWorldText() {
    const recent = state.messages.slice(-8).map(item => item.content).join('\n').toLowerCase();
    const selected = [];
    const entries = [...worldEntries(), ...embeddedCardEntries()].sort((a, b) => Number(b.order || 100) - Number(a.order || 100));
    for (const entry of entries) {
        if (entry?.enabled === false || entry?.disable === true) continue;
        const keys = Array.isArray(entry.key) ? entry.key : Array.isArray(entry.keys) ? entry.keys : typeof entry.key === 'string' ? [entry.key] : [];
        const constant = entry.constant === true || entry.always_active === true;
        if (constant || keys.some(key => key && recent.includes(String(key).toLowerCase()))) {
            const content = entry.content || entry.text || '';
            if (content) selected.push(expandMacros(content));
        }
        if (selected.join('\n').length > 30000) break;
    }
    return selected.join('\n\n');
}

function buildRawApiMessages() {
    const card = cardData() || {};
    const userInstruction = state.instruction.replace(REQUIRED_RESPONSE_PROTOCOL, '').trim();
    const sections = [userInstruction];
    if (card.name) sections.push(`你扮演的角色/职责：${expandMacros(card.name)}`);
    if (card.description) sections.push(`角色描述：\n${expandMacros(card.description).slice(0, 60000)}`);
    if (card.personality) sections.push(`性格：\n${expandMacros(card.personality)}`);
    if (card.scenario) sections.push(`场景：\n${expandMacros(card.scenario)}`);
    if (card.mes_example) sections.push(`示例对话：\n${expandMacros(card.mes_example)}`);
    if (card.system_prompt) sections.push(`角色专属系统提示：\n${expandMacros(card.system_prompt)}`);
    const world = activeWorldText();
    if (world) sections.push(`当前生效的世界书资料：\n${world}`);
    if (state.plotEssentials) sections.push(`始终记忆（每次都必须保持一致）：\n${state.plotEssentials}`);
    if (state.storySummary) sections.push(`较早剧情摘要：\n${state.storySummary}`);
    if (state.currentNode) sections.push(`上一回合的权威当前状态（本回合只能依据明确事件更新）：\n${formatNodeForPrompt(state.currentNode)}`);
    if (card.post_history_instructions) sections.push(`历史记录后指令：\n${expandMacros(card.post_history_instructions)}`);
    if (state.authorNote) sections.push(`作者备注（只影响当前阶段的写法，不得覆盖事实）：\n${state.authorNote}`);
    sections.push(`最终输出协议（优先于角色卡中的语言和格式要求）：\n${REQUIRED_RESPONSE_PROTOCOL}`);

    return [
        { role: 'system', content: sections.filter(Boolean).join('\n\n') },
        ...state.messages.map(({ role, content }) => ({ role, content })),
    ];
}

function formatNodeForPrompt(node) {
    return ['time', 'location', 'player', 'inventory', 'npcs', 'quest', 'danger', 'changes']
        .filter(key => node?.[key])
        .map(key => `${key}=${node[key]}`)
        .join('\n');
}

function estimateTokens(text) {
    let cjk = 0;
    let other = 0;
    for (const char of String(text || '')) {
        if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(char)) cjk += 1;
        else other += 1;
    }
    return cjk + Math.ceil(other / 4) + 4;
}

function trimTextToTokens(text, limit) {
    if (estimateTokens(text) <= limit) return text;
    let result = String(text);
    while (result.length > 100 && estimateTokens(result) > limit) {
        result = result.slice(0, Math.floor(result.length * 0.88));
    }
    return `${result}\n\n[内容因上下文限制已截断]`;
}

function buildApiMessages() {
    const raw = buildRawApiMessages();
    const totalBudget = Math.max(4096, Math.min(1000000, state.contextTokens));
    const promptBudget = Math.max(1024, totalBudget - state.maxTokens);
    const systemLimit = Math.max(512, Math.floor(promptBudget * 0.6));
    const system = { ...raw[0], content: trimTextToTokens(raw[0].content, systemLimit) };
    let used = estimateTokens(system.content);
    const kept = [];
    for (let index = raw.length - 1; index >= 1; index -= 1) {
        const cost = estimateTokens(raw[index].content) + 4;
        if (used + cost > promptBudget) continue;
        kept.unshift(raw[index]);
        used += cost;
    }
    return [system, ...kept];
}

function updateContextUsage() {
    if (!elements.contextUsage) return;
    const rawTokens = buildRawApiMessages().reduce((sum, item) => sum + estimateTokens(item.content) + 4, 0);
    const limit = Math.max(4096, Number(state.contextTokens) || 100000);
    elements.contextUsage.textContent = `当前约 ${rawTokens.toLocaleString('zh-CN')} Token / 上限 ${limit.toLocaleString('zh-CN')} Token；超出后自动保留较新的对话。`;
}

async function validateApiKey() {
    const key = elements.apiKeyInput.value.trim();
    if (!key) return toast('请先输入 DeepSeek API 密钥');
    elements.connectButton.disabled = true;
    setStatus('正在验证…', 'busy');
    try {
        const response = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${key}` } });
        if (!response.ok) throw new Error(await apiError(response));
        state.apiKey = key;
        state.rememberKey = elements.rememberKeyInput.checked;
        if (state.rememberKey) localStorage.setItem(API_KEY_STORAGE, key);
        else localStorage.removeItem(API_KEY_STORAGE);
        saveState();
        setStatus('API 已连接', 'online');
        toast('验证成功，手机现在可直接连接 DeepSeek');
    } catch (error) {
        setStatus('API 连接失败');
        toast(error.message || 'API 密钥验证失败');
    } finally {
        elements.connectButton.disabled = false;
    }
}

async function apiError(response) {
    try {
        const value = await response.json();
        return value?.error?.message || value?.error || `API 返回 ${response.status}`;
    } catch { return `API 返回 ${response.status}`; }
}

async function sendMessage(event) {
    event.preventDefault();
    if (state.busy) return;
    const content = elements.messageInput.value.trim();
    if (!content) return;
    if (!state.apiKey) {
        openSettings();
        return toast('请先填写并验证 DeepSeek API 密钥');
    }

    state.model = elements.modelSelect.value;
    state.contextTokens = Math.max(4096, Math.min(1000000, Number(elements.contextTokensInput.value) || 100000));
    state.maxTokens = Math.max(256, Math.min(65536, Number(elements.maxTokensInput.value) || 4096, state.contextTokens - 1024));
    state.temperature = Math.max(0, Math.min(2, Number(elements.temperatureInput.value) || 0));
    state.thinking = elements.thinkingInput.checked;
    state.instruction = ensureRequiredProtocol(elements.instructionInput.value.trim() || DEFAULT_INSTRUCTION);
    state.plotEssentials = elements.plotEssentialsInput.value.trim();
    state.storySummary = elements.storySummaryInput.value.trim();
    state.authorNote = elements.authorNoteInput.value.trim();
    elements.instructionInput.value = state.instruction;
    state.messages.push({ role: 'user', content, time: nowTime() });
    state.currentChoices = [];
    elements.messageInput.value = '';
    resizeComposer();

    const assistant = { role: 'assistant', content: '', time: nowTime(), pending: true };
    state.messages.push(assistant);
    state.busy = true;
    elements.sendButton.disabled = true;
    setStatus('故事生成中…', 'busy');
    render();

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${state.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: state.model,
                messages: buildApiMessages().slice(0, -1),
                max_tokens: state.maxTokens,
                temperature: state.temperature,
                stream: true,
                thinking: { type: state.thinking ? 'enabled' : 'disabled' },
            }),
        });
        if (!response.ok || !response.body) throw new Error(await apiError(response));
        await readStream(response, assistant);
        if (!assistant.content.trim()) throw new Error('模型没有返回正文；请关闭“模型推理”或提高最大回复 Token');
        if (needsChineseRewrite(assistant.content)) {
            setStatus('检测到英文，正在自动重写为中文…', 'busy');
            try { assistant.content = await rewriteResponseInChinese(assistant.content); }
            catch {
                assistant.content = '模型本回合返回了英文，自动中文转换未成功。请点击“重新生成”，程序会继续强制要求简体中文。';
                toast('英文回复转换失败，请重新生成本回合');
            }
            if (needsChineseRewrite(assistant.content)) {
                assistant.content = '模型连续违反简体中文规则，本回合英文内容已隐藏。请点击“重新生成”。';
            }
        }
        assistant.pending = false;
        const parsed = parseAssistantResponse(assistant.content);
        assistant.content = parsed.narrative;
        assistant.segments = [];
        if (state.analysisEnabled) {
            state.analysisBusy = true;
            setStatus('正在结算本回合…', 'busy');
            render();
            try {
                const analysis = await analyzeTurn(assistant.content, content, state.currentNode);
                Object.assign(assistant, analysis, { analysisError: false });
            } catch (error) {
                assistant.node = state.currentNode;
                assistant.choices = [];
                assistant.analysisError = true;
                toast(`剧情已生成，但回合结算失败：${error.message}`);
            } finally {
                state.analysisBusy = false;
            }
        } else {
            assistant.node = parsed.node ? { ...(state.currentNode || {}), ...parsed.node } : state.currentNode;
            assistant.choices = parsed.choices;
        }
        if (assistant.node) state.currentNode = assistant.node;
        state.currentChoices = assistant.choices || [];
        state.busy = false;
        elements.sendButton.disabled = false;
        saveState();
        render();
        updateContextUsage();
        setStatus('已就绪', 'online');
    } catch (error) {
        state.messages = state.messages.filter(item => item !== assistant);
        saveState();
        render();
        setStatus('发送失败');
        toast(error.message || '连接 DeepSeek 失败');
    } finally {
        state.busy = false;
        elements.sendButton.disabled = false;
        renderStoryDock();
    }
}

function previousNodeBefore(messageIndex) {
    for (let index = messageIndex - 1; index >= 0; index -= 1) {
        const message = state.messages[index];
        if (message.role === 'assistant' && message.node && !message.analysisError) return message.node;
    }
    return null;
}

async function retryLatestAnalysis() {
    if (state.busy || !state.apiKey || !state.analysisEnabled) return;
    let assistantIndex = -1;
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
        if (state.messages[index].role === 'assistant') { assistantIndex = index; break; }
    }
    if (assistantIndex < 0) return;
    const assistant = state.messages[assistantIndex];
    const playerAction = state.messages.slice(0, assistantIndex).reverse().find(message => message.role === 'user')?.content || '开始故事';
    const previousNode = previousNodeBefore(assistantIndex);
    state.busy = true;
    state.analysisBusy = true;
    state.currentChoices = [];
    setStatus('正在重新分析本回合…', 'busy');
    render();
    try {
        const analysis = await analyzeTurn(assistant.content, playerAction, previousNode);
        Object.assign(assistant, analysis, { analysisError: false });
        state.currentNode = analysis.node;
        state.currentChoices = analysis.choices;
        toast('本回合节点和行动已更新');
    } catch (error) {
        assistant.analysisError = true;
        state.currentNode = previousNode;
        state.currentChoices = [];
        toast(`重新分析失败：${error.message}`);
    } finally {
        state.analysisBusy = false;
        state.busy = false;
        saveState();
        render();
        setStatus('已就绪', 'online');
    }
}

function regenerateLast() {
    if (state.busy) return toast('请等待当前回复完成');
    const lastIndex = state.messages.length - 1;
    if (lastIndex < 1 || state.messages[lastIndex].role !== 'assistant' || state.messages[lastIndex - 1].role !== 'user') return toast('当前没有可以重新生成的回复');
    const previousInput = state.messages[lastIndex - 1].content;
    state.messages.splice(lastIndex - 1, 2);
    state.currentNode = null;
    state.currentChoices = [];
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
        if (state.messages[index].role !== 'assistant') continue;
        if (!state.currentNode && state.messages[index].node) state.currentNode = state.messages[index].node;
        if (!state.currentChoices.length && state.messages[index].choices?.length) state.currentChoices = state.messages[index].choices;
        if (state.currentNode && state.currentChoices.length) break;
    }
    elements.messageInput.value = previousInput;
    saveState();
    render();
    elements.composer.requestSubmit();
}

function continueStory() {
    if (state.busy) return toast('请等待当前回复完成');
    elements.messageInput.value = '请继续推进当前场景，保持状态连续，并在需要我决定行动时停下。';
    resizeComposer();
    elements.composer.requestSubmit();
}

async function readStream(response, assistant) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastRender = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
                const json = JSON.parse(payload);
                assistant.content += json.choices?.[0]?.delta?.content || '';
            } catch { /* wait for the next valid event */ }
        }
        if (performance.now() - lastRender > 90) {
            render();
            lastRender = performance.now();
        }
    }
}

async function importCard(file) {
    if (!file) return;
    try {
        const isPng = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');
        const card = isPng
            ? await parsePngCard(file)
            : JSON.parse(await file.text());
        const data = card?.data || card;
        if (!data || !(data.name || data.description || data.first_mes)) throw new Error('文件里没有可识别的角色卡数据');
        state.card = card;
        state.cardAvatar = isPng ? await imageFileToAvatar(file) : '';
        saveState();
        syncForm();
        render();
        toast(`已导入角色：${data.name || '未命名'}`);
    } catch (error) { toast(`角色卡导入失败：${error.message}`); }
    finally { elements.cardFileInput.value = ''; }
}

async function imageFileToAvatar(file) {
    const url = URL.createObjectURL(file);
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const side = Math.min(image.naturalWidth, image.naturalHeight);
        const sourceX = (image.naturalWidth - side) / 2;
        const sourceY = (image.naturalHeight - side) / 2;
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        canvas.getContext('2d').drawImage(image, sourceX, sourceY, side, side, 0, 0, 256, 256);
        return canvas.toDataURL('image/webp', 0.86);
    } finally { URL.revokeObjectURL(url); }
}

async function parsePngCard(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length < 12 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) throw new Error('不是有效的 PNG 文件');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ascii = new TextDecoder('latin1');
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset);
        const type = ascii.decode(bytes.subarray(offset + 4, offset + 8));
        const start = offset + 8;
        const end = start + length;
        if (end + 4 > bytes.length) break;
        if (type === 'tEXt') {
            const data = bytes.subarray(start, end);
            const zero = data.indexOf(0);
            const keyword = zero >= 0 ? ascii.decode(data.subarray(0, zero)) : '';
            if (keyword === 'chara' || keyword === 'ccv3') return decodeCardPayload(ascii.decode(data.subarray(zero + 1)));
        }
        if (type === 'iTXt') {
            const data = bytes.subarray(start, end);
            const zero = data.indexOf(0);
            const keyword = zero >= 0 ? ascii.decode(data.subarray(0, zero)) : '';
            if ((keyword === 'chara' || keyword === 'ccv3') && data[zero + 1] === 0) {
                let cursor = zero + 3;
                cursor = data.indexOf(0, cursor) + 1;
                cursor = data.indexOf(0, cursor) + 1;
                return decodeCardPayload(new TextDecoder().decode(data.subarray(cursor)));
            }
        }
        offset = end + 4;
    }
    throw new Error('PNG 中没有找到 SillyTavern 的 chara/ccv3 数据');
}

function decodeCardPayload(payload) {
    const normalized = payload.trim();
    try { return JSON.parse(normalized); } catch { /* most PNG cards use base64 */ }
    const binary = atob(normalized.replace(/\s/g, ''));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
}

async function importWorld(file) {
    if (!file) return;
    try {
        const world = JSON.parse(await file.text());
        const entries = world?.entries || world?.data?.entries;
        if (!entries) throw new Error('文件里没有可识别的世界书条目');
        state.world = world;
        saveState();
        syncForm();
        toast(`世界书已导入，共 ${worldEntries().length} 条`);
    } catch (error) { toast(`世界书导入失败：${error.message}`); }
    finally { elements.worldFileInput.value = ''; }
}

let editingCardAvatar = '';

function renderCardAvatarPreview() {
    const name = elements.cardEditorName.value.trim() || '角色';
    elements.cardAvatarPreview.replaceChildren();
    elements.cardAvatarPreview.style.setProperty('--avatar-hue', String(nameHue(name)));
    if (editingCardAvatar) {
        const image = document.createElement('img');
        image.src = editingCardAvatar;
        image.alt = '';
        elements.cardAvatarPreview.append(image);
    } else {
        elements.cardAvatarPreview.textContent = name.slice(0, 1).toUpperCase();
    }
}

function openCardEditor(isNew) {
    const card = isNew ? {} : (cardData() || {});
    if (!isNew && !state.card) return toast('请先导入或新建一个角色卡');
    elements.cardEditorTitle.textContent = isNew ? '新建角色卡' : '编辑角色卡';
    elements.cardEditorName.value = card.name || '';
    elements.cardEditorDescription.value = card.description || '';
    elements.cardEditorPersonality.value = card.personality || '';
    elements.cardEditorScenario.value = card.scenario || '';
    elements.cardEditorFirstMessage.value = card.first_mes || card.first_message || '';
    elements.cardEditorExample.value = card.mes_example || '';
    elements.cardEditorSystemPrompt.value = card.system_prompt || '';
    elements.cardEditorPostHistory.value = card.post_history_instructions || '';
    editingCardAvatar = isNew ? '' : state.cardAvatar;
    renderCardAvatarPreview();
    closeSettings();
    elements.cardEditorDialog.showModal();
}

function saveCard() {
    const name = elements.cardEditorName.value.trim();
    if (!name) return toast('请填写角色名称');
    const previous = cardData() || {};
    state.card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: elements.cardEditorDescription.value.trim(),
            personality: elements.cardEditorPersonality.value.trim(),
            scenario: elements.cardEditorScenario.value.trim(),
            first_mes: elements.cardEditorFirstMessage.value.trim(),
            mes_example: elements.cardEditorExample.value.trim(),
            creator_notes: previous.creator_notes || '',
            system_prompt: elements.cardEditorSystemPrompt.value.trim(),
            post_history_instructions: elements.cardEditorPostHistory.value.trim(),
            alternate_greetings: previous.alternate_greetings || [],
            tags: previous.tags || [],
            character_book: previous.character_book || undefined,
            extensions: previous.extensions || {},
        },
    };
    state.cardAvatar = editingCardAvatar;
    saveState();
    syncForm();
    render();
    elements.cardEditorDialog.close();
    toast(`角色卡“${name}”已保存`);
}

function openWorldEditor(isNew) {
    if (!isNew && !state.world) return toast('请先导入或新建一本世界书');
    elements.worldEditorTitle.textContent = isNew ? '新建世界书' : '编辑世界书';
    elements.worldEditorName.value = isNew ? '' : (state.world?.name || state.world?.data?.name || '');
    elements.worldEntriesEditor.replaceChildren();
    if (!isNew) for (const entry of worldEntries()) addWorldEntry(entry);
    if (isNew || !elements.worldEntriesEditor.children.length) addWorldEntry();
    closeSettings();
    elements.worldEditorDialog.showModal();
}

function addWorldEntry(entry = {}) {
    const card = document.createElement('section');
    card.className = 'world-entry-card';
    card.innerHTML = `
        <div class="entry-head"><strong>世界书条目</strong><button class="remove-entry" type="button">删除</button></div>
        <label class="field"><span>触发关键词（用逗号分隔）</span><input class="entry-keys" placeholder="城市, 警察, 新闻"></label>
        <label class="field"><span>条目内容</span><textarea class="entry-content" rows="5" placeholder="模型需要知道的设定、事实或规则"></textarea></label>
        <label class="field"><span>优先级（数字越大越优先）</span><input class="entry-order" type="number" value="100"></label>
        <label class="toggle-row"><span>启用条目</span><input class="entry-enabled" type="checkbox" checked></label>
        <label class="toggle-row"><span>始终启用</span><input class="entry-constant" type="checkbox"></label>`;
    const keys = Array.isArray(entry.key) ? entry.key : Array.isArray(entry.keys) ? entry.keys : typeof entry.key === 'string' ? [entry.key] : [];
    card.querySelector('.entry-keys').value = keys.join(', ');
    card.querySelector('.entry-content').value = entry.content || entry.text || '';
    card.querySelector('.entry-order').value = Number(entry.order ?? entry.priority ?? 100);
    card.querySelector('.entry-enabled').checked = entry.enabled !== false && entry.disable !== true;
    card.querySelector('.entry-constant').checked = entry.constant === true || entry.always_active === true;
    card.querySelector('.remove-entry').addEventListener('click', () => card.remove());
    elements.worldEntriesEditor.append(card);
}

function saveWorld() {
    const name = elements.worldEditorName.value.trim() || '未命名世界书';
    const entries = [...elements.worldEntriesEditor.querySelectorAll('.world-entry-card')].map((card, index) => ({
        uid: index + 1,
        key: card.querySelector('.entry-keys').value.split(/[,，\n]/).map(value => value.trim()).filter(Boolean),
        content: card.querySelector('.entry-content').value.trim(),
        order: Number(card.querySelector('.entry-order').value) || 100,
        constant: card.querySelector('.entry-constant').checked,
        enabled: card.querySelector('.entry-enabled').checked,
        disable: !card.querySelector('.entry-enabled').checked,
    })).filter(entry => entry.content);
    state.world = { name, entries };
    saveState();
    syncForm();
    elements.worldEditorDialog.close();
    toast(`世界书“${name}”已保存，共 ${entries.length} 条`);
}

function safeFileName(value) {
    return String(value || 'export').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

function downloadJson(value, filename) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function exportCard() {
    if (!state.card) return toast('当前没有角色卡');
    downloadJson(state.card, `${safeFileName(cardData()?.name || '角色卡')}.json`);
}

function exportWorld() {
    if (!state.world) return toast('当前没有世界书');
    downloadJson(state.world, `${safeFileName(state.world?.name || state.world?.data?.name || '世界书')}.json`);
}

function exportChat() {
    if (!state.messages.length) return toast('当前没有可导出的聊天');
    const title = cardData()?.name || '移动酒馆';
    const text = state.messages.map(item => `${item.role === 'user' ? '你' : title}：\n${item.role === 'assistant' ? cleanNarrativeMarkdown(item.content) : item.content}`).join('\n\n---\n\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${title}-${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function exportAllData() {
    const backup = {
        format: 'mobile-tavern-backup',
        formatVersion: 1,
        appVersion: APP_VERSION,
        schemaVersion: DATA_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        data: snapshotState(),
    };
    downloadJson(backup, `移动酒馆完整备份-${new Date().toISOString().slice(0, 10)}.json`);
    toast('完整数据已导出，API 密钥未包含');
}

async function importAllData(file) {
    if (!file) return;
    try {
        const backup = JSON.parse(await file.text());
        if (backup?.format !== 'mobile-tavern-backup' || !backup.data || !Array.isArray(backup.data.messages)) throw new Error('不是有效的移动酒馆完整备份');
        if (!confirm('恢复备份会替换当前角色、世界书、故事记忆和聊天，但不会改变已保存的 API 密钥。继续吗？')) return;
        const data = backup.data;
        for (const key of ['theme', 'layout', 'fontSize', 'fontFamily', 'customFontName', 'choiceMode', 'model', 'contextTokens', 'maxTokens', 'temperature', 'thinking', 'plotEssentials', 'storySummary', 'authorNote', 'card', 'cardAvatar', 'world', 'messages', 'currentNode', 'currentChoices', 'storyDockEnabled', 'analysisEnabled', 'storyDockOpen']) {
            if (data[key] !== undefined) state[key] = data[key];
        }
        let missingCustomFont = false;
        if (state.fontFamily === 'custom') {
            const storedFont = await readDatabaseValue('custom-font');
            if (storedFont) await activateCustomFont(storedFont);
            else {
                state.fontFamily = 'system';
                state.customFontName = '';
                missingCustomFont = true;
            }
        }
        state.instruction = ensureRequiredProtocol(data.instruction || DEFAULT_INSTRUCTION);
        migrateMessages();
        saveState();
        syncForm();
        render();
        closeSettings();
        toast(missingCustomFont ? '备份已恢复；自定义字体文件需重新导入' : '完整数据备份已恢复');
    } catch (error) { toast(`恢复失败：${error.message}`); }
    finally { elements.backupFileInput.value = ''; }
}

function inspectPrompt() {
    const messages = buildApiMessages();
    elements.promptInspectorContent.textContent = messages.map((message, index) => {
        const tokens = estimateTokens(message.content);
        return `# ${index + 1} · ${message.role.toUpperCase()} · 约 ${tokens} Token\n${message.content}`;
    }).join('\n\n────────────────────────\n\n');
    closeSettings();
    elements.promptInspectorDialog.showModal();
}

function migrateMessages() {
    let latestNode = state.currentNode ? { ...state.currentNode } : null;
    if (latestNode) {
        for (const key of NODE_FIELDS) {
            if (EMPTY_STATE_VALUES.test(cleanAnalysisText(latestNode[key]))) delete latestNode[key];
        }
        if (!Object.keys(latestNode).length) latestNode = null;
    }
    let latestChoices = [];
    for (const message of state.messages) {
        if (message.role !== 'assistant') continue;
        if (!message.node && (/\[STATE\]/i.test(message.content) || message.content.includes('【当前节点】'))) {
            const parsed = parseAssistantResponse(message.content);
            message.content = parsed.narrative;
            message.node = parsed.node;
            message.choices = parsed.choices;
        }
        if (!Array.isArray(message.segments)) message.segments = [];
        if (message.node && !message.analysisError) latestNode = message.node;
        if (!Array.isArray(message.choices)) message.choices = [];
        if (message.choices.length && message.choices.every(choice => GENERIC_CHOICE.test(cleanAnalysisText(choice?.title)))) message.choices = [];
        latestChoices = message.choices;
    }
    state.currentNode = latestNode || null;
    state.currentChoices = Array.isArray(latestChoices) ? latestChoices : [];
}

function clearLocalData() {
    if (!confirm('确定清空本机的聊天、角色卡、世界书和已保存的 API 密钥吗？')) return;
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem(API_KEY_STORAGE);
    clearBackup().catch(() => {});
    if (activeCustomFontFace) document.fonts.delete(activeCustomFontFace);
    activeCustomFontFace = null;
    Object.assign(state, {
        apiKey: '', rememberKey: true, theme: 'midnight', layout: 'document', fontSize: 17, fontFamily: 'system', customFontName: '', choiceMode: 'fill',
        model: 'deepseek-v4-flash', contextTokens: 100000, maxTokens: 4096, temperature: 1, thinking: false,
        instruction: DEFAULT_INSTRUCTION, plotEssentials: '', storySummary: '', authorNote: '', card: null, cardAvatar: '', world: null,
        messages: [], currentNode: null, currentChoices: [], storyDockEnabled: true, analysisEnabled: true, storyDockOpen: false,
        analysisBusy: false,
        updatedAt: 0,
    });
    syncForm();
    render();
    toast('本机数据已清空');
}

function resizeComposer() {
    elements.messageInput.style.height = 'auto';
    elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 150)}px`;
}

function startVoiceInput() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
        elements.messageInput.focus();
        return toast('请点 iPhone 键盘右下角的麦克风进行语音输入');
    }
    const recognition = new Recognition();
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;
    recognition.onstart = () => setStatus('正在听…', 'busy');
    recognition.onresult = event => {
        elements.messageInput.value = Array.from(event.results).map(result => result[0].transcript).join('');
        resizeComposer();
    };
    recognition.onerror = () => toast('语音识别未成功，请检查麦克风权限');
    recognition.onend = () => setStatus(state.apiKey ? '已就绪' : '等待 API 密钥', state.apiKey ? 'online' : '');
    recognition.start();
}

elements.settingsButton.addEventListener('click', openSettings);
elements.openSetupButton?.addEventListener('click', openSettings);
elements.closeSettingsButton.addEventListener('click', closeSettings);
elements.backdrop.addEventListener('click', closeSettings);
elements.connectButton.addEventListener('click', validateApiKey);
elements.newChatButton.addEventListener('click', () => startNewChat(true));
elements.composer.addEventListener('submit', sendMessage);
elements.messageInput.addEventListener('input', resizeComposer);
elements.voiceButton.addEventListener('click', startVoiceInput);
elements.cardFileInput.addEventListener('change', event => importCard(event.target.files?.[0]));
elements.worldFileInput.addEventListener('change', event => importWorld(event.target.files?.[0]));
elements.newCardButton.addEventListener('click', () => openCardEditor(true));
elements.editCardButton.addEventListener('click', () => openCardEditor(false));
elements.exportCardButton.addEventListener('click', exportCard);
elements.cancelCardEditorButton.addEventListener('click', () => elements.cardEditorDialog.close());
elements.saveCardButton.addEventListener('click', saveCard);
elements.cardEditorName.addEventListener('input', () => { if (!editingCardAvatar) renderCardAvatarPreview(); });
elements.cardAvatarFileInput.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
        editingCardAvatar = await imageFileToAvatar(file);
        renderCardAvatarPreview();
        toast('头像已更新，保存角色卡后生效');
    } catch { toast('头像读取失败，请换一张图片'); }
    finally { elements.cardAvatarFileInput.value = ''; }
});
elements.clearCardAvatarButton.addEventListener('click', () => {
    editingCardAvatar = '';
    renderCardAvatarPreview();
    toast('已切换为自动头像');
});
elements.newWorldButton.addEventListener('click', () => openWorldEditor(true));
elements.editWorldButton.addEventListener('click', () => openWorldEditor(false));
elements.exportWorldButton.addEventListener('click', exportWorld);
elements.cancelWorldEditorButton.addEventListener('click', () => elements.worldEditorDialog.close());
elements.addWorldEntryButton.addEventListener('click', () => addWorldEntry());
elements.saveWorldButton.addEventListener('click', saveWorld);
elements.exportButton.addEventListener('click', exportChat);
elements.exportAllButton.addEventListener('click', exportAllData);
elements.backupFileInput.addEventListener('change', event => importAllData(event.target.files?.[0]));
elements.clearButton.addEventListener('click', clearLocalData);
elements.inspectPromptButton.addEventListener('click', inspectPrompt);
elements.closePromptInspectorButton.addEventListener('click', () => elements.promptInspectorDialog.close());
elements.promptInspectorDialog.addEventListener('click', event => {
    if (event.target === elements.promptInspectorDialog) elements.promptInspectorDialog.close();
});
for (const tab of document.querySelectorAll('.settings-tab')) {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.settings-tab').forEach(item => item.classList.toggle('active', item === tab));
        document.querySelectorAll('.settings-view').forEach(view => view.classList.toggle('active', view.dataset.settingsView === tab.dataset.settingsTab));
        elements.settingsPanel.querySelector('.panel-body')?.scrollTo({ top: 0, behavior: 'smooth' });
    });
}
elements.rememberKeyInput.addEventListener('change', () => {
    state.rememberKey = elements.rememberKeyInput.checked;
    if (state.rememberKey && state.apiKey) localStorage.setItem(API_KEY_STORAGE, state.apiKey);
    else localStorage.removeItem(API_KEY_STORAGE);
    saveState();
});
elements.themeSelect.addEventListener('change', () => {
    state.theme = elements.themeSelect.value;
    document.documentElement.dataset.theme = state.theme;
    saveState();
});
elements.layoutSelect.addEventListener('change', () => {
    state.layout = elements.layoutSelect.value;
    document.documentElement.dataset.layout = state.layout;
    saveState();
    render();
});
elements.storyDockEnabledInput.addEventListener('change', () => {
    state.storyDockEnabled = elements.storyDockEnabledInput.checked;
    saveState();
    renderStoryDock();
});
elements.analysisEnabledInput.addEventListener('change', () => {
    state.analysisEnabled = elements.analysisEnabledInput.checked;
    saveState();
    renderStoryDock();
    toast(state.analysisEnabled ? '已开启每回合智能剧情结算' : '已关闭智能剧情结算');
});
elements.storyDockDetails.addEventListener('toggle', () => {
    if (elements.storyDock.hidden) return;
    state.storyDockOpen = elements.storyDockDetails.open;
    saveState();
});
elements.fontSizeSelect.addEventListener('change', () => {
    state.fontSize = Number(elements.fontSizeSelect.value) || 17;
    document.documentElement.style.setProperty('--chat-font-size', `${state.fontSize}px`);
    saveState();
});
elements.fontFamilySelect.addEventListener('change', () => {
    state.fontFamily = elements.fontFamilySelect.value;
    applyFontFamily();
    saveState();
});
elements.fontFileInput.addEventListener('change', () => importCustomFont(elements.fontFileInput.files?.[0]));
elements.clearCustomFontButton.addEventListener('click', clearCustomFont);
elements.choiceModeSelect.addEventListener('change', () => {
    state.choiceMode = elements.choiceModeSelect.value;
    saveState();
});
for (const element of [
    elements.modelSelect, elements.contextTokensInput, elements.maxTokensInput, elements.temperatureInput,
    elements.thinkingInput, elements.plotEssentialsInput, elements.storySummaryInput, elements.authorNoteInput,
    elements.instructionInput,
]) {
    element.addEventListener('change', () => {
        state.model = elements.modelSelect.value;
        state.contextTokens = Math.max(4096, Math.min(1000000, Number(elements.contextTokensInput.value) || 100000));
        state.maxTokens = Math.max(256, Math.min(65536, Number(elements.maxTokensInput.value) || 4096, state.contextTokens - 1024));
        state.temperature = Math.max(0, Math.min(2, Number(elements.temperatureInput.value) || 0));
        state.thinking = elements.thinkingInput.checked;
        state.plotEssentials = elements.plotEssentialsInput.value.trim();
        state.storySummary = elements.storySummaryInput.value.trim();
        state.authorNote = elements.authorNoteInput.value.trim();
        state.instruction = ensureRequiredProtocol(elements.instructionInput.value);
        saveState();
        syncForm();
    });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});
migrateMessages();
syncForm();
render();
resizeComposer();
restoreFromBackup().finally(() => restoreCustomFont());
