import assert from 'node:assert/strict';
import { EmbeddingService } from '../embedding_service.js';
import { LongTermEpistemicGraph } from '../long_term_graph_rag.js';

async function runTests() {
    console.log('=== 开始验证 Epistemic GraphRAG (多角色知情边界与500楼长期记忆) ===\n');

    const embedder = new EmbeddingService({ enableRemoteVector: false });
    const graph = new LongTermEpistemicGraph(embedder);

    // 1. 初始化三角色：小王、小李、小张
    graph.ensureNpc('小王');
    graph.ensureNpc('小李');
    graph.ensureNpc('小张');

    // 第 20 楼：小王在仓库藏钥匙，小李目击，小张不在场
    await graph.ingestEvent({
        event: {
            id: 'evt_20',
            messageId: 20,
            timestamp: '第20楼 (Day 1 15:00)',
            location: '仓库',
            participants: ['小王', '小李']
        },
        facts: [
            {
                id: 'fact_20_visit',
                content: '小王在 Day 1 下午去过仓库。',
                entities: ['小王', '仓库'],
                keywords: ['小王', '仓库', '去过']
            },
            {
                id: 'fact_20_key_box',
                content: '小王把青铜钥匙藏在了仓库第三排木箱底下。',
                entities: ['小王', '仓库', '青铜钥匙', '木箱'],
                keywords: ['小王', '仓库', '钥匙', '青铜钥匙', '木箱', '藏'],
                isSecret: true
            }
        ],
        epistemicGrants: [
            { npcId: '小王', factId: 'fact_20_visit', sourceType: 'ACTOR', learnedAtMsg: 20 },
            { npcId: '小王', factId: 'fact_20_key_box', sourceType: 'ACTOR', learnedAtMsg: 20 },
            { npcId: '小李', factId: 'fact_20_visit', sourceType: 'WITNESS', learnedAtMsg: 20 },
            { npcId: '小李', factId: 'fact_20_key_box', sourceType: 'WITNESS', learnedAtMsg: 20 }
        ]
    });

    // 第 25 楼：小李只告诉小张“小王去过仓库”，隐瞒了钥匙的事
    graph.messagePresence.set(25, new Set(['小李', '小张']));
    graph.propagateFact({
        fromNpcId: '小李',
        toNpcId: '小张',
        factId: 'fact_20_visit',
        learnedAtMsg: 25,
        partialOrDistortedText: '听小李说，小王今天下午鬼鬼祟祟去过仓库。'
    });

    // [测试 1] 验证未获知秘密的小张被追问钥匙时绝不泄密
    const zhangPreQuery = await graph.retrieveContextForNpc({
        npcId: '小张',
        queryText: '小王在仓库里藏的那把青铜钥匙放在哪个木箱底下了？',
        currentMsgId: 30,
        topK: 5
    });
    const zhangPreFactIds = zhangPreQuery.activeFacts.map(f => f.factId);
    assert.ok(zhangPreFactIds.includes('fact_20_visit'), '小张应当召回“小王去过仓库”的传闻');
    assert.ok(!zhangPreFactIds.includes('fact_20_key_box'), '小张绝不能召回“钥匙藏在木箱下”的秘密');
    console.log('[PASS] 测试 1：部分知情防泄密通过 -> 小张只召回仓库传闻，钥匙秘密对小张 0 暴露');

    // 验证聊天历史物理遮蔽
    const mockChat = [
        { mes_id: 20, name: '旁白', mes: '小王把青铜钥匙塞进了仓库第三排木箱底下，窗外的小李看了一清二楚。' },
        { mes_id: 25, name: '小李', mes: '小张，我跟你说，小王下午去过仓库。' },
        { mes_id: 30, name: '玩家', is_user: true, mes: '小张，你知道仓库里的钥匙在哪吗？' }
    ];
    const sanitizedForZhang = graph.sanitizeChatHistoryForNpc(mockChat, '小张', 16);
    assert.ok(!sanitizedForZhang[0].mes.includes('青铜钥匙'), '第20楼原文中的青铜钥匙必须对小张物理遮蔽');
    console.log('[PASS] 测试 2：聊天历史物理遮蔽通过 -> 第20楼原文已对小张隔离:', sanitizedForZhang[0].mes);

    // [测试 3] 小李把钥匙秘密告知小张后，小张能否正确召回并使用信息
    graph.propagateFact({
        fromNpcId: '小李',
        toNpcId: '小张',
        factId: 'fact_20_key_box',
        learnedAtMsg: 35,
        partialOrDistortedText: '小李悄悄告诉我，他亲眼看见小王把青铜钥匙藏在仓库第三排木箱底下了。'
    });
    const zhangPostQuery = await graph.retrieveContextForNpc({
        npcId: '小张',
        queryText: '现在你知道仓库里的青铜钥匙藏哪儿了吗？',
        currentMsgId: 36,
        topK: 5
    });
    assert.ok(
        zhangPostQuery.activeFacts.some(f => f.factId === 'fact_20_key_box' && f.effectiveText.includes('第三排木箱')),
        '获知秘密后，小张必须能正确召回木箱下的钥匙位置'
    );
    console.log('[PASS] 测试 3：获知秘密后激活验证通过 -> 小张成功召回:', zhangPostQuery.activeFacts[0].effectiveText);

    // [测试 4] 模拟 500 楼长线剧情 + 第 180 楼秘密转移钥匙（认知时间差 Epistemic Lag 验证）
    for (let floor = 37; floor <= 500; floor++) {
        if (floor === 180) {
            // 第 180 楼：小王独自一人去仓库把青铜钥匙转移到了钟楼花盆里（小李、小张均不在场！）
            await graph.ingestEvent({
                event: {
                    id: 'evt_180_move_key',
                    messageId: 180,
                    timestamp: '第180楼 (Day 5 23:00)',
                    location: '钟楼',
                    participants: ['小王']
                },
                facts: [
                    {
                        id: 'fact_180_key_flowerpot',
                        content: '小王在深夜把青铜钥匙从仓库木箱取出，转移藏进了钟楼顶层的蓝瓷花盆里。',
                        entities: ['小王', '青铜钥匙', '钟楼', '花盆'],
                        keywords: ['小王', '钥匙', '青铜钥匙', '钟楼', '花盆', '转移'],
                        supersedesFactId: 'fact_20_key_box',
                        isSecret: true
                    }
                ],
                epistemicGrants: [
                    { npcId: '小王', factId: 'fact_180_key_flowerpot', sourceType: 'ACTOR', learnedAtMsg: 180 }
                ]
            });
        } else if (floor % 10 === 0) {
            // 填充几百楼日常噪声事件，模拟百楼级长存档
            await graph.ingestEvent({
                event: {
                    id: `evt_noise_${floor}`,
                    messageId: floor,
                    timestamp: `第${floor}楼`,
                    location: '酒馆大厅',
                    participants: ['小王', '小李', '小张']
                },
                facts: [
                    {
                        id: `fact_noise_${floor}`,
                        content: `第${floor}楼日常闲聊：大家在酒馆讨论今日的麦酒价格与天气。`,
                        entities: ['酒馆大厅', '麦酒'],
                        keywords: ['麦酒', '天气', '闲聊']
                    }
                ],
                epistemicGrants: [
                    { npcId: '小王', factId: `fact_noise_${floor}`, sourceType: 'ACTOR', learnedAtMsg: floor },
                    { npcId: '小李', factId: `fact_noise_${floor}`, sourceType: 'WITNESS', learnedAtMsg: floor },
                    { npcId: '小张', factId: `fact_noise_${floor}`, sourceType: 'WITNESS', learnedAtMsg: floor }
                ]
            });
        }
    }

    // 在第 500 楼分别询问【小王】和【小李】：“青铜钥匙现在藏在哪里？”
    const wangAt500 = await graph.retrieveContextForNpc({
        npcId: '小王',
        queryText: '那把青铜钥匙现在藏在哪里？',
        currentMsgId: 500,
        topK: 5
    });
    const liAt500 = await graph.retrieveContextForNpc({
        npcId: '小李',
        queryText: '那把青铜钥匙现在藏在哪里？',
        currentMsgId: 500,
        topK: 5
    });

    // 验证小王：第 20 楼的旧位置已进入 historicalFacts，当前有效认知是第 180 楼的“钟楼花盆”
    assert.equal(wangAt500.activeFacts[0].factId, 'fact_180_key_flowerpot', '小王在第500楼应当召回最新的钟楼花盆位置');
    assert.ok(wangAt500.historicalFacts.some(f => f.factId === 'fact_20_key_box'), '小王的木箱旧位置应归入已取代历史记忆');

    // 验证小李：因第 180 楼不在场，小李在第 500 楼依然坚信钥匙在“仓库第三排木箱底下”，且触发认知滞后标记
    assert.equal(liAt500.activeFacts[0].factId, 'fact_20_key_box', '小李不知道钥匙被转移，第500楼仍应坚信在仓库木箱下');
    assert.equal(liAt500.activeFacts[0].globallyOutdatedButNpcUnaware, true, '小李的记忆应被标记为全局过期但本人不知情(Epistemic Lag)');

    console.log('[PASS] 测试 4：500楼长线检索与认知时间差（Epistemic Lag）验证通过！');
    console.log('  ├─ 第500楼【小王】视角 Top-1 记忆:', wangAt500.activeFacts[0].effectiveText);
    console.log('  └─ 第500楼【小李】视角 Top-1 记忆:', liAt500.activeFacts[0].effectiveText, '(globallyOutdatedButNpcUnaware=true)');

    console.log('\n=== 全部 4 项核心断言测试 100% 通过 ===');
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
