import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EmbeddingService } from '../embedding_service.js';
import { LongTermEpistemicGraph } from '../long_term_graph_rag.js';

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
await interceptor(legacyChat, 8192, () => {}, 'normal');
assert.equal(legacyChat.length, legacyCopy.length, 'empty graph must not trim legacy history');
assert.deepEqual(legacyChat.map(m => m.mes), legacyCopy.map(m => m.mes), 'empty graph must not mask legacy history');
assert.match(prompts.get('epistemic_graph_rag_build'), /<ta_graph_delta>/, 'build instructions should be injected with no graph edges');
assert.equal(prompts.get('epistemic_graph_rag'), '', 'no-retrieval case must leave memory prompt empty');

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
assert.equal(retrievalChat.length, 16, 'usable retrieved memory should allow the configured history trim');
assert.match(prompts.get('epistemic_graph_rag'), /brass key is in the archive drawer/, 'known speaker should receive matching memory');
assert.match(prompts.get('epistemic_graph_rag_build'), /<ta_graph_delta>/, 'build and retrieval prompts remain separate');

await interceptor(retrievalChat, 8192, () => {}, 'continue');
assert.equal(prompts.get('epistemic_graph_rag_build'), '', 'continuation must not request a duplicate build block');
assert.match(prompts.get('epistemic_graph_rag'), /brass key is in the archive drawer/, 'continuation may retain relevant retrieved memory');

context.name2 = 'Unknown NPC';
const unknownChat = [{ mes_id: 1, is_user: true, mes: 'hello' }];
await interceptor(unknownChat, 8192, () => {}, 'normal');
assert.equal(prompts.get('epistemic_graph_rag'), '', 'unknown speaker must clear previous memory injection');
assert.match(prompts.get('epistemic_graph_rag_build'), /<ta_graph_delta>/, 'unknown card name still gets turn build instructions');
assert.equal(unknownChat.length, 1, 'unknown speaker must preserve outbound history');

context.name2 = 'Known NPC';
await interceptor(retrievalChat, 8192, () => {}, 'normal');
assert.ok(prompts.get('epistemic_graph_rag'), 'known speaker setup must restore memory prompt');
settings['st-epistemic-graph-rag'].enabled = false;
await interceptor(retrievalChat, 8192, () => {}, 'normal');
assert.equal(prompts.get('epistemic_graph_rag'), '', 'disabled extension must clear stale memory prompt');
assert.equal(prompts.get('epistemic_graph_rag_build'), '', 'disabled extension must clear stale build prompt');

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

console.log('[PASS] generation interceptor: legacy history, automatic build prompt, receive ingestion, retrieval trim, stale clearing, and auxiliary exclusion');
