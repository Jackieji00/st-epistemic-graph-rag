import assert from 'node:assert/strict';
import { LongTermEpistemicGraph } from '../long_term_graph_rag.js';
import { importGraphJson, exportGraphJson } from '../graph_io.js';

// Use the same graph path for an everyday setting and a fictional one.
for (const [ability, cue, meaning] of [
    ['辨音', '第二个音有微弱的颤动', '可能有一根弦松了'],
    ['读潮纹', '水纹在第三圈折返', '可能正处于逆潮'],
]) {
    const g = new LongTermEpistemicGraph();
    const expert = '甲', novice = '乙', distracted = '丙', absent = '丁';
    const witness = (npcId, factId, noticedCue) => ({ npcId, factId, sourceType: 'WITNESS', noticedCue });
    const infer = (npcId, factId, ...basisFactIds) => ({ npcId, factId, sourceType: 'INFERRED', basisFactIds });
    const imported = await importGraphJson({
        npcs: [novice, ...[expert, distracted, absent].map(name => ({ name, abilities: [ability] }))],
        events: [{
            id: 'scene', messageId: 4, participants: [expert, novice, distracted],
            facts: [
                { id: 'public', content: '门口挂了休息的牌子' },
                { id: 'ordinary', content: '店家可能暂时离开了' },
                { id: 'cue', content: cue, subtle: true },
                { id: 'interpretation', content: meaning, requiresAbilities: [ability] },
            ],
            grants: [
                infer(expert, 'interpretation', 'cue'), infer(novice, 'interpretation', 'cue'),
                infer(distracted, 'interpretation', 'cue'), infer(novice, 'ordinary', 'public'),
                witness(expert, 'cue', '特意停下来仔细分辨'), witness(novice, 'cue', '身旁的人提醒留意变化'),
                witness(distracted, 'cue', ''), witness(absent, 'cue', '我也看见了'),
                witness(novice, 'public'), infer(absent, 'ordinary', 'ordinary'),
            ],
        }],
    }, g);
    assert.equal(imported.edges, 5);
    const ids = async npcId => (await g.retrieveContextForNpc({ npcId, queryText: cue, currentMsgId: 8 })).activeFacts.map(f => f.factId);
    assert.ok((await ids(expert)).includes('interpretation'));
    assert.deepEqual(new Set(await ids(novice)), new Set(['public', 'ordinary', 'cue']));
    assert.deepEqual(await ids(distracted), []);
    assert.deepEqual(await ids(absent), []);
    const raw = [{ mes_id: 4, mes: '旁白：' + meaning }, { is_user: true, mes: '你听见了什么？' }];
    const outgoing = g.sanitizeChatHistoryForNpc(raw, novice);
    assert.ok(outgoing[0].mes.includes(cue) && !outgoing[0].mes.includes(meaning));
    assert.equal(raw[0].mes, '旁白：' + meaning);
    assert.equal(g.grantKnowledge(infer(novice, 'ordinary', 'missing')), false);
    assert.equal(g.grantKnowledge({ ...infer(expert, 'ordinary', 'cue'), learnedAtMsg: 3 }), false);

    assert.equal(g.propagateFact({ fromNpcId: expert, toNpcId: novice, factId: 'interpretation', learnedAtMsg: 8,
        partialOrDistortedText: '甲说情况有点异常' }), true);
    const replay = new LongTermEpistemicGraph();
    replay.deserialize(g.serialize());
    const restored = new LongTermEpistemicGraph();
    const roundTrip = await importGraphJson(exportGraphJson(replay), restored);
    assert.deepEqual(roundTrip.warnings, []);
    assert.deepEqual(restored.npcs.get(expert).abilities, [ability]);
    assert.deepEqual(restored.knowledgeEdges.get(expert).get('interpretation').basisFactIds, ['cue']);
    const heard = restored.knowledgeEdges.get(novice).get('interpretation');
    assert.equal(heard.sourceType, 'HEARSAY');
    assert.equal(heard.distortedContent, '甲说情况有点异常');
}
console.log('[PASS] 普通观察、注意机会、专长、推断依据、转述与存档往返');
