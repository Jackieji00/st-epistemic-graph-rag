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

const MODULE = '[EpistemicGraphRAG]';
const EXTENSION_NAME = 'st-epistemic-graph-rag';
const PROMPT_TAG = 'epistemic_graph_rag';

console.log(MODULE, 'index.js 开始加载');

const defaultSettings = {
    enabled: true,
    speakerMode: 'follow',      // follow | manual
    activeSpeaker: '',
    recentWindowSize: 16,
    topK: 8,
    maskAbsentHistory: true,
    autoSeed: true,
    debugLog: true
};

const storage = new GraphStorage();
const embedder = new EmbeddingService({ getRequestHeaders });
export const graph = new LongTermEpistemicGraph(embedder);

function log(...args) {
    if (getSettings().debugLog) console.log(MODULE, ...args);
}

function toast(msg, level = 'info') {
    try {
        if (typeof toastr !== 'undefined' && toastr[level]) toastr[level](msg, 'Epistemic GraphRAG');
    } catch { /* ignore */ }
}

function getSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = { ...defaultSettings };
    }
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

/* ------------------------------------------------------------------ */
/* 测试场景：3 个 NPC、1 个秘密、一次部分告知                            */
/* ------------------------------------------------------------------ */
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
            {
                id: 'fact_visit_warehouse',
                content: '小王在 Day 1 下午去过仓库。',
                entities: ['小王', '仓库'],
                keywords: ['小王', '仓库', '下午', '去过'],
                isSecret: false
            },
            {
                id: 'fact_hide_key',
                content: '小王在仓库第三排木箱底下藏了一把青铜钥匙。',
                entities: ['小王', '仓库', '青铜钥匙', '木箱'],
                keywords: ['小王', '仓库', '钥匙', '青铜钥匙', '木箱', '藏'],
                isSecret: true
            }
        ],
        epistemicGrants: [
            { npcId: '小王', factId: 'fact_visit_warehouse', sourceType: 'ACTOR', learnedAtMsg: 2, confidence: 1.0 },
            { npcId: '小王', factId: 'fact_hide_key', sourceType: 'ACTOR', learnedAtMsg: 2, confidence: 1.0 },
            { npcId: '小李', factId: 'fact_visit_warehouse', sourceType: 'WITNESS', learnedAtMsg: 2, confidence: 0.98 },
            { npcId: '小李', factId: 'fact_hide_key', sourceType: 'WITNESS', learnedAtMsg: 2, confidence: 0.98 }
        ]
    });

    // 第 4 楼：小李只告诉小张“小王去过仓库”，没提钥匙
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

/* ------------------------------------------------------------------ */
/* 增量建图标记解析                                                     */
/* ------------------------------------------------------------------ */
export async function parseAndApplyGraphMarkup(messageText, messageId, targetGraph = graph) {
    if (!messageText || typeof messageText !== 'string') return false;
    let updated = false;

    const deltaRegex = /<ta_graph_delta>([\s\S]*?)<\/ta_graph_delta>/g;
    let match;
    while ((match = deltaRegex.exec(messageText)) !== null) {
        try {
            const payload = JSON.parse(match[1].trim());
            const eventId = payload.eventId || `evt_msg_${messageId}_${Date.now()}`;
            await targetGraph.ingestEvent({
                event: {
                    id: eventId,
                    messageId,
                    timestamp: payload.timestamp || `第${messageId}楼`,
                    location: payload.location || '未知地点',
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
            log('从 <ta_graph_delta> 建图成功', eventId);
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
                log('从 <graph_op> 传播事实成功', op.from, '->', op.to);
            }
        } catch (err) {
            console.error(MODULE, '解析 <graph_op> 失败:', err);
        }
    }

    return updated;
}

/* ------------------------------------------------------------------ */
/* 发言角色解析                                                         */
/* ------------------------------------------------------------------ */
function resolveActiveNpc() {
    const context = getContext();
    const settings = getSettings();
    if (settings.speakerMode === 'manual' && settings.activeSpeaker) {
        return settings.activeSpeaker.trim();
    }
    const name2 = context?.name2;
    if (name2) return name2;
    const chars = context?.characters;
    if (Array.isArray(chars) && chars.length > 0) return chars[0].name;
    return '';
}

/* ------------------------------------------------------------------ */
/* 生成拦截器                                                          */
/* ------------------------------------------------------------------ */
globalThis.epistemicGraphInterceptor = async function (chat, contextSize, abort, type) {
    const settings = getSettings();
    if (!settings.enabled || !Array.isArray(chat) || chat.length === 0) return;

    const npc = resolveActiveNpc();
    if (!npc) {
        log('拦截器：无法确定当前发言角色，跳过');
        return;
    }

    const totalMessages = chat.length;
    const recentWindow = Math.max(4, Number(settings.recentWindowSize) || 16);
    const cutoff = Math.max(0, totalMessages - recentWindow);

    if (cutoff > 0) chat.splice(0, cutoff);

    if (settings.maskAbsentHistory) {
        for (let i = 0; i < chat.length - 1; i++) {
            const msgId = chat[i]?.mes_id ?? (cutoff + i);
            const present = graph.messagePresence.get(msgId);
            if (present && !present.has(npc)) {
                chat[i] = { ...chat[i], mes: `[第${msgId}楼历史隔离：该事件发生时 ${npc} 不在场，无现场记忆]` };
            }
        }
    }

    const queryText = chat.slice(-2).map(m => m?.mes || '').join('\n');
    const { activeFacts, historicalFacts } = await graph.retrieveContextForNpc({
        npcId: npc,
        queryText,
        currentMsgId: totalMessages,
        topK: Number(settings.topK) || 8
    });

    const prompt = graph.buildEpistemicPrompt({ npcId: npc, activeFacts, historicalFacts });
    setExtensionPrompt(PROMPT_TAG, prompt, extension_prompt_types.IN_CHAT, 1);

    log(`拦截器注入完成 | 角色=${npc} | 召回=${activeFacts.length} 条 | 总楼层=${totalMessages} | 裁剪=${cutoff}`);
    if (settings.debugLog) {
        console.log(MODULE, '注入内容:\n' + prompt);
    }
};

/* ------------------------------------------------------------------ */
/* 与当前聊天同步                                                       */
/* ------------------------------------------------------------------ */
async function syncCurrentChatGraph() {
    const context = getContext();
    const chatId = context?.chatId;
    if (!chatId) {
        updateStatus('未打开聊天，图谱未挂载');
        return;
    }
    const saved = await storage.loadGraph(chatId);
    if (saved) {
        graph.deserialize(saved);
        log('已从 IndexedDB 载入图谱', chatId, '事实数=', graph.facts.size);
    } else if (getSettings().autoSeed) {
        await seedMvpWarehouseScenario(graph);
        await storage.saveGraph(chatId, graph.serialize());
        log('首次进入该聊天，已写入测试图谱');
    }
    updateStatus();
}

async function persistGraph() {
    const chatId = getContext()?.chatId;
    if (!chatId) return;
    await storage.saveGraph(chatId, graph.serialize());
}

/* ------------------------------------------------------------------ */
/* 面板                                                                */
/* ------------------------------------------------------------------ */
const PANEL_HTML = `
<div id="eg_panel_root" class="epistemic-graph-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Epistemic GraphRAG · 知情边界与长期记忆</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="eg-status" id="eg_status">加载中…</div>

      <label class="checkbox_label">
        <input id="eg_enabled" type="checkbox" ${getSettings().enabled ? 'checked' : ''} />
        <span>启用知情边界拦截与图谱检索</span>
      </label>
      <label class="checkbox_label">
        <input id="eg_mask" type="checkbox" ${getSettings().maskAbsentHistory ? 'checked' : ''} />
        <span>遮蔽当前角色不在场的历史楼层</span>
      </label>
      <label class="checkbox_label">
        <input id="eg_debug" type="checkbox" ${getSettings().debugLog ? 'checked' : ''} />
        <span>控制台输出注入内容（调试）</span>
      </label>

      <div class="eg-row">
        <label>当前发言角色</label>
        <select id="eg_speaker_mode" class="text_pole">
          <option value="follow">跟随当前角色卡（name2）</option>
          <option value="manual">手动指定</option>
        </select>
        <input id="eg_speaker" class="text_pole" type="text" placeholder="手动指定角色名" />
      </div>

      <div class="eg-row">
        <label>短期原文窗口（楼）</label>
        <input id="eg_window" class="text_pole" type="number" min="4" max="64" />
      </div>
      <div class="eg-row">
        <label>召回条数 Top-K</label>
        <input id="eg_topk" class="text_pole" type="number" min="1" max="24" />
      </div>

      <div class="eg-actions">
        <button id="eg_seed" class="menu_button" type="button">载入测试图谱</button>
        <button id="eg_preview" class="menu_button" type="button">预览本次注入</button>
        <button id="eg_stats" class="menu_button" type="button">刷新状态</button>
      </div>

      <pre id="eg_output" class="eg-inspector">点“预览本次注入”查看当前角色到底能看见什么。</pre>
    </div>
  </div>
</div>`;

function bindPanel() {
    const $ = jQuery;
    const s = getSettings();

    $('#eg_enabled').prop('checked', s.enabled).on('change', function () {
        s.enabled = Boolean($(this).prop('checked')); persistSettings();
    });
    $('#eg_mask').prop('checked', s.maskAbsentHistory).on('change', function () {
        s.maskAbsentHistory = Boolean($(this).prop('checked')); persistSettings();
    });
    $('#eg_debug').prop('checked', s.debugLog).on('change', function () {
        s.debugLog = Boolean($(this).prop('checked')); persistSettings();
    });
    $('#eg_speaker_mode').val(s.speakerMode).on('change', function () {
        s.speakerMode = String($(this).val()); persistSettings();
    });
    $('#eg_speaker').val(s.activeSpeaker).on('input', function () {
        s.activeSpeaker = String($(this).val()); persistSettings();
    });
    $('#eg_window').val(s.recentWindowSize).on('change', function () {
        s.recentWindowSize = Number($(this).val()) || 16; persistSettings();
    });
    $('#eg_topk').val(s.topK).on('change', function () {
        s.topK = Number($(this).val()) || 8; persistSettings();
    });

    $('#eg_seed').on('click', async () => {
        await seedMvpWarehouseScenario(graph);
        await persistGraph();
        updateStatus();
        toast('已载入测试图谱：小王 / 小李 / 小张');
        $('#eg_output').text('测试图谱已就绪。切到“预览本次注入”，把发言角色分别设为 小王 / 小李 / 小张 对比结果。');
    });

    $('#eg_stats').on('click', () => updateStatus());

    $('#eg_preview').on('click', async () => {
        const npc = resolveActiveNpc();
        if (!npc) { $('#eg_output').text('无法确定当前发言角色：请打开一个角色聊天，或改为手动指定。'); return; }
        const ctx = getContext();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        const query = (chat[chat.length - 1]?.mes || '') + '\n' + (chat[chat.length - 2]?.mes || '');
        const res = await graph.retrieveContextForNpc({
            npcId: npc,
            queryText: query,
            currentMsgId: chat.length,
            topK: Number(getSettings().topK) || 8
        });
        const prompt = graph.buildEpistemicPrompt({
            npcId: npc,
            activeFacts: res.activeFacts,
            historicalFacts: res.historicalFacts
        });
        $('#eg_output').text(
            `【角色】${npc}\n【召回】${res.activeFacts.length} 条有效 / ${res.historicalFacts.length} 条旧状态\n` +
            `──────────────\n${prompt}`
        );
        log('预览', npc, res);
    });

    updateStatus();
}

function updateStatus(extra) {
    const $ = jQuery;
    if (!$ || !$('#eg_status')?.length) return;
    const ctx = getContext();
    const npc = resolveActiveNpc();
    const lines = [
        `聊天ID：${ctx?.chatId || '（未打开）'}`,
        `发言角色：${npc || '（未识别）'}`,
        `NPC 节点：${graph.npcs.size}　事件：${graph.events.size}　事实：${graph.facts.size}`,
        `认知边：${Array.from(graph.knowledgeEdges.values()).reduce((a, m) => a + m.size, 0)}`
    ];
    if (extra) lines.push(extra);
    $('#eg_status').text(lines.join('　|　'));
}

function mountPanel() {
    if (typeof jQuery === 'undefined') return false;
    if (document.getElementById('eg_panel_root')) return true;
    const target =
        document.querySelector('#extensions_settings2') ||
        document.querySelector('#extensions_settings');
    if (!target) return false;
    target.insertAdjacentHTML('beforeend', PANEL_HTML);
    bindPanel();
    console.log(MODULE, '设置面板已挂载到', target.id);
    return true;
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */
let mounted = false;
function tryMount(times = 0) {
    if (mountPanel()) {
        mounted = true;
        return;
    }
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
            await syncCurrentChatGraph();
        });

        eventSource.on(event_types.MESSAGE_RECEIVED, async (messageIndex) => {
            const ctx = getContext();
            const msg = ctx?.chat?.[messageIndex];
            if (!msg?.mes) return;
            const changed = await parseAndApplyGraphMarkup(msg.mes, messageIndex, graph);
            if (changed) await persistGraph();
            if (mounted) updateStatus();
        });

        console.log(MODULE, '初始化完成');
    } catch (err) {
        console.error(MODULE, '初始化异常:', err);
    }
});
