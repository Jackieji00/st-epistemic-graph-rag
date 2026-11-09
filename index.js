import { getContext, extension_settings } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    setExtensionPrompt,
    extension_prompt_types,
    getRequestHeaders,
    saveSettingsDebounced
} from '../../../../script.js';
import { GraphStorage } from './db_store.js';
import { EmbeddingService } from './embedding_service.js';
import { LongTermEpistemicGraph } from './long_term_graph_rag.js';
import { importGraphJson as importGraphJsonImpl, exportGraphJson as exportGraphJsonImpl } from './graph_io.js';

const MODULE = '[EpistemicGraphRAG]';
const EXTENSION_NAME = 'st-epistemic-graph-rag';
const PROMPT_TAG = 'epistemic_graph_rag';
const BUILD_PROMPT_TAG = 'epistemic_graph_rag_build';
const ASSISTANT_GENERATION_TYPES = new Set(['normal', 'continue', 'regenerate', 'swipe']);

console.log(MODULE, 'index.js 开始加载');

const defaultSettings = {
    enabled: true,
    speakerMode: 'follow',
    activeSpeaker: '',
    recentWindowSize: 16,
    topK: 8,
    maskAbsentHistory: true,
    autoSeed: false,
    debugLog: false
};

const storage = new GraphStorage();
const embedder = new EmbeddingService({ getRequestHeaders });
export const graph = new LongTermEpistemicGraph(embedder);
let activeGraphChatId = '';
let generationEpoch = 0;
let receiveQueue = Promise.resolve();

function clearGenerationPrompts() {
    setExtensionPrompt(PROMPT_TAG, '', extension_prompt_types.IN_CHAT, 1);
    setExtensionPrompt(BUILD_PROMPT_TAG, '', extension_prompt_types.IN_CHAT, 1);
}

function log(...args) {
    if (getSettings().debugLog) console.log(MODULE, ...args);
}

function toast(msg, level = 'info') {
    try {
        if (typeof toastr !== 'undefined' && toastr[level]) toastr[level](msg, 'Epistemic GraphRAG', { timeOut: 4000 });
        else console.log(MODULE, msg);
    } catch { /* ignore */ }
}

function getSettings() {
    if (!extension_settings[EXTENSION_NAME]) extension_settings[EXTENSION_NAME] = { ...defaultSettings };
    for (const k of Object.keys(defaultSettings)) {
        if (extension_settings[EXTENSION_NAME][k] === undefined) {
            extension_settings[EXTENSION_NAME][k] = defaultSettings[k];
        }
    }
    return extension_settings[EXTENSION_NAME];
}

function persistSettings() {
    try { saveSettingsDebounced?.(); } catch { /* ignore */ }
}

/* ---------------------------- 测试场景 ---------------------------- */
export async function seedMvpWarehouseScenario(targetGraph = graph) {
    targetGraph.ensureNpc('小王');
    targetGraph.ensureNpc('小李');
    targetGraph.ensureNpc('小张');

    await targetGraph.ingestEvent({
        event: {
            id: 'evt_warehouse_key',
            messageId: 2,
            timestamp: 'Day 1 15:00',
            location: '仓库',
            participants: ['小王', '小李'],
            summary: '小王在仓库第三排木箱下藏了一把青铜钥匙，被门外的小李亲眼目击。'
        },
        facts: [
            { id: 'fact_visit_warehouse', content: '小王在 Day 1 下午去过仓库。', entities: ['小王', '仓库'], keywords: ['小王', '仓库', '下午', '去过'] },
            { id: 'fact_hide_key', content: '小王在仓库第三排木箱底下藏了一把青铜钥匙。', entities: ['小王', '仓库', '青铜钥匙', '木箱'], keywords: ['小王', '仓库', '钥匙', '青铜钥匙', '木箱', '藏'], isSecret: true }
        ],
        epistemicGrants: [
            { npcId: '小王', factId: 'fact_visit_warehouse', sourceType: 'ACTOR', learnedAtMsg: 2, confidence: 1.0 },
            { npcId: '小王', factId: 'fact_hide_key', sourceType: 'ACTOR', learnedAtMsg: 2, confidence: 1.0 },
            { npcId: '小李', factId: 'fact_visit_warehouse', sourceType: 'WITNESS', learnedAtMsg: 2, confidence: 0.98 },
            { npcId: '小李', factId: 'fact_hide_key', sourceType: 'WITNESS', learnedAtMsg: 2, confidence: 0.98 }
        ]
    });

    targetGraph.messagePresence.set(4, new Set(['小李', '小张']));
    targetGraph.propagateFact({
        fromNpcId: '小李',
        toNpcId: '小张',
        factId: 'fact_visit_warehouse',
        learnedAtMsg: 4,
        confidence: 0.85,
        partialOrDistortedText: '听小李说，小王今天下午鬼鬼祟祟地去过一趟仓库。'
    });
}

/* ---------------------------- 导入导出 ---------------------------- */
export async function importGraphJson(text, targetGraph = graph) {
    return importGraphJsonImpl(text, targetGraph);
}

function exportGraphJson() {
    return exportGraphJsonImpl(graph);
}

/* ---------------------------- 增量建图 ---------------------------- */
export async function parseAndApplyGraphMarkup(messageText, messageId, targetGraph = graph) {
    if (!messageText || typeof messageText !== 'string') return false;
    let updated = false;

    const deltaRegex = /<ta_graph_delta>([\s\S]*?)<\/ta_graph_delta>/g;
    let match;
    while ((match = deltaRegex.exec(messageText)) !== null) {
        try {
            const payload = JSON.parse(match[1].trim());
            const eventId = payload.eventId || `evt_msg_${messageId}`;
            await targetGraph.ingestEvent({
                event: {
                    id: eventId,
                    messageId,
                    timestamp: payload.timestamp || `第${messageId}楼`,
                    location: payload.location || '',
                    participants: payload.present || payload.participants || [],
                    summary: payload.summary || ''
                },
                facts: payload.facts || [],
                epistemicGrants: (payload.grants || []).map(g => ({
                    ...g,
                    learnedAtMsg: g.learnedAtMsg ?? messageId
                }))
            });
            updated = true;
            log('建图成功', eventId, '事实=', (payload.facts || []).length);
        } catch (err) {
            console.error(MODULE, '解析 <ta_graph_delta> 失败:', err);
        }
    }

    const opRegex = /<graph_op>([\s\S]*?)<\/graph_op>/g;
    while ((match = opRegex.exec(messageText)) !== null) {
        try {
            const op = JSON.parse(match[1].trim());
            if (op.type === 'TELL') {
                targetGraph.propagateFact({
                    fromNpcId: op.from,
                    toNpcId: op.to,
                    factId: op.factId,
                    learnedAtMsg: messageId,
                    confidence: op.confidence ?? 0.85,
                    partialOrDistortedText: op.text || null,
                    isFalseRumor: Boolean(op.isFalseRumor)
                });
                updated = true;
                log('事实传播', op.from, '->', op.to, op.factId);
            }
        } catch (err) {
            console.error(MODULE, '解析 <graph_op> 失败:', err);
        }
    }

    return updated;
}

/* ---------------------------- 角色解析 ---------------------------- */
function resolveActiveNpc() {
    const context = getContext();
    const settings = getSettings();
    if (settings.speakerMode === 'manual' && settings.activeSpeaker) return settings.activeSpeaker.trim();
    if (context?.name2) return context.name2;
    const chars = context?.characters;
    if (Array.isArray(chars) && chars.length > 0) return chars[0].name;
    return '';
}

/* ---------------------------- 拦截器 ------------------------------ */
globalThis.epistemicGraphInterceptor = async function (chat, contextSize, abort, type) {
    clearGenerationPrompts();
    const epoch = ++generationEpoch;
    const settings = getSettings();
    if (!settings.enabled || !ASSISTANT_GENERATION_TYPES.has(type) || !Array.isArray(chat) || chat.length === 0) return;

    const context = getContext();
    const chatId = context?.chatId;
    if (!chatId || activeGraphChatId !== chatId) return;

    const npc = resolveActiveNpc();
    if (!npc) return;

    const totalMessages = chat.length;
    const queryText = chat.slice(-2).map(m => m?.mes || '').join('\n');
    const { activeFacts, historicalFacts } = await graph.retrieveContextForNpc({
        npcId: npc,
        queryText,
        currentMsgId: totalMessages,
        topK: Number(settings.topK) || 8
    });

    // Retrieval is asynchronous; never apply a result after the user switched chats or speakers.
    if (epoch !== generationEpoch || !getSettings().enabled || getContext()?.chatId !== chatId || resolveActiveNpc() !== npc || activeGraphChatId !== chatId) return;

    if (type !== 'continue') {
        const npcIdSlug = Array.from(npc, char => /[A-Za-z0-9_-]/.test(char) ? char : `u${char.codePointAt(0).toString(16)}`).join('_');
        setExtensionPrompt(BUILD_PROMPT_TAG, `${GRAPH_RULES_TEXT}\n\nAdditional constraints:\n- Prefix every fact ID with this assistant turn's stable identifier: turn_${totalMessages}_${npcIdSlug}; add a per-turn sequence number. Reuse the same stable NPC name already present in this graph; do not create alternate names for the same person.\n- Grant each fact only to named characters who directly experienced it or learned it through an explicit in-story source. A card or world name is not itself evidence that everyone knows its contents.\n- Keep fact visibility scoped to each NPC's actual knowledge; do not grant world-level facts to all characters by default.`, extension_prompt_types.IN_CHAT, 1);
    }

    if (!activeFacts.length && !historicalFacts.length) {
        log(`拦截器：${npc} 无已知事实，仅注入本轮建图规则，不裁剪或遮蔽历史`);
        return;
    }

    const prompt = graph.buildEpistemicPrompt({ npcId: npc, activeFacts, historicalFacts });
    setExtensionPrompt(PROMPT_TAG, prompt, extension_prompt_types.IN_CHAT, 1);

    const recentWindow = Math.max(4, Number(settings.recentWindowSize) || 16);
    const cutoff = Math.max(0, totalMessages - recentWindow);
    if (settings.maskAbsentHistory) {
        for (let i = 0; i < chat.length - 1; i++) {
            const msgId = chat[i]?.mes_id ?? i;
            const present = graph.messagePresence.get(msgId);
            if (present && !present.has(npc)) {
                chat[i] = { ...chat[i], mes: `[第${msgId}楼历史隔离：该事件发生时 ${npc} 不在场，无现场记忆]` };
            }
        }
    }
    if (cutoff > 0) chat.splice(0, cutoff);

    if (settings.debugLog) {
        console.log(MODULE, `注入 | 角色=${npc} | 召回=${activeFacts.length} | 楼层=${totalMessages} | 裁剪=${cutoff}\n` + prompt);
    }
};

/* ---------------------------- 聊天同步 ---------------------------- */
async function syncCurrentChatGraph() {
    const context = getContext();
    const chatId = context?.chatId;
    if (!chatId) { updateStatus('未打开聊天'); return; }

    const saved = await storage.loadGraph(chatId);
    if (getContext()?.chatId !== chatId) return;
    if (saved) {
        graph.deserialize(saved);
        log('载入图谱', chatId, 'Facts=', graph.facts.size);
    } else {
        graph.deserialize({});
        if (getSettings().autoSeed) {
            await seedMvpWarehouseScenario(graph);
            await storage.saveGraph(chatId, graph.serialize());
        }
    }
    activeGraphChatId = chatId;
    updateStatus();
}

async function persistGraph() {
    const chatId = getContext()?.chatId;
    if (!chatId) return false;
    await storage.saveGraph(chatId, graph.serialize());
    return true;
}

/* ---------------------------- 建图规则 ---------------------------- */
const GRAPH_RULES_TEXT = `[EPISTEMIC GRAPH DELTA]
After the narrative prose, append exactly one machine-readable block. Emit it verbatim; it is stripped from display and consumed by the memory plugin.

<ta_graph_delta>
{"present":["<characters physically present in this scene>"],
 "location":"<place>",
 "facts":[{"id":"fact_<n>","content":"<one concrete sentence of what objectively happened>",
           "entities":["<character|object|place>"],"keywords":["<retrieval keywords>"],
           "isSecret":<true|false>,"supersedesFactId":"<id of the fact this new one replaces, or null>"}],
 "grants":[{"npcId":"<character>","factId":"fact_<n>","sourceType":"ACTOR|WITNESS|HEARSAY|INFERRED|RUMOR_FALSE",
            "sourceNpc":"<who told them, null if direct>","confidence":<0-1>}]}
</ta_graph_delta>

Rules:
1. facts = only events that actually happened this turn. Never invent them.
2. grants = only characters who could actually know that fact. An absent character gets no grant.
3. Partial disclosure: if A tells B only part of the truth, grant B the fact with "distortedContent" set to exactly what B heard.
4. A fact that replaces an earlier state (item moved, person killed, promise broken) must set supersedesFactId.
5. Off-screen knowledge propagation:
<graph_op>{"type":"TELL","from":"<speaker>","to":"<listener>","factId":"<fact id>","text":"<what was actually said>","isFalseRumor":<true|false>}</graph_op>
6. If nothing graph-worthy happened, still emit the block with empty arrays.`;

/* ---------------------------- 面板 -------------------------------- */
function panelHtml() {
    const s = getSettings();
    return `
<div id="eg_panel_root" class="epistemic-graph-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Epistemic GraphRAG · 知情边界与长期记忆</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="eg-status" id="eg_status">加载中…</div>

      <label class="checkbox_label">
        <input id="eg_enabled" type="checkbox" ${s.enabled ? 'checked' : ''} />
        <span>启用知情边界拦截与图谱检索</span>
      </label>
      <label class="checkbox_label">
        <input id="eg_mask" type="checkbox" ${s.maskAbsentHistory ? 'checked' : ''} />
        <span>遮蔽当前角色不在场的历史楼层</span>
      </label>
      <label class="checkbox_label">
        <input id="eg_debug" type="checkbox" ${s.debugLog ? 'checked' : ''} />
        <span>控制台输出注入内容（调试）</span>
      </label>

      <div class="eg-row">
        <label>当前发言角色</label>
        <select id="eg_speaker_mode" class="text_pole">
          <option value="follow">跟随当前角色卡（name2）</option>
          <option value="manual">手动指定</option>
        </select>
        <input id="eg_speaker" class="text_pole" type="text" placeholder="手动指定角色名" value="${s.activeSpeaker || ''}" />
      </div>

      <div class="eg-row">
        <label>短期原文窗口（楼）</label>
        <input id="eg_window" class="text_pole" type="number" min="4" max="64" value="${s.recentWindowSize}" />
      </div>
      <div class="eg-row">
        <label>召回条数 Top-K</label>
        <input id="eg_topk" class="text_pole" type="number" min="1" max="24" value="${s.topK}" />
      </div>

      <div class="eg-actions">
        <button id="eg_preview" class="menu_button" type="button">预览本次注入</button>
        <button id="eg_stats" class="menu_button" type="button">刷新状态</button>
        <button id="eg_rules" class="menu_button" type="button">复制建图规则</button>
        <button id="eg_clearlog" class="menu_button" type="button">清空输出</button>
      </div>

      <div class="eg-row">
        <label>自定义图谱导入（JSON，合并进当前聊天的图谱；messageId = 聊天数组序号，从 0 开始）</label>
        <textarea id="eg_import" class="text_pole eg-textarea" placeholder='{"npcs":["角色A","角色B"],"events":[{"id":"evt_1","messageId":12,"participants":["角色A"],"facts":[{"id":"f1","content":"...","entities":["角色A"],"keywords":["..."]}],"grants":[{"npcId":"角色A","factId":"f1","sourceType":"ACTOR"}]}]}'></textarea>
      </div>
      <div class="eg-actions">
        <button id="eg_do_import" class="menu_button" type="button">导入 JSON</button>
        <button id="eg_do_export" class="menu_button" type="button">导出到导入框</button>
        <button id="eg_seed" class="menu_button" type="button">载入测试图谱</button>
        <button id="eg_clear" class="menu_button" type="button">清空图谱</button>
      </div>

      <pre id="eg_output" class="eg-inspector">勾选“控制台输出注入内容”，正常发消息即可看到实际注入。</pre>
    </div>
  </div>
</div>`;
}

function bindPanel() {
    const $ = jQuery;
    const s = getSettings();

    $('#eg_enabled').on('change', function () { s.enabled = Boolean($(this).prop('checked')); persistSettings(); });
    $('#eg_mask').on('change', function () { s.maskAbsentHistory = Boolean($(this).prop('checked')); persistSettings(); });
    $('#eg_debug').on('change', function () { s.debugLog = Boolean($(this).prop('checked')); persistSettings(); });
    $('#eg_speaker_mode').val(s.speakerMode).on('change', function () { s.speakerMode = String($(this).val()); persistSettings(); });
    $('#eg_speaker').on('input', function () { s.activeSpeaker = String($(this).val()); persistSettings(); });
    $('#eg_window').on('change', function () { s.recentWindowSize = Number($(this).val()) || 16; persistSettings(); });
    $('#eg_topk').on('change', function () { s.topK = Number($(this).val()) || 8; persistSettings(); });

    $('#eg_stats').on('click', () => updateStatus());
    $('#eg_clearlog').on('click', () => $('#eg_output').text(''));

    $('#eg_rules').on('click', async () => {
        $('#eg_output').text(GRAPH_RULES_TEXT);
        try { await navigator.clipboard.writeText(GRAPH_RULES_TEXT); toast('建图规则已复制'); }
        catch { toast('已显示在下方，手动复制', 'warning'); }
    });

    $('#eg_do_export').on('click', () => {
        try { $('#eg_import').val(exportGraphJson()); toast('已填入导入框，可编辑后重新导入'); }
        catch (e) { toast('导出失败：' + e.message, 'error'); }
    });

    $('#eg_do_import').on('click', async () => {
        const text = String($('#eg_import').val() || '').trim();
        if (!text) { $('#eg_output').text('导入框是空的。'); return; }
        try {
            const r = await importGraphJson(text, graph);
            await persistGraph();
            updateStatus();
            $('#eg_output').text(
                `导入成功：NPC ${r.npcs} / 事件 ${r.events} / 事实 ${r.facts} / 认知边 ${r.edges}` +
                (r.warnings?.length ? '\n警告：\n- ' + r.warnings.join('\n- ') : '')
            );
            toast('自定义图谱已导入');
        } catch (e) {
            $('#eg_output').text('导入失败：' + e.message);
            toast('导入失败：' + e.message, 'error');
        }
    });

    $('#eg_seed').on('click', async () => {
        await seedMvpWarehouseScenario(graph);
        await persistGraph();
        updateStatus();
        $('#eg_output').text('测试图谱已载入。把发言角色依次设为 小王 / 小李 / 小张 点「预览本次注入」对比。');
        toast('已载入测试图谱');
    });

    $('#eg_clear').on('click', async () => {
        graph.deserialize({});
        await persistGraph();
        updateStatus();
        $('#eg_output').text('当前聊天的图谱已清空。');
        toast('图谱已清空');
    });

    $('#eg_preview').on('click', async () => {
        const npc = resolveActiveNpc();
        if (!npc) { $('#eg_output').text('无法确定发言角色：打开一个角色聊天，或改为手动指定。'); return; }
        const ctx = getContext();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        const query = (chat[chat.length - 1]?.mes || '') + '\n' + (chat[chat.length - 2]?.mes || '');
        const res = await graph.retrieveContextForNpc({
            npcId: npc, queryText: query, currentMsgId: chat.length, topK: Number(s.topK) || 8
        });
        if (!res.activeFacts.length && !res.historicalFacts.length) {
            $('#eg_output').text(`【角色】${npc}\n该角色在图谱中没有任何已知事实。先导入自定义图谱，或点「载入测试图谱」。`);
            return;
        }
        const prompt = graph.buildEpistemicPrompt({ npcId: npc, activeFacts: res.activeFacts, historicalFacts: res.historicalFacts });
        $('#eg_output').text(
            `【角色】${npc}\n【召回】${res.activeFacts.length} 条有效 / ${res.historicalFacts.length} 条旧状态\n──────────────\n${prompt}`
        );
    });

    updateStatus();
}

function updateStatus(extra) {
    const $ = jQuery;
    if (typeof $ === 'undefined' || !$('#eg_status')?.length) return;
    const ctx = getContext();
    const npc = resolveActiveNpc();
    const edges = Array.from(graph.knowledgeEdges.values()).reduce((a, m) => a + m.size, 0);
    const lines = [
        `聊天：${ctx?.chatId || '（未打开）'}`,
        `发言：${npc || '（未识别）'}`,
        `NPC ${graph.npcs.size}　事件 ${graph.events.size}　事实 ${graph.facts.size}　认知边 ${edges}`
    ];
    if (extra) lines.push(extra);
    $('#eg_status').text(lines.join('　|　'));
}

function mountPanel() {
    if (typeof jQuery === 'undefined') return false;
    if (document.getElementById('eg_panel_root')) return true;
    const target = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!target) return false;
    target.insertAdjacentHTML('beforeend', panelHtml());
    bindPanel();
    console.log(MODULE, '设置面板已挂载到', target.id);
    return true;
}

/* ---------------------------- 启动 -------------------------------- */
let mounted = false;
function tryMount(times = 0) {
    if (mountPanel()) { mounted = true; return; }
    if (times > 120) {
        console.error(MODULE, '设置面板挂载失败：未找到 #extensions_settings2 / #extensions_settings');
        return;
    }
    setTimeout(() => tryMount(times + 1), 500);
}

jQuery(async () => {
    try {
        console.log(MODULE, 'jQuery ready，开始初始化');
        await syncCurrentChatGraph();
        tryMount();

        eventSource.on(event_types.CHAT_CHANGED, async () => {
            generationEpoch++;
            activeGraphChatId = '';
            clearGenerationPrompts();
            await receiveQueue;
            await syncCurrentChatGraph();
        });

        eventSource.on(event_types.MESSAGE_RECEIVED, async (messageIndex) => {
            const ctx = getContext();
            const msg = ctx?.chat?.[messageIndex];
            const chatId = ctx?.chatId;
            const graphChatId = activeGraphChatId;
            const messageText = msg?.mes;
            if (!messageText || !chatId || graphChatId !== chatId) return;
            receiveQueue = receiveQueue.then(async () => {
                const changed = await parseAndApplyGraphMarkup(messageText, messageIndex, graph);
                if (changed) await storage.saveGraph(chatId, graph.serialize());
                if (mounted && getContext()?.chatId === chatId) updateStatus();
            }).catch(err => console.error(MODULE, '保存收到的图谱数据失败:', err));
            await receiveQueue;
        });

        console.log(MODULE, '初始化完成');
    } catch (err) {
        console.error(MODULE, '初始化异常:', err);
    }
});
