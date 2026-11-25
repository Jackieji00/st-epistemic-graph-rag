import assert from 'node:assert/strict';
import { EmbeddingService } from '../embedding_service.js';
import { LongTermEpistemicGraph } from '../long_term_graph_rag.js';
import { floorStamp, summaryBook, planSources, nextBatch, decodeBatch, updateCoverage, extractionRules, filterConvertedArchive } from '../backfill.js';

const META = 'ta_big_summary_v1';
const chat = [
    { is_system: true, mes: 'TRANS-AM archive source', name: 'Archive' },
    { mes_id: 1, name: 'Ada', mes: 'Ada found the brass key in the east archive.' },
    { mes_id: 2, name: 'Bea', mes: 'Bea heard Ada say the brass key is in the east archive.' },
    { mes_id: 3, name: 'Cy', mes: 'Cy plans to search the west tower.' },
    { mes_id: 4, name: 'Ada', mes: 'A private fact.<ta_graph_delta>{"facts":[]}</ta_graph_delta>' },
];
const ctx = { chat, chatId: 'chat-a', getCurrentChatId: () => 'chat-a', chatMetadata: { world_info: 'TRANS-AM L1' } };
const stamp = i => floorStamp(chat[i]);
chat[0].extra = { [META]: { batch: 'b1', floor: 0 } };
chat[1].extra = { [META]: { batch: 'b1', floor: 1 } };
const entry = (batch, index, source, content, extra = {}, disable = false) => ({
    content, disable, extra: { [META]: { batch, index, source, ...extra } },
});
const book = entries => ({ entries: Object.fromEntries(entries.map((e, i) => [i, e])) });

assert.equal(floorStamp(chat[1]), floorStamp({ ...chat[1] }), 'floor stamps are stable for unchanged source rows');
assert.equal(summaryBook({ chatId: 'chat-a', chatMetadata: { world_info: 'legacy book' } }), 'legacy book');
assert.equal(summaryBook({ chatId: 'chat-a', chatMetadata: { main_chat: true, world_info: 'wrong chat' } }), '');
assert.equal(summaryBook({ chatId: 'chat-a', getCurrentChatId: () => 'chat-a', chatMetadata: { ta_big_summary_v1: { ownerChatId: 'other', book: 'wrong chat' } } }), '');

const valid = entry('b1', 0, [[0, stamp(0)], [1, stamp(1)]], 'Ada found the brass key in the east archive.');
const pending = entry('b2', 0, [[0, stamp(0)], [2, stamp(2)]], 'pending', { isPending: true });
const disabled = entry('b3', 0, [[0, stamp(0)], [3, stamp(3)]], 'disabled', {}, true);
const stagedMember = entry('b4', 0, [[0, stamp(0)], [2, stamp(2)]], 'stage member', { closedByStage: 'stage-1' }, true);
const stale = entry('b5', 0, [[0, stamp(0)], [3, 'stale']], 'stale row');
const wrongBranch = entry('b6', 0, [[0, stamp(0)], [4, stamp(4)]], 'wrong swipe');
const activeBook = book([valid, pending, disabled, stagedMember, stale, wrongBranch]);
const planned = planSources(ctx, 'TRANS-AM L1', activeBook, false);
assert.ok(planned.some(s => s.book === 'TRANS-AM L1' && s.text === valid.content), 'valid active worldbook entry is retained');
assert.ok(!planned.some(s => /pending|disabled|stage member|stale row|wrong swipe/.test(s.text)), 'pending, disabled, staged member, stale and branch-mismatched entries are rejected');
assert.ok(planned.some(s => s.key.includes(JSON.stringify(['chat', 3]))), 'raw uncovered story row fills a worldbook gap');
assert.ok(!planned.some(s => s.key.includes(JSON.stringify(['chat', 1]))), 'raw row covered by valid worldbook source is not duplicated');
assert.ok(!planned.find(s => s.key.includes(JSON.stringify(['chat', 4])) )?.text.includes('<ta_graph_delta>'), 'graph payload is stripped from raw source');
const bookOnly = planSources(ctx, 'TRANS-AM L1', activeBook, true);
assert.equal(bookOnly.length, 1, 'book-only mode excludes raw gap fill');

const makeGraph = () => ({ events: new Map(), coveredFloors: new Map() });
const graph = makeGraph();
const a = { key: 'a', stamp: 'a1', refs: [[1, 's1']], text: 'source a' };
const b = { key: 'b', stamp: 'b1', refs: [[2, 's2']], text: 'source b' };
assert.deepEqual(nextBatch([a, b], graph), [a, b], 'unprocessed sources are batched');
graph.events.set('a', { backfill: { stamp: 'a1' } });
assert.deepEqual(nextBatch([a, b], graph), [b], 'matching receipt resumes after completed source');
graph.events.set('a', { backfill: { stamp: 'old' } });
assert.deepEqual(nextBatch([a, b], graph), [a, b], 'changed source stamp is reprocessed');

const batch = [{ key: 'src', stamp: 'stamp', refs: [[1, stamp(1)]], text: `${chat[1].mes} ${chat[2].mes}`, book: 'TRANS-AM L1' }];
const raw = JSON.stringify({ items: [{ source: 0, participants: ['Ada'], facts: [
    { id: 'key', content: 'Key is in the archive.', quote: 'brass key in the east archive', subtle: false },
], grants: [
    { npcId: 'Ada', factId: 'key', sourceType: 'ACTOR', quote: 'Ada found the brass key' },
    { npcId: 'Bea', factId: 'key', sourceType: 'WITNESS', quote: 'Bea heard Ada say', },
    { npcId: 'Cy', factId: 'key', sourceType: 'ACTOR', quote: 'Ada found the brass key' },
    { npcId: 'Ada', factId: 'key', sourceType: 'HEARSAY', sourceNpc: 'Bea', distortedContent: 'key is east', quote: 'Ada found the brass key' },
    { npcId: 'Bea', factId: 'key', sourceType: 'HEARSAY', sourceNpc: 'Ada', distortedContent: 'the brass key is in the east archive', quote: 'Bea heard Ada say the brass key is in the east archive' },
] }] });
const decoded = decodeBatch(raw, batch)[0];
assert.equal(decoded.epistemicGrants.length, 2, 'only quote-backed participant and hearsay grants survive');
assert.equal(decoded.skipped, 3, 'unsupported attribution, missing source attribution and unsupported types are counted');
assert.throws(() => decodeBatch(JSON.stringify({ items: [{ source: 0, participants: [], grants: [], facts: [{ id: 'bad', content: 'invented', quote: 'not present' }] }] }), batch), /引文/);
assert.match(extractionRules, /Never invent abilities, observations or attribution/);

const coverage = makeGraph();
coverage.events.set('src', { backfill: { stamp: 'stamp', usable: true } });
updateCoverage(coverage, batch);
assert.equal(coverage.coveredFloors.get(1), stamp(1), 'usable backfill marks the exact raw floor covered');
coverage.events.set('src', { backfill: { stamp: 'stamp', usable: false } });
updateCoverage(coverage, batch);
assert.equal(coverage.coveredFloors.has(1), false, 'book receipt without usable extraction does not cover raw history');
assert.equal(coverage.coveredFloors.has(2), false, 'unprocessed old floors remain uncovered');

const archiveMessage = { role: 'system', content: `[TRANS-AM CHAT EVENT ARCHIVE]\nTRANS-AM L1\n\n${valid.content}\n\n【当前未决定事项】\nkeep this pending ledger` };
const settingsMessage = { role: 'system', content: 'unrelated settings' };
const archiveData = { type: 'normal', messages: [archiveMessage, settingsMessage] };
const archiveCtx = { ...ctx, async loadWorldInfo() { return activeBook; } };
const archiveGraph = { events: new Map([[planned[0].key, { backfill: { stamp: planned[0].stamp, usable: true, book: 'TRANS-AM L1' } }]]) };
await filterConvertedArchive(archiveData, archiveCtx, archiveGraph);
assert.equal(archiveMessage.content.includes(valid.content), false, 'validated converted archive paragraph is removed');
assert.match(archiveMessage.content, /keep this pending ledger/, 'pending ledger survives archive cleanup');
assert.equal(archiveData.messages[1], settingsMessage, 'unrelated settings message is preserved');
const unreceipted = { role: 'system', content: `[TRANS-AM CHAT EVENT ARCHIVE]\nTRANS-AM L1\n\n${valid.content}` };
const untouchedData = { type: 'normal', messages: [unreceipted] };
await filterConvertedArchive(untouchedData, archiveCtx, { events: new Map() });
assert.equal(unreceipted.content.includes(valid.content), true, 'archive paragraph stays when its usable receipt is missing');

const boundaryGraph = new LongTermEpistemicGraph(new EmbeddingService({ enableRemoteVector: false }));
const coveredFloor = { mes_id: 98, name: 'Narrator', mes: 'Cy hid the brass key in the west tower.' };
const playerFloor = { mes_id: 100, is_user: true, name: 'Player', mes: 'Where is the key?' };
boundaryGraph.coveredFloors.set(98, floorStamp(coveredFloor));
boundaryGraph.ensureNpc('Ada');
const outbound = boundaryGraph.sanitizeChatHistoryForNpc([coveredFloor, { mes_id: 99, name: 'Ada', mes: 'The weather is clear.' }, playerFloor], 'Ada', 16);
assert.doesNotMatch(outbound[0].mes, /Cy hid the brass key/, 'verified covered nearby source with no knowledge grant is masked');
assert.equal(outbound.at(-1).mes, playerFloor.mes, 'last player input remains intact');

console.log('[PASS] worldbook-first backfill: provenance, gaps, resume, quote validation, and coverage');
