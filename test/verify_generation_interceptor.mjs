import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EmbeddingService } from '../embedding_service.js';
import { LongTermEpistemicGraph } from '../long_term_graph_rag.js';
import * as backfill from '../backfill.js';

const projectRoot = new URL('../', import.meta.url);
let source = fs.readFileSync(new URL('index.js', projectRoot), 'utf8');
source = source.replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/\bexport\s+(?=(?:async\s+)?function|const|let|class)/g, '');

const prompts = new Map();
const handlers = new Map();
const settings = { 'st-epistemic-graph-rag': { enabled: true, speakerMode: 'follow', recentWindowSize: 16, topK: 8, maskAbsentHistory: true } };
const context = { chatId: 'legacy-chat', name2: 'Known NPC', characters: [{ name: 'Known NPC' }], chat: [] };
const graphInstance = new LongTermEpistemicGraph(new EmbeddingService({ enableRemoteVector: false }));
let readyPromise;
const loadCalls = [];
const saveCalls = [];

function jquery(arg) {
    if (typeof arg === 'function') {
        readyPromise = Promise.resolve().then(arg);
        return;
    }
    return { length: 0, on() { return this; }, val() { return this; }, text() { return this; }, prop() { return false; }, insertAdjacentHTML() {} };
}

const sandbox = {
    ...backfill,
    mountMemoryWand: () => true,
    refreshMemoryPanel: () => {},
    console,
    URL,
    Map,
    Set,
    JSON,
    Math,
    Number,
    Array,
    String,
    Boolean,
    Promise,
    RegExp,
    Object,
    Error,
    toastr: undefined,
    jQuery: jquery,
    extension_settings: settings,
    eventSource: { on: (event, handler) => handlers.set(event, handler) },
    event_types: { CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received' },
    extension_prompt_types: { IN_CHAT: 1 },
    setExtensionPrompt: (key, value) => prompts.set(key, value),
    getRequestHeaders: () => ({}),
    saveSettingsDebounced: () => {},
    getContext: () => context,
    GraphStorage: class {
        async loadGraph(chatId) { loadCalls.push(chatId); return null; }
        async saveGraph(chatId, serialized) { saveCalls.push({ chatId, serialized }); }
    },
    EmbeddingService: class { async embedText() { return null; } },
    LongTermEpistemicGraph: class { constructor() { return graphInstance; } },
    importGraphJsonImpl: async () => ({}),
    exportGraphJsonImpl: () => '{}',
    document: { getElementById: () => null, querySelector: () => null },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: () => 0,
    globalThis: null,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox, { filename: 'index.js' });
await readyPromise;

const interceptor = sandbox.epistemicGraphInterceptor;
assert.equal(typeof interceptor, 'function');
assert.equal(typeof handlers.get('message_received'), 'function');

const legacyChat = Array.from({ length: 100 }, (_, i) => ({ mes_id: i, name: i % 2 ? 'Known NPC' : '旁白', mes: `legacy floor ${i}` }));
legacyChat.push({ mes_id: 100, is_user: true, name: 'User', mes: 'Where is the key?' });
const legacyCopy = legacyChat.map(m => ({ ...m }));
const sealedReply = {
    name: '另一角色',
    mes: '第一句。<ta_graph_delta>{"facts":[{"content":"只有甲知道的口令"}]}</ta_graph_delta>第二句。<graph_op>{"type":"TELL"}</graph_op>',
};
const quotedUser = { is_user: true, mes: '这个标签是什么意思？<graph_op>示例</graph_op>' };
const newSpeakerChat = [sealedReply, { name: '另一角色', mes: '第三句。<ta_graph_delta>{"content":"未生成完的私密记录' }, quotedUser];
await interceptor(newSpeakerChat, 8192, () => {}, 'normal');
assert.deepEqual(newSpeakerChat.map(m => m.mes), ['第一句。第二句。', '第三句。', quotedUser.mes],
    'even with no recalled facts, prior assistant graph data must stay out of outbound history');
assert.ok(sealedReply.mes.includes('只有甲知道的口令'), 'stored assistant message must remain available for ingestion');
await interceptor(legacyChat, 8192, () => {}, 'normal');
assert.equal(legacyChat.length, legacyCopy.length, 'empty graph must not trim legacy history');
assert.deepEqual(legacyChat.map(m => m.mes), legacyCopy.map(m => m.mes), 'empty graph must not mask legacy history');
assert.match(prompts.get('epistemic_graph_rag_build'), /<ta_graph_delta>/, 'build instructions should be injected with no graph edges');
assert.equal(prompts.get('epistemic_graph_rag'), '', 'no-retrieval case must leave memory prompt empty');
graphInstance.setAbilities('Known NPC', ['辨音']);
await interceptor(legacyChat, 8192, () => {}, 'continue');
assert.match(prompts.get('epistemic_graph_perspective'), /辨音/, 'an empty graph still supplies the active speaker profile on continue');

context.chat = legacyChat;
context.chat.push({
    mes_id: 101,
    name: 'Known NPC',
    mes: '<ta_graph_delta>{"eventId":"evt_101","present":["Known NPC"],"location":"archive","facts":[{"id":"fact_turn_101_Known_NPC_1","content":"The brass key is in the archive drawer.","entities":["Known NPC","brass key","archive"],"keywords":["brass key","archive","drawer"]}],"grants":[{"npcId":"Known NPC","factId":"fact_turn_101_Known_NPC_1","sourceType":"ACTOR"}]}</ta_graph_delta>'
});
await handlers.get('message_received')(101);
assert.ok(graphInstance.facts.has('fact_turn_101_Known_NPC_1'), 'MESSAGE_RECEIVED should ingest model delta');

const retrievalChat = Array.from({ length: 100 }, (_, i) => ({ mes_id: i, name: 'Known NPC', mes: i === 99 ? 'Where is the brass key?' : `old floor ${i}` }));
await interceptor(retrievalChat, 8192, () => {}, 'normal');
assert.equal(retrievalChat.length, 100, 'retrieved graph memory alone must not trim unprocessed raw history');
assert.match(prompts.get('epistemic_graph_rag'), /brass key is in the archive drawer/, 'known speaker should receive matching memory');
assert.match(prompts.get('epistemic_graph_rag_build'), /<ta_graph_delta>/, 'build and retrieval prompts remain separate');

await interceptor(retrievalChat, 8192, () => {}, 'continue');
assert.equal(prompts.get('epistemic_graph_rag_build'), '', 'continuation must not request a duplicate build block');
assert.match(prompts.get('epistemic_graph_rag'), /brass key is in the archive drawer/, 'continuation may retain relevant retrieved memory');

context.name2 = 'Unknown NPC';
const unknownChat = [{ mes_id: 1, is_user: true, mes: 'hello' }];
await interceptor(unknownChat, 8192, () => {}, 'normal');
assert.equal(prompts.get('epistemic_graph_rag'), '', 'unknown speaker must clear previous memory injection');
assert.doesNotMatch(prompts.get('epistemic_graph_perspective'), /辨音/);
assert.match(prompts.get('epistemic_graph_rag_build'), /<ta_graph_delta>/, 'unknown card name still gets turn build instructions');
assert.equal(unknownChat.length, 1, 'unknown speaker must preserve outbound history');

context.name2 = 'Known NPC';
await interceptor(retrievalChat, 8192, () => {}, 'normal');
assert.ok(prompts.get('epistemic_graph_rag'), 'known speaker setup must restore memory prompt');
settings['st-epistemic-graph-rag'].enabled = false;
await interceptor(retrievalChat, 8192, () => {}, 'normal');
assert.equal(prompts.get('epistemic_graph_rag'), '', 'disabled extension must clear stale memory prompt');
assert.equal(prompts.get('epistemic_graph_rag_build'), '', 'disabled extension must clear stale build prompt');
assert.equal(prompts.get('epistemic_graph_perspective'), '');

settings['st-epistemic-graph-rag'].enabled = true;
await interceptor(retrievalChat, 8192, () => {}, 'normal');
assert.ok(prompts.get('epistemic_graph_rag_build'));
await interceptor(retrievalChat, 8192, () => {}, 'quiet');
assert.equal(prompts.get('epistemic_graph_rag_build'), '', 'auxiliary quiet generation must not get build instructions');
assert.equal(prompts.get('epistemic_graph_rag'), '', 'auxiliary generation must clear stale memory prompt');

const originalIngestEvent = graphInstance.ingestEvent.bind(graphInstance);
let releaseIngest;
let ingestStarted = false;
const ingestGate = new Promise(resolve => { releaseIngest = resolve; });
graphInstance.ingestEvent = async eventData => {
    ingestStarted = true;
    await ingestGate;
    return originalIngestEvent(eventData);
};
context.chatId = 'legacy-chat';
context.chat = [{
    mes_id: 102,
    name: 'Known NPC',
    mes: '<ta_graph_delta>{"eventId":"evt_race","present":["Known NPC"],"facts":[{"id":"fact_turn_102_Known_NPC_1","content":"A receipt is in the desk.","entities":["Known NPC","receipt","desk"],"keywords":["receipt","desk"]}],"grants":[{"npcId":"Known NPC","factId":"fact_turn_102_Known_NPC_1","sourceType":"ACTOR"}]}</ta_graph_delta>'
}];
const receiveInFlight = handlers.get('message_received')(0);
while (!ingestStarted) await Promise.resolve();
context.chatId = 'switched-chat';
context.chat = [];
const chatSwitch = handlers.get('chat_changed')();
releaseIngest();
await Promise.all([receiveInFlight, chatSwitch]);
const receiveSave = saveCalls.find(call => call.serialized.facts.some(([factId]) => factId === 'fact_turn_102_Known_NPC_1'));
assert.equal(receiveSave?.chatId, 'legacy-chat', 'in-flight receive must persist to the source chat after a switch');
assert.ok(loadCalls.includes('switched-chat'), 'next chat graph must load after pending receive persistence');
assert.equal(graphInstance.facts.has('fact_turn_102_Known_NPC_1'), false, 'empty destination chat must not retain the source chat graph');

// Both memories are legitimate. Only the character's side of the split can cue this turn.
settings['st-epistemic-graph-rag'].topK = 1;
for (const fact of [
    { id: 'dock', content: 'The ferryman left a rope at the dock.', keywords: ['ferryman', 'dock'], entities: ['ferryman'] },
    { id: 'tower', content: 'The tower has a violet whistle.', keywords: ['tower', 'violet'], entities: ['tower'] },
]) {
    await graphInstance.ingestEvent({
        event: { id: 'visit-' + fact.id, messageId: 0, participants: ['Known NPC'] },
        facts: [fact],
        epistemicGrants: [{ npcId: 'Known NPC', factId: fact.id, sourceType: 'WITNESS' }],
    });
}
graphInstance.messagePresence.set(2, new Set(['Scout']));
context.chat = [
    { mes_id: 1, mes: 'We are waiting at the dock for the ferryman.' },
    { mes_id: 2, mes: 'At the tower the scout hears the violet whistle.' },
    { mes_id: 3, is_user: true, mes: 'What next?' },
];
const splitChat = context.chat.map(row => ({ ...row }));
await interceptor(splitChat, 8192, () => {}, 'normal');
assert.match(prompts.get('epistemic_graph_rag'), /\n1\. [^\n]*rope at the dock/);
assert.doesNotMatch(prompts.get('epistemic_graph_rag'), /violet whistle/);
assert.equal(splitChat.at(-1).mes, 'What next?');
graphInstance.messagePresence.get(2).add('Known NPC');
await interceptor(context.chat.map(row => ({ ...row })), 8192, () => {}, 'normal');
assert.match(prompts.get('epistemic_graph_rag'), /\n1\. [^\n]*violet whistle/, 'hearing the tower scene makes it a valid cue');

context.name2 = 'New arrival';
const lastAssistant = context.chat[1];
const noMemories = [lastAssistant];
await interceptor(noMemories, 8192, () => {}, 'continue');
assert.equal(prompts.get('epistemic_graph_rag'), '');
assert.doesNotMatch(noMemories[0].mes, /violet whistle/, 'known absence must mask the latest assistant floor even without memories');
assert.match(lastAssistant.mes, /violet whistle/, 'stored text remains intact');
const lastPlayer = [{ ...lastAssistant, is_user: true }];
await interceptor(lastPlayer, 8192, () => {}, 'normal');
assert.equal(lastPlayer[0].mes, lastAssistant.mes, 'the latest player input is retained, including on a known absent floor');
graphInstance.messagePresence.set(2, new Set());
const unknownAudience = [lastAssistant];
await interceptor(unknownAudience, 8192, () => {}, 'normal');
assert.equal(unknownAudience[0].mes, lastAssistant.mes, 'unspecified attendance keeps legacy text intact');

console.log('[PASS] generation interceptor: legacy history, automatic build prompt, receive ingestion, retrieval trim, stale clearing, and auxiliary exclusion');
