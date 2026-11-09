import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmbeddingService } from '../embedding_service.js';
import { LongTermEpistemicGraph } from '../long_term_graph_rag.js';
import { importGraphJson, exportGraphJson } from '../graph_io.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const examplePath = path.join(here, '..', 'examples', 'custom-graph.example.json');

async function run() {
    console.log('=== 自定义图谱导入 / 导出 / 知情边界 验证 ===\n');

    const raw = fs.readFileSync(examplePath, 'utf8');
    const g = new LongTermEpistemicGraph(new EmbeddingService({ enableRemoteVector: false }));

    const r = await importGraphJson(raw, g);
    console.log('导入结果：', r);
    assert.equal(r.events, 2);
    assert.equal(r.facts, 3);
    assert.equal(r.edges, 6);
    assert.equal(r.warnings.length, 0);

    // 角色C 只知道"去过地窖"，不知道信物
    const c = await g.retrieveContextForNpc({
        npcId: '角色C',
        queryText: '那枚刻着家纹的信物埋在地窖哪块砖后面？',
        currentMsgId: 50,
        topK: 5
    });
    const cIds = c.activeFacts.map(f => f.factId);
    assert.ok(cIds.includes('fact_custom_001_a'), '角色C 应召回"去过地窖"');
    assert.ok(!cIds.includes('fact_custom_001_b'), '角色C 绝不能知道信物位置');
    assert.ok(!cIds.includes('fact_custom_002_a'), '角色C 绝不能知道信物转移到内袋');
    console.log('[PASS] 未知情角色零泄密');

    // 角色B 目击埋藏，但第40楼转移时不在场 → 认知滞后
    const b = await g.retrieveContextForNpc({
        npcId: '角色B',
        queryText: '信物现在在哪里？',
        currentMsgId: 50,
        topK: 5
    });
    const topB = b.activeFacts[0];
    assert.equal(topB.factId, 'fact_custom_001_b');
    assert.equal(topB.globallyOutdatedButNpcUnaware, true);
    console.log('[PASS] 角色B 认知滞后 ->', topB.effectiveText);

    // 角色A 知道最新状态，旧状态进入历史
    const a = await g.retrieveContextForNpc({
        npcId: '角色A',
        queryText: '信物现在在哪里？',
        currentMsgId: 50,
        topK: 5
    });
    assert.equal(a.activeFacts[0].factId, 'fact_custom_002_a');
    assert.ok(a.historicalFacts.some(f => f.factId === 'fact_custom_001_b'));
    console.log('[PASS] 角色A 拿到最新状态，旧状态降级为历史');

    // 导出 → 新图重建，数量一致
    const exported = exportGraphJson(g);
    const g2 = new LongTermEpistemicGraph(new EmbeddingService({ enableRemoteVector: false }));
    const r2 = await importGraphJson(exported, g2);
    assert.equal(r2.events, 2);
    assert.equal(r2.facts, 3);
    assert.equal(r2.edges, 6);
    console.log('[PASS] 导出后重新导入，事件/事实/认知边数量一致');

    console.log('\n=== 自定义图谱链路 4 项断言全部通过 ===');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
