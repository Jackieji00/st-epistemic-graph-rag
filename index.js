import { getContext, extension_settings } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    setExtensionPrompt,
    extension_prompt_types,
    saveSettings, saveSettingsDebounced
} from '../../../../script.js';
import { GraphStorage } from './db_store.js';
import { EmbeddingService } from './embedding_service.js';
import { LongTermEpistemicGraph } from './long_term_graph_rag.js';
import { importGraphJson as importGraphJsonImpl, exportGraphJson as exportGraphJsonImpl } from './graph_io.js';
import { summaryBook, planSources, nextBatch, decodeBatch, updateCoverage, extractionRules, filterConvertedArchive } from './backfill.js';
import { mountMemoryWand, refreshMemoryPanel } from './memory_panel.js';
import { generateSummary, normalizeProviderConfig, setSessionApiKey, testProviderApi } from './provider_api.js';

const MODULE = '[EpistemicGraphRAG]';
const EXTENSION_NAME = 'st-epistemic-graph-rag';
const PROMPT_TAG = 'epistemic_graph_rag';
const BUILD_PROMPT_TAG = 'epistemic_graph_rag_build';
const PERSPECTIVE_TAG = 'epistemic_graph_perspective';
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
    debugLog: false,
    backfillMode: 'gap',
    summaryApi: { mode: 'tavern' },
    vectorApi: { mode: 'disabled' }
};

const storage = new GraphStorage();
const embedder = new EmbeddingService({ getConfig: () => getSettings().vectorApi });
export const graph = new LongTermEpistemicGraph(embedder);
let activeGraphChatId = '';
let generationEpoch = 0;
let receiveQueue = Promise.resolve();
let backfillJob = null;
let memoryProgress = '可开始或继续当前聊天的回填';

function setMemoryProgress(text) {
    memoryProgress = text;
    jQuery('#eg_backfill_progress').text(text);
    refreshMemoryPanel();
}

function stopMemoryJob() {
    if (!backfillJob) return;
    backfillJob.stop = true;
    setMemoryProgress('正在停止；当前操作返回后即可继续');
}

function clearGenerationPrompts() {
    setExtensionPrompt(PERSPECTIVE_TAG, '', extension_prompt_types.IN_CHAT, 1);
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
            const refused = await targetGraph.ingestEvent({
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
                    learnedAtMsg: messageId
                }))
            });
            updated = true;
            if (refused.length) log('能力或证据不足，跳过授权', refused.map(g => [g.npcId, g.factId]));
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
                const granted = targetGraph.propagateFact({
                    fromNpcId: op.from,
                    toNpcId: op.to,
                    factId: op.factId,
                    learnedAtMsg: messageId,
                    confidence: op.confidence ?? 0.85,
                    partialOrDistortedText: op.text || null,
                    isFalseRumor: Boolean(op.isFalseRumor)
                });
                if (granted) {
                    updated = true;
                    log('事实传播', op.from, '->', op.to, op.factId);
                }
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
    return context?.characters?.[context.characterId]?.name || '';
}

/* ---------------------------- 拦截器 ------------------------------ */
function narrativeText(message) {
    const text = message?.mes;
    if (typeof text !== 'string' || message.is_user || message.is_system) return text;
    return text.replace(/<(ta_graph_delta|graph_op)>[\s\S]*?(?:<\/\1>|$)/g, '');
}

function isKnownAbsent(npc, floor) {
    const present = graph.messagePresence.get(floor);
    return present?.size > 0 && !present.has(npc);
}

function recentSceneQuery(chat, floors, npc) {
    const lines = [];
    for (let i = chat.length - 1; i >= 0 && lines.length < 2; i--) {
        if (chat[i]?.is_system || isKnownAbsent(npc, floors[i])) continue;
        const text = narrativeText(chat[i]);
        if (typeof text === 'string' && text.trim()) lines.unshift(text);
    }
    return lines.join('\n');
}

globalThis.epistemicGraphInterceptor = async function (chat, contextSize, abort, type) {
    clearGenerationPrompts();
    const epoch = ++generationEpoch;
    const settings = getSettings();
    if (!settings.enabled || !ASSISTANT_GENERATION_TYPES.has(type) || !Array.isArray(chat) || chat.length === 0) return;

    // The host passes a generation copy. Keep stored graph markup for MESSAGE_RECEIVED.
    for (let i = 0; i < chat.length; i++) {
        const mes = narrativeText(chat[i]);
        if (mes !== chat[i]?.mes) chat[i] = { ...chat[i], mes };
    }

    const context = getContext();
    const chatId = context?.chatId;
    if (!chatId || activeGraphChatId !== chatId) return;

    const npc = resolveActiveNpc();
    if (!npc) return;

    if (event_types.CHAT_COMPLETION_SETTINGS_READY) eventSource.makeLast?.(event_types.CHAT_COMPLETION_SETTINGS_READY, filterOutgoingArchive);
    const floors = graph.sourceFloors(chat, context.chat);
    const totalMessages = chat.length;
    const originalFloorCount = context.chat?.length || totalMessages;
    graph.restrictSceneDetails(chat, npc, context.chat, floors);
    if (settings.maskAbsentHistory) {
        for (let i = 0; i < chat.length; i++) {
            if (i === chat.length - 1 && chat[i]?.is_user) continue;
            const floor = floors[i];
            if (isKnownAbsent(npc, floor)) {
                chat[i] = { ...chat[i], mes: `[第${floor}楼历史隔离：该事件发生时 ${npc} 不在场，无现场记忆]` };
            }
        }
    }
    const queryText = recentSceneQuery(chat, floors, npc);
    const { activeFacts, historicalFacts } = await graph.retrieveContextForNpc({
        npcId: npc,
        queryText,
        currentMsgId: originalFloorCount,
        topK: Number(settings.topK) || 8
    });

    // Retrieval is asynchronous; never apply a result after the user switched chats or speakers.
    if (epoch !== generationEpoch || !getSettings().enabled || getContext()?.chatId !== chatId || resolveActiveNpc() !== npc || activeGraphChatId !== chatId) return;

    setExtensionPrompt(PERSPECTIVE_TAG, graph.perspectiveFor(npc), extension_prompt_types.IN_CHAT, 1);

    if (type !== 'continue') {
        const npcIdSlug = Array.from(npc, char => /[A-Za-z0-9_-]/.test(char) ? char : `u${char.codePointAt(0).toString(16)}`).join('_');
        setExtensionPrompt(BUILD_PROMPT_TAG, `${GRAPH_RULES_TEXT}\n\nAdditional constraints:\n- Prefix every fact ID with this assistant turn's stable identifier: turn_${originalFloorCount}_${npcIdSlug}; add a per-turn sequence number. Reuse the same stable NPC name already present in this graph; do not create alternate names for the same person.\n- Grant each fact only to named characters who directly experienced it or learned it through an explicit in-story source. A card or world name is not itself evidence that everyone knows its contents.\n- Keep fact visibility scoped to each NPC's actual knowledge; do not grant world-level facts to all characters by default.`, extension_prompt_types.IN_CHAT, 1);
    }

    if (!activeFacts.length && !historicalFacts.length) {
        log(`拦截器：${npc} 无可召回的图谱记忆`);
        return;
    }

    const prompt = graph.buildEpistemicPrompt({ npcId: npc, activeFacts, historicalFacts });
    setExtensionPrompt(PROMPT_TAG, prompt, extension_prompt_types.IN_CHAT, 1);

    const recentWindow = Math.max(4, Number(settings.recentWindowSize) || 16);
    const cutoff = Math.max(0, totalMessages - recentWindow);
    if (cutoff > 0) {
        const sourceChat = getContext()?.chat || [];
        for (let i = Math.min(cutoff, chat.length) - 1; i >= 0; i--) {
            const msg = chat[i];
            const floor = floors[i];
            if (graph.isCoveredFloor(floor, msg, sourceChat)) chat.splice(i, 1);
        }
    }

    if (settings.debugLog) {
        console.log(MODULE, `注入 | 角色=${npc} | 召回=${activeFacts.length} | 楼层=${totalMessages} | 裁剪=${cutoff}\n` + prompt);
    }
};

async function filterOutgoingArchive(data) {
    const ctx = getContext();
    if (getSettings().enabled && activeGraphChatId && activeGraphChatId === ctx?.chatId && resolveActiveNpc()) await filterConvertedArchive(data, ctx, graph);
}

async function startBackfill(mode = 'gap') {
    if (backfillJob) return;
    const ctx = getContext(), chatId = ctx?.chatId;
    if (!ctx || !chatId || chatId !== activeGraphChatId || !Array.isArray(ctx.chat)) {
        toast('当前环境不支持回填或尚未载入聊天', 'warning'); return;
    }
    const bookName = summaryBook(ctx);
    const onlyBook = mode === 'book';
    getSettings().backfillMode = onlyBook ? 'book' : 'gap';
    jQuery('#eg_backfill_mode').val(getSettings().backfillMode);
    persistSettings();
    const job = backfillJob = { stop: false, chatId };
    setMemoryProgress('正在核对当前聊天的来源');
    const setProgress = text => {
        if (backfillJob === job && getContext()?.chatId === chatId) setMemoryProgress(text);
    };
    const active = () => !job.stop && backfillJob === job && activeGraphChatId === chatId && getContext()?.chatId === chatId;
    async function readSources() {
        const live = getContext();
        if (!active() || summaryBook(live) !== bookName) throw Error('聊天或总结书已切换');
        const book = bookName ? await live.loadWorldInfo(bookName) : null;
        if (bookName && !book) throw Error('无法读取当前聊天的总结书');
        if (!active() || summaryBook(getContext()) !== bookName) throw Error('聊天或总结书已切换');
        return planSources(getContext(), bookName, book, onlyBook);
    }
    let completed = 0;
    try {
        while (active()) {
            const sources = await readSources();
            const batch = nextBatch(sources, graph);
            const keys = new Set(sources.map(s => s.key));
            const obsolete = [...graph.events.values()].filter(e => e.backfill && !keys.has(e.id) && (!onlyBook || e.backfill.book)).map(e => e.id);
            if (!batch.length && !obsolete.length) {
                if (onlyBook && !sources.length) {
                    setProgress(bookName ? '没有可核对来源的总结条目，可选择世界书优先补缺' : '当前聊天没有绑定大总结世界书，可选择世界书优先补缺');
                    return;
                }
                break;
            }
            let decoded = [];
            if (batch.length) {
                setProgress('生成中：已保存 ' + completed + ' 个来源；本批 ' + batch.length + ' 个');
                const prompt = batch.map((s, i) => 'SOURCE ' + i + '\n' + s.text).join('\n\n');
                const raw = await generateSummary(getSettings().summaryApi, { systemPrompt: extractionRules, prompt, responseLength: 4096 }, ctx);
                if (!active()) break;
                decoded = decodeBatch(raw, batch);
            }
            const saveBatch = receiveQueue.then(async () => {
                if (!active()) return;
                const staged = new LongTermEpistemicGraph(embedder);
                staged.deserialize(graph.serialize());
                const replace = new Set([...obsolete, ...batch.map(s => s.key)]);
                for (const [id, fact] of staged.facts) {
                    if (!replace.has(fact.eventId)) continue;
                    staged.facts.delete(id);
                    for (const entity of fact.entities) staged.entities.get(entity)?.delete(id);
                    for (const edges of staged.knowledgeEdges.values()) edges.delete(id);
                }
                for (const id of replace) staged.events.delete(id);
                for (const item of decoded) {
                    item.event.backfill.usable = item.facts.length > 0;
                    await staged.ingestEvent(item);
                }
                if (!active()) return;
                const verified = await readSources();
                const stamps = new Map(verified.map(s => [s.key, s.stamp]));
                if (batch.some(s => stamps.get(s.key) !== s.stamp) || obsolete.some(id => stamps.has(id))) throw Error('来源已变化，请重新回填');
                updateCoverage(staged, verified);
                const data = staged.serialize();
                await storage.saveGraph(chatId, data);
                if (getContext()?.chatId === chatId && activeGraphChatId === chatId) graph.deserialize(data);
                completed += batch.length;
                if (mounted) updateStatus();
            });
            receiveQueue = saveBatch.catch(err => console.error(MODULE, '回填批次未保存', err));
            await saveBatch;
        }
        setProgress(job.stop ? '已停止；已保存 ' + completed + ' 个来源，可恢复' : '回填完成；处理 ' + completed + ' 个来源');
    } catch (e) {
        setProgress('回填暂停：' + e.message);
        console.error(MODULE, '长聊天回填失败:', e);
    } finally {
        if (backfillJob === job) backfillJob = null;
        refreshMemoryPanel();
    }
}

async function reindexVectors() {
    const chatId = getContext()?.chatId;
    if (!chatId || chatId !== activeGraphChatId || backfillJob) return;
    const space = embedder.spaceId;
    if (!space) { setMemoryProgress('先在向量 API 中选择连接并保存'); return; }
    const pending = [...graph.facts.values()].filter(f => !f.embedding?.length || f.embeddingSpace !== space);
    if (!pending.length) { setMemoryProgress('当前聊天没有需要补向量的事实'); return; }
    const job = backfillJob = { chatId, stop: false };
    const active = () => backfillJob === job && !job.stop && getContext()?.chatId === chatId && embedder.spaceId === space;
    let done = 0;
    try {
        for (let start = 0; start < pending.length && active(); start += 12) {
            const batch = pending.slice(start, start + 12);
            const vectors = new Map();
            for (const fact of batch) {
                if (!active()) break;
                setMemoryProgress(`补向量 · 已保存 ${done}/${pending.length}，正在处理第 ${start + vectors.size + 1} 条`);
                vectors.set(fact.id, await embedder.embedText(fact.content, { strict: true }));
            }
            if (!active()) break;
            const save = receiveQueue.then(async () => {
                if (!active()) return;
                const data = graph.serialize();
                const facts = new Map(data.facts);
                let added = 0;
                for (const f of batch) {
                    const record = facts.get(f.id);
                    if (!record || record.content !== f.content) continue;
                    record.embedding = Array.from(vectors.get(f.id));
                    record.embeddingSpace = space;
                    added++;
                }
                if (!added) return;
                await storage.saveGraph(chatId, data);
                if (activeGraphChatId === chatId && getContext()?.chatId === chatId) graph.deserialize(data);
                done += added;
            });
            receiveQueue = save.catch(err => console.error(MODULE, '保存向量失败', err));
            await save;
        }
        if (backfillJob === job) setMemoryProgress(`${job.stop ? '已停止' : '补向量完成'} · 已保存 ${done} 条`);
    } catch (err) {
        if (backfillJob === job) setMemoryProgress('补向量暂停 · ' + err.message);
    } finally {
        if (backfillJob === job) backfillJob = null;
        refreshMemoryPanel();
    }
}

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
6. For any setting, split a plainly perceptible cue from its interpretation. On a fact, mark easy-to-miss cues with "subtle":true and set "requiresAbilities" to the exact established ability names needed to perceive or interpret it. Ordinary observations need no ability. Names are story-specific. Never invent a skill or grant everyone a detail just because they share a scene.
7. For a subtle or skilled direct observation, include "noticedCue" on the grant: the concrete opportunity, access and attention during this scene. For INFERRED, list the IDs of clues already known to that character in "basisFactIds". Keep uncertain interpretations as guesses in prose. Mere presence, profession, a narrator's statement or the correct answer itself cannot supply a premise. Grant testimony separately as what the listener heard.
8. If nothing graph-worthy happened, still emit the block with empty arrays.`;

/* ---------------------------- 面板 -------------------------------- */
const wandActions = {
    getState() {
        const ctx = getContext();
        const s = getSettings();
        const hasChat = !!ctx?.chatId && ctx.chatId === activeGraphChatId;
        const manager = ctx?.ConnectionManagerRequestService;
        const profiles = manager && ctx.extensionSettings?.connectionManager?.profiles &&
            !ctx.extensionSettings.disabledExtensions?.includes('connection-manager')
            ? manager.getSupportedProfiles().map(({ id, name }) => ({ id, name })) : [];
        const space = embedder.spaceId;
        return {
            chatName: ctx?.chatId || '', hasChat, progress: memoryProgress,
            running: !!backfillJob, mode: s.backfillMode, profiles,
            factCount: hasChat ? graph.facts.size : 0,
            vectorCount: hasChat && space ? [...graph.facts.values()].filter(f => f.embedding?.length && f.embeddingSpace === space).length : 0,
            summaryApi: { ...s.summaryApi }, vectorApi: { ...s.vectorApi },
        };
    },
    async saveApis({ summary, vector }) {
        if (backfillJob) throw Error('请在当前记忆任务结束后保存连接');
        const summaryApi = normalizeProviderConfig('summary', summary);
        const vectorApi = normalizeProviderConfig('vector', vector);
        const settings = getSettings();
        const previous = { summaryApi: settings.summaryApi, vectorApi: settings.vectorApi };
        Object.assign(settings, { summaryApi, vectorApi });
        // The host catches save errors itself and emits SETTINGS_UPDATED only on success.
        let confirmed = false;
        const onSaved = () => { confirmed = true; };
        eventSource.on(event_types.SETTINGS_UPDATED, onSaved);
        try {
            await saveSettings();
            if (!confirmed) throw Error('酒馆尚未确认保存，请稍后重试');
        } catch (error) {
            Object.assign(settings, previous);
            throw error;
        } finally {
            eventSource.removeListener(event_types.SETTINGS_UPDATED, onSaved);
        }
        for (const [kind, config, draft] of [['summary', summaryApi, summary], ['vector', vectorApi, vector]]) {
            if (config.mode === 'openai-compatible' && (draft.apiKey || draft.apiKey === null)) {
                setSessionApiKey(kind, config, draft.apiKey);
            }
        }
        refreshMemoryPanel();
    },
    testApi(kind, draft) {
        const config = normalizeProviderConfig(kind, draft);
        return testProviderApi(kind, config, getContext(), draft.apiKey);
    },
    start: startBackfill, stop: stopMemoryJob, reindex: reindexVectors,
};

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
        <input id="eg_speaker" class="text_pole" type="text" placeholder="手动指定角色名" />
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
        <button id="eg_abilities" class="menu_button" type="button">编辑当前角色能力</button>
        <button id="eg_stats" class="menu_button" type="button">刷新状态</button>
        <button id="eg_rules" class="menu_button" type="button">复制建图规则</button>
        <button id="eg_clearlog" class="menu_button" type="button">清空输出</button>
      </div>

      <div class="eg-row">
        <label>长聊天回填</label>
        <select id="eg_backfill_mode" class="text_pole"><option value="gap">世界书优先补缺（默认）</option><option value="book">仅世界书</option></select>
        <button id="eg_backfill_start" class="menu_button" type="button">回填记忆</button>
        <button id="eg_backfill_stop" class="menu_button" type="button">停止回填</button>
      </div>
      <div id="eg_backfill_progress" class="eg-status">可恢复；每批单独保存。</div>

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
    $('#eg_speaker').val(s.activeSpeaker).on('input', function () { s.activeSpeaker = String($(this).val()); persistSettings(); });
    $('#eg_window').on('change', function () { s.recentWindowSize = Number($(this).val()) || 16; persistSettings(); });
    $('#eg_topk').on('change', function () { s.topK = Number($(this).val()) || 8; persistSettings(); });

    $('#eg_stats').on('click', () => updateStatus());
    $('#eg_backfill_mode').val(s.backfillMode);
    $('#eg_backfill_start').on('click', () => startBackfill(String($('#eg_backfill_mode').val() || 'gap')));
    $('#eg_backfill_stop').on('click', stopMemoryJob);
    $('#eg_abilities').on('click', async () => {
        if (backfillJob) { toast('回填期间不能修改图谱', 'warning'); return; }
        const npc = resolveActiveNpc();
        const chatId = getContext()?.chatId;
        if (!npc || !chatId || chatId !== activeGraphChatId) { toast('请先打开聊天并选择角色', 'warning'); return; }
        const before = graph.npcs.get(npc)?.abilities || [];
        const value = window.prompt(`${npc} 在这个故事里已确立的专长（用逗号分隔，留空可清除）`, before.join('，'));
        if (value === null) return;
        try {
            graph.setAbilities(npc, value.split(/[,，、\n]/).map(v => v.trim()).filter(Boolean));
            await persistGraph();
            updateStatus();
        } catch (e) { toast('保存角色能力失败：' + e.message, 'error'); }
    });
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
        if (backfillJob) { toast('回填期间不能导入图谱', 'warning'); return; }
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
        if (backfillJob) { toast('回填期间不能修改图谱', 'warning'); return; }
        await seedMvpWarehouseScenario(graph);
        await persistGraph();
        updateStatus();
        $('#eg_output').text('测试图谱已载入。把发言角色依次设为 小王 / 小李 / 小张 点「预览本次注入」对比。');
        toast('已载入测试图谱');
    });

    $('#eg_clear').on('click', async () => {
        if (backfillJob) { toast('回填期间不能清空图谱', 'warning'); return; }
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
        const history = chat.slice();
        const floors = graph.sourceFloors(history, chat);
        graph.restrictSceneDetails(history, npc, chat, floors);
        const query = recentSceneQuery(history, floors, npc);
        const res = await graph.retrieveContextForNpc({
            npcId: npc, queryText: query, currentMsgId: chat.length, topK: Number(s.topK) || 8
        });
        if (!res.activeFacts.length && !res.historicalFacts.length) {
            $('#eg_output').text(graph.perspectiveFor(npc) + '\n当前没有可召回的事实。');
            return;
        }
        const prompt = graph.buildEpistemicPrompt({ npcId: npc, activeFacts: res.activeFacts, historicalFacts: res.historicalFacts });
        $('#eg_output').text(
            `${graph.perspectiveFor(npc)}\n【召回】${res.activeFacts.length} 条有效 / ${res.historicalFacts.length} 条旧状态\n──────────────\n${prompt}`
        );
    });

    updateStatus();
}

function updateStatus(extra) {
    refreshMemoryPanel();
    const $ = jQuery;
    if (typeof $ === 'undefined' || !$('#eg_status')?.length) return;
    const ctx = getContext();
    const npc = resolveActiveNpc();
    const edges = Array.from(graph.knowledgeEdges.values()).reduce((a, m) => a + m.size, 0);
    const lines = [
        `聊天：${ctx?.chatId || '（未打开）'}`,
        `发言：${npc || '（未识别）'}`,
        `已登记专长：${graph.npcs.get(npc)?.abilities?.join('、') || '暂无'}`,
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
    const wandReady = mountMemoryWand(wandActions);
    if (mountPanel() && wandReady) { mounted = true; return; }
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
            if (backfillJob) {
                backfillJob.stop = true;
                backfillJob = null;
            }
            activeGraphChatId = '';
            setMemoryProgress('可开始或继续当前聊天的回填');
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
