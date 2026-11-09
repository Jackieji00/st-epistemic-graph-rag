import { getContext, extension_settings } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    setExtensionPrompt,
    extension_prompt_types,
    getRequestHeaders
} from '../../../../script.js';
import { GraphStorage } from './db_store.js';
import { EmbeddingService } from './embedding_service.js';
import { LongTermEpistemicGraph } from './long_term_graph_rag.js';

const EXTENSION_NAME = 'st-epistemic-graph-rag';
const PROMPT_TAG = 'epistemic_graph_rag';

const defaultSettings = {
    enabled: true,
    activeSpeaker: '',
    recentWindowSize: 16,
    topK: 8,
    maskAbsentHistory: true,
    enableVectorApi: true
};

const storage = new GraphStorage();
const embedder = new EmbeddingService({ getRequestHeaders });
export const graph = new LongTermEpistemicGraph(embedder);

function getSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = { ...defaultSettings };
    }
    return extension_settings[EXTENSION_NAME];
}

/**
 * 预置第一版 MVP 验证场景：3 个 NPC（小王、小李、小张）、1 个藏钥匙秘密、1 次部分告知
 */
export async function seedMvpWarehouseScenario(targetGraph = graph) {
    targetGraph.ensureNpc('小王', '小王');
    targetGraph.ensureNpc('小李', '小李');
    targetGraph.ensureNpc('小张', '小张');

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

    // 第 4 楼：小李告诉小张“小王去过仓库”，但未透露钥匙的存在
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

/**
 * 解析回复正文内嵌的 <ta_graph_delta> 或 <graph_op> 增量建图指令
 */
export async function parseAndApplyGraphMarkup(messageText, messageId, targetGraph = graph) {
    if (!messageText || typeof messageText !== 'string') return false;
    let updated = false;

    // 1. 解析 <ta_graph_delta>{...}</ta_graph_delta> 完整事件+事实+认知边增量块
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
        } catch (err) {
            console.error('[EpistemicGraphRAG] 解析 <ta_graph_delta> 失败:', err);
        }
    }

    // 2. 解析 <graph_op>{"type":"TELL", ...}</graph_op> 角色间口头告知指令
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
            }
        } catch (err) {
            console.error('[EpistemicGraphRAG] 解析 <graph_op> 失败:', err);
        }
    }

    return updated;
}

/**
 * SillyTavern 生成前拦截器：
 * 1. 百楼滑动窗口裁剪（移除超出窗口的早期原文）
 * 2. 物理遮蔽当前发言 NPC 不在场的楼层
 * 3. 从该 NPC 的认知子图中混合检索 Top-K 事实并注入 Depth 1
 */
globalThis.epistemicGraphInterceptor = async function (chat, contextSize, abort, type) {
    const settings = getSettings();
    if (!settings.enabled || !Array.isArray(chat) || chat.length === 0) return;

    const context = getContext();
    const activeNpc = (settings.activeSpeaker && settings.activeSpeaker.trim()) || context.name2;
    if (!activeNpc) return;

    const totalMessages = chat.length;
    const recentWindow = Math.max(4, Number(settings.recentWindowSize) || 16);
    const cutoffIndex = Math.max(0, totalMessages - recentWindow);

    // 1. 百楼滑动窗口裁剪：超出窗口的历史原文移出本次请求副本，交由 GraphRAG 长期记忆接管
    if (cutoffIndex > 0) {
        chat.splice(0, cutoffIndex);
    }

    // 2. 对窗口内楼层执行“不在场物理遮蔽”
    if (settings.maskAbsentHistory) {
        for (let i = 0; i < chat.length - 1; i++) {
            const msgId = chat[i].mes_id ?? (cutoffIndex + i);
            const presentSet = graph.messagePresence.get(msgId);
            if (presentSet && !presentSet.has(activeNpc)) {
                chat[i] = {
                    ...chat[i],
                    mes: `[第${msgId}楼历史隔离：该事件发生时 ${activeNpc} 不在场，无现场记忆]`
                };
            }
        }
    }

    // 3. 混合检索该角色认知边界内的长期记忆
    const queryText = chat.slice(-2).map(m => m.mes || '').join('\n');
    const { activeFacts, historicalFacts } = await graph.retrieveContextForNpc({
        npcId: activeNpc,
        queryText,
        currentMsgId: totalMessages,
        topK: Number(settings.topK) || 8
    });

    // 4. 组装强边界认知提示词并挂载到 Depth 1
    const epistemicPrompt = graph.buildEpistemicPrompt({
        npcId: activeNpc,
        activeFacts,
        historicalFacts
    });

    setExtensionPrompt(
        PROMPT_TAG,
        epistemicPrompt,
        extension_prompt_types.IN_CHAT,
        1
    );
};

async function syncCurrentChatGraph() {
    const context = getContext();
    const chatId = context?.chatId;
    if (!chatId) return;
    const saved = await storage.loadGraph(chatId);
    if (saved) {
        graph.deserialize(saved);
    } else {
        await seedMvpWarehouseScenario(graph);
        await storage.saveGraph(chatId, graph.serialize());
    }
}

function mountExtensionSettingsUi() {
    if (typeof jQuery === 'undefined') return;
    const settings = getSettings();
    const html = `
    <div class="epistemic-graph-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Epistemic GraphRAG (多角色知情边界与百楼记忆)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input id="eg_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} />
                    <span>启用知情边界拦截与 GraphRAG 检索</span>
                </label>
                <label class="checkbox_label">
                    <input id="eg_mask_absent" type="checkbox" ${settings.maskAbsentHistory ? 'checked' : ''} />
                    <span>物理遮蔽当前角色不在场的历史楼层</span>
                </label>
                <div class="eg-row">
                    <label for="eg_active_speaker">当前受询/发言 NPC（留空默认跟随当前角色卡）：</label>
                    <input id="eg_active_speaker" class="text_pole" type="text" placeholder="例如：小张 / 小李 / 小王" value="${settings.activeSpeaker || ''}" />
                </div>
                <div class="eg-row">
                    <label for="eg_window_size">短期原文滑动窗口楼层数（其余百楼历史转入图谱检索）：</label>
                    <input id="eg_window_size" class="text_pole" type="number" min="4" max="64" value="${settings.recentWindowSize}" />
                </div>
                <div class="eg-actions">
                    <button id="eg_seed_mvp" class="menu_button" type="button">重置并载入“三NPC仓库藏钥匙”测试图谱</button>
                </div>
                <pre id="eg_inspector" class="eg-inspector"></pre>
            </div>
        </div>
    </div>`;

    jQuery('#extensions_settings2').append(html);

    const refreshInspector = () => {
        const stats = {
            npcs: Array.from(graph.npcs.keys()),
            totalEvents: graph.events.size,
            totalFacts: graph.facts.size,
            edgesByNpc: Object.fromEntries(
                Array.from(graph.knowledgeEdges.entries()).map(([k, m]) => [k, Array.from(m.keys())])
            )
        };
        jQuery('#eg_inspector').text(JSON.stringify(stats, null, 2));
    };

    jQuery('#eg_enabled').on('change', function () {
        getSettings().enabled = Boolean(jQuery(this).prop('checked'));
    });
    jQuery('#eg_mask_absent').on('change', function () {
        getSettings().maskAbsentHistory = Boolean(jQuery(this).prop('checked'));
    });
    jQuery('#eg_active_speaker').on('input', function () {
        getSettings().activeSpeaker = String(jQuery(this).val() || '').trim();
    });
    jQuery('#eg_window_size').on('change', function () {
        getSettings().recentWindowSize = Number(jQuery(this).val()) || 16;
    });
    jQuery('#eg_seed_mvp').on('click', async function () {
        await seedMvpWarehouseScenario(graph);
        const chatId = getContext()?.chatId;
        if (chatId) await storage.saveGraph(chatId, graph.serialize());
        refreshInspector();
    });

    refreshInspector();
}

if (typeof jQuery !== 'undefined') {
    jQuery(async () => {
        await syncCurrentChatGraph();
        mountExtensionSettingsUi();

        eventSource.on(event_types.CHAT_CHANGED, async () => {
            await syncCurrentChatGraph();
        });

        eventSource.on(event_types.MESSAGE_RECEIVED, async (messageIndex) => {
            const context = getContext();
            const msg = context?.chat?.[messageIndex];
            if (!msg || !msg.mes) return;
            const changed = await parseAndApplyGraphMarkup(msg.mes, messageIndex, graph);
            if (changed && context?.chatId) {
                await storage.saveGraph(context.chatId, graph.serialize());
            }
        });
    });
}
