import { Popup, POPUP_TYPE } from '../../../popup.js';

const MENU_ID = 'eg-memory-wand-entry';
const ROOT_ID = 'eg-memory-panel';
let actions = null;
let popup = null;
let apiDirty = false;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function apiFields(kind, title, config = {}) {
    const vector = kind === 'vector';
    const mode = config.mode || (vector ? 'disabled' : 'tavern');
    const profiles = kind === 'summary' ? (actions?.getState?.().profiles || []) : [];
    return `<section class="egm-api" data-api="${kind}">
      <h3>${title}</h3>
      <label>连接<select class="text_pole" data-field="mode">
        ${vector ? `<option value="disabled" ${mode === 'disabled' ? 'selected' : ''}>关闭</option>` : `<option value="tavern" ${mode === 'tavern' ? 'selected' : ''}>当前酒馆</option><option value="profile" ${mode === 'profile' ? 'selected' : ''}>已保存预设</option>`}
        <option value="openai-compatible" ${mode === 'openai-compatible' ? 'selected' : ''}>OpenAI 兼容接口</option>
      </select></label>
      ${kind === 'summary' ? `<label data-config="profile">预设<select class="text_pole" data-field="profileId"><option value="">选择预设</option>${profiles.map(p => `<option value="${escapeHtml(p.id)}" ${config.profileId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select></label>` : ''}
      <div data-config="custom">
        <label>接口地址<input class="text_pole" data-field="baseUrl" type="url" value="${escapeHtml(config.baseUrl)}" placeholder="https://…"></label>
        <label>模型<input class="text_pole" data-field="model" type="text" value="${escapeHtml(config.model)}" placeholder="模型名称"></label>
        <label>API Key<input class="text_pole" data-field="apiKey" type="password" value="" autocomplete="new-password" placeholder="留空则保留此地址的密钥"></label>
        <label class="egm-clear-key"><input type="checkbox" data-field="clearKey"> 清除此地址已保存的密钥</label>
      </div>
      <div class="egm-actions"><button class="menu_button" type="button" data-action="test" data-kind="${kind}">测试连接</button></div>
      <div class="egm-result" data-api-result="${kind}" aria-live="polite"></div>
    </section>`;
}

function panelHtml(state = {}) {
    const mode = state.mode === 'book' ? 'book' : 'gap';
    return `<div id="${ROOT_ID}" class="eg-memory-panel">
      <header class="egm-header"><strong>记忆回填</strong><button class="egm-close" type="button" aria-label="关闭">×</button></header>
      <section class="egm-state"><div><span>当前聊天</span><strong data-state="chat">${escapeHtml(state.chatName || (state.hasChat ? '当前聊天' : '未打开聊天'))}</strong></div><div><span>进度</span><strong data-state="progress">${escapeHtml(state.progress || '可开始回填')}</strong></div><div><span>图谱</span><strong>${Number(state.factCount) || 0} 条事实 · ${Number(state.vectorCount) || 0} 个向量</strong></div></section>
      <fieldset class="egm-mode"><legend>回填范围</legend>
        <label><input type="radio" name="egm-mode" value="gap" ${mode === 'gap' ? 'checked' : ''}> 世界书优先补缺</label>
        <label><input type="radio" name="egm-mode" value="book" ${mode === 'book' ? 'checked' : ''}> 仅世界书</label>
      </fieldset>
      <div class="egm-actions egm-job-actions">
        <button class="menu_button" data-action="start" type="button" ${!state.hasChat || state.running ? 'disabled' : ''}>开始 / 继续</button>
        <button class="menu_button" data-action="stop" type="button" ${!state.running ? 'disabled' : ''}>停止</button>
        <button class="menu_button" data-action="reindex" type="button" ${!state.hasChat || state.running ? 'disabled' : ''}>为旧记忆补向量</button>
      </div>
      <div class="egm-unsaved" data-state="unsaved" hidden>API 设置有未保存修改；保存后再运行回填或补向量。</div>
      <div class="egm-apis">${apiFields('summary', '总结 API', state.summaryApi)}${apiFields('vector', '向量 API', state.vectorApi)}</div>
      <footer class="egm-footer"><button class="menu_button" data-action="save" type="button">保存 API 设置</button><span data-state="notice" aria-live="polite"></span></footer>
    </div>`;
}

function root() { return popup?.dlg?.querySelector(`#${ROOT_ID}`) || null; }

function setNotice(text, kind = '') {
    const node = root()?.querySelector('[data-state="notice"]');
    if (node) { node.textContent = text || ''; node.dataset.kind = kind; }
}

function draft(kind) {
    const section = root()?.querySelector(`[data-api="${kind}"]`);
    const value = field => section?.querySelector(`[data-field="${field}"]`)?.value || '';
    const config = { mode: value('mode') };
    if (kind === 'summary') config.profileId = value('profileId');
    if (config.mode === 'openai-compatible') {
        config.baseUrl = value('baseUrl').trim();
        config.model = value('model').trim();
        const key = value('apiKey');
        config.apiKey = key || (section.querySelector('[data-field="clearKey"]')?.checked ? null : undefined);
    }
    return config;
}

async function handleClick(event) {
    const button = event.target.closest('[data-action], .egm-close');
    if (!button) return;
    if (button.matches('.egm-close')) { popup?.complete(0); return; }
    const action = button.dataset.action;
    try {
        if ((action === 'start' || action === 'reindex') && apiDirty) { setNotice('请先保存 API 修改，回填任务使用已保存的连接。', 'error'); return; }
        if (action === 'start') await actions.start(root().querySelector('[name="egm-mode"]:checked').value);
        else if (action === 'stop') await actions.stop();
        else if (action === 'reindex') await actions.reindex();
        else if (action === 'save') {
            button.disabled = true;
            button.textContent = '保存中…';
            try {
                await actions.saveApis({ summary: draft('summary'), vector: draft('vector') });
                apiDirty = false;
                root()?.querySelectorAll('[data-field="apiKey"]').forEach(input => { input.value = ''; });
                root()?.querySelectorAll('[data-field="clearKey"]').forEach(input => { input.checked = false; });
                root()?.querySelector('[data-state="unsaved"]')?.setAttribute('hidden', '');
                setNotice('设置已保存；密钥不在面板中回显。', 'ok');
            } finally {
                if (button.isConnected) { button.disabled = false; button.textContent = '保存 API 设置'; }
            }
        } else if (action === 'test') {
            const kind = button.dataset.kind;
            const resultNode = root()?.querySelector(`[data-api-result="${kind}"]`);
            button.disabled = true;
            button.textContent = '测试中…';
            if (resultNode) resultNode.textContent = '';
            try {
                const result = await actions.testApi(kind, draft(kind));
                if (resultNode?.isConnected) resultNode.textContent = typeof result === 'string' ? result : (result?.message || '连接成功');
            } catch (error) {
                if (resultNode?.isConnected) resultNode.textContent = error?.message || String(error);
            } finally {
                if (button.isConnected) { button.disabled = false; button.textContent = '测试连接'; updateApiVisibility(button.closest('.egm-api')); }
            }
        }
    } catch (error) {
        setNotice(error?.message || String(error), 'error');
    }
    refreshMemoryPanel();
}

function bindPanel() {
    const panel = root();
    if (!panel) return;
    panel.addEventListener('click', handleClick);
    panel.addEventListener('change', event => {
        const api = event.target.closest('.egm-api');
        if (api) { apiDirty = true; updateApiVisibility(api); api.querySelector('[data-api-result]').textContent = ''; }
        if (apiDirty) panel.querySelector('[data-state="unsaved"]').hidden = false;
    });
    panel.addEventListener('input', event => {
        if (!event.target.closest('.egm-api')) return;
        apiDirty = true;
        event.target.closest('.egm-api').querySelector('[data-api-result]').textContent = '';
        panel.querySelector('[data-state="unsaved"]').hidden = false;
    });
    panel.querySelectorAll('.egm-api').forEach(updateApiVisibility);
}

function updateApiVisibility(section) {
    const mode = section.querySelector('[data-field="mode"]')?.value;
    const kind = section.dataset.api;
    const custom = section.querySelector('[data-config="custom"]');
    const profile = section.querySelector('[data-config="profile"]');
    if (custom) custom.hidden = mode !== 'openai-compatible';
    if (profile) profile.hidden = mode !== 'profile';
    const test = section.querySelector('[data-action="test"]');
    if (test) test.disabled = mode === 'disabled';
}

export function refreshMemoryPanel() {
    const panel = root();
    if (!panel || !actions?.getState) return;
    const state = actions.getState();
    panel.querySelector('[data-state="chat"]').textContent = state.chatName || (state.hasChat ? '当前聊天' : '未打开聊天');
    panel.querySelector('[data-state="progress"]').textContent = state.progress || (state.running ? '正在运行…' : '可开始回填');
    const counts = panel.querySelector('.egm-state > div:last-child strong');
    if (counts) counts.textContent = `${Number(state.factCount) || 0} 条事实 · ${Number(state.vectorCount) || 0} 个向量`;
    panel.querySelector('[data-state="unsaved"]').hidden = !apiDirty;
    panel.querySelector('[data-action="start"]').disabled = !state.hasChat || state.running || apiDirty;
    panel.querySelector('[data-action="stop"]').disabled = !state.running;
    panel.querySelector('[data-action="reindex"]').disabled = !state.hasChat || state.running || apiDirty;
}

export function mountMemoryWand(nextActions) {
    actions = nextActions;
    const menu = document.querySelector('#extensionsMenu');
    if (!menu) return false;
    let entry = document.getElementById(MENU_ID);
    if (!entry) {
        entry = document.createElement('div');
        entry.id = MENU_ID;
        entry.className = 'list-group-item flex-container flexGap5';
        entry.tabIndex = 0;
        entry.setAttribute('role', 'button');
        const button = document.createElement('div');
        button.id = 'eg-memory-wand-button';
        button.className = 'fa-fw fa-solid fa-book-open extensionsMenuExtensionButton';
        const label = document.createElement('span');
        label.textContent = '记忆回填';
        const open = () => {
            apiDirty = false;
            popup = new Popup(panelHtml(actions.getState()), POPUP_TYPE.DISPLAY, '', {
                large: true,
                allowVerticalScrolling: true,
                onOpen: bindPanel,
                onClose: () => { popup = null; },
            });
            popup.show();
            refreshMemoryPanel();
            return true;
        };
        entry.addEventListener('click', event => { event.preventDefault(); open(); });
        entry.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
        entry.append(button, label);
    }
    if (entry.parentElement !== menu) menu.append(entry);
    return true;
}
