import assert from 'node:assert/strict';
import test from 'node:test';
import { LongTermEpistemicGraph } from '../long_term_graph_rag.js';

const heard = '船尾有人递过纸包，纸包上挂着三齿船牌。';

async function ferryStory(contents, destination) {
    const graph = new LongTermEpistemicGraph();
    await graph.ingestEvent({
        event: { id: 'ferry', messageId: 80, participants: ['阿岚', '洛', '弥', '青'] },
        facts: [{ id: 'parcel', content: `阿岚接过挂着三齿船牌的纸包，答应把里面的${contents}送到${destination}。`, entities: [destination], keywords: [contents] }],
        epistemicGrants: [
            { npcId: '阿岚', factId: 'parcel', sourceType: 'ACTOR' },
            { npcId: '洛', factId: 'parcel', sourceType: 'WITNESS', distortedContent: heard },
        ],
    });
    assert.ok(graph.propagateFact({ fromNpcId: '洛', toNpcId: '弥', factId: 'parcel', learnedAtMsg: 86 }));
    await graph.ingestEvent({
        event: { id: 'water', messageId: 800, participants: ['弥'] },
        facts: [{ id: 'bucket', content: '弥在东井打了一桶水。', entities: ['东井'] }],
        epistemicGrants: [{ npcId: '弥', factId: 'bucket', sourceType: 'ACTOR' }],
    });
    return graph;
}

const recall = (graph, npcId, queryText, topK = 1, currentMsgId = 1000) =>
    graph.retrieveContextForNpc({ npcId, queryText, topK, currentMsgId });

test('幕后改动包内物品和目的地时，部分知情者的召回顺序与注入提示不变', async () => {
    const seal = await ferryStory('铜印', '东井');
    const map = await ferryStory('海图', '西仓');
    const a = await recall(seal, '弥', '铜印', 2);
    const b = await recall(map, '弥', '铜印', 2);
    assert.deepEqual(a.activeFacts.map(f => f.factId), b.activeFacts.map(f => f.factId));
    assert.equal(seal.buildEpistemicPrompt({ npcId: '弥', ...a }), map.buildEpistemicPrompt({ npcId: '弥', ...b }));
});

test('能想起别人告诉自己的船牌；不知道目的地时，不会通过目的地联想到无关旧事', async () => {
    for (const destination of ['东井', '西仓']) {
        const graph = await ferryStory('铜印', destination);
        const result = await recall(graph, '弥', '船尾有人递过纸包，三齿船牌');
        assert.deepEqual(result.activeFacts.map(f => f.factId), ['parcel']);
        const prompt = graph.buildEpistemicPrompt({ npcId: '弥', ...result });
        assert.ok(prompt.includes(heard));
        assert.ok(prompt.includes('洛'));
        assert.doesNotMatch(prompt, /铜印|东井|西仓/);
    }
});

test('具体的旧线索排在只与主角同名的近期经历之前', async () => {
    const graph = await ferryStory('铜印', '东井');
    for (const [index, place] of ['哨楼', '马厩', '集市', '学堂', '铁铺', '粮仓'].entries()) {
        const id = 'walk-' + index;
        await graph.ingestEvent({
            event: { id, messageId: 900 + index, participants: ['阿岚', '弥'] },
            facts: [{ id, content: `阿岚经过${place}。`, entities: ['阿岚', place], keywords: ['阿岚'] }],
            epistemicGrants: [{ npcId: '弥', factId: id, sourceType: 'WITNESS' }],
        });
    }
    const result = await recall(graph, '弥', '阿岚问，当年的三齿船牌还在吗？');
    assert.equal(result.activeFacts[0]?.factId, 'parcel');
});

test('同队同场不会自动获知，转述从听到的楼层才可用', async () => {
    const graph = await ferryStory('铜印', '东井');
    assert.deepEqual((await recall(graph, '青', '铜印')).activeFacts, []);
    const before = await recall(graph, '弥', '三齿船牌', 8, 85);
    assert.deepEqual(before.activeFacts, []);
    assert.deepEqual(before.historicalFacts, []);
    const after = await recall(graph, '弥', '三齿船牌', 8, 86);
    assert.deepEqual(after.activeFacts.map(f => f.effectiveText), [heard]);
});
