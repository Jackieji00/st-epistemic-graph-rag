import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EmbeddingService } from '../embedding_service.js';
import { LongTermEpistemicGraph } from '../long_term_graph_rag.js';
import { embedText, setSessionApiKey, testProviderApi } from '../provider_api.js';

const requests = [];
const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    res.setHeader('Content-Type', 'application/json');
    if (!req.headers.authorization) { res.statusCode = 401; res.end('{}'); return; }
    if (req.url.endsWith('/fail/chat/completions')) {
        res.statusCode = 500; res.end('private-upstream-response');
    } else if (['/v1/embeddings', '/openai/embeddings'].includes(req.url)) {
        const dimension = requests.at(-1).body.model === 'model-a' ? [1, 0] : [0, 1];
        res.end(JSON.stringify({ data: [{ embedding: dimension }] }));
    } else if (req.url === '/v1/chat/completions') {
        res.end(JSON.stringify({ choices: [{ message: { content: 'SYNTHETIC_LOCAL_TEST' } }] }));
    } else { res.statusCode = 404; res.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const configA = { mode: 'openai-compatible', baseUrl, model: 'model-a' };
    const configB = { ...configA, model: 'model-b' };
    setSessionApiKey('vector', configA, 'synthetic-secret');
    const service = new EmbeddingService({ getConfig: () => configA });
    assert.equal(service.spaceId.includes('synthetic-secret'), false);
    const graph = new LongTermEpistemicGraph(service);
    await graph.ingestEvent({
        event: { id: 'event', messageId: 1, participants: ['NPC'] },
        facts: [{ id: 'fact', content: '小王在仓库藏了钥匙', keywords: ['仓库', '钥匙'] }],
        epistemicGrants: [{ npcId: 'NPC', factId: 'fact', sourceType: 'ACTOR' }]
    });
    const oldSpace = graph.facts.get('fact').embeddingSpace;
    assert.equal(oldSpace, service.spaceId);
    service.getConfig = () => configB;
    assert.notEqual(service.spaceId, oldSpace);
    const result = await graph.retrieveContextForNpc({ npcId: 'NPC', queryText: '仓库 钥匙', currentMsgId: 2 });
    assert(result.activeFacts.some(x => x.factId === 'fact'), 'sparse search still recalls facts from a different embedding space');
    assert.equal(requests.length, 1, 'do not request query vectors when the visible facts use a different model');
    assert.equal((await testProviderApi('vector', configB)).startsWith('连接成功'), true);
    assert(requests.some(x => x.auth === 'Bearer synthetic-secret'));
    assert.equal(requests.some(x => JSON.stringify(x.body).includes('synthetic-secret')), false);
    await assert.rejects(() => embedText(configB, 'anonymous override', null), /401/);
    const summaryConfig = { mode: 'openai-compatible', baseUrl, model: 'summary-model' };
    assert.equal(await testProviderApi('summary', summaryConfig, {}, 'synthetic-summary-key'), '连接成功');
    const prefixed = { ...configA, baseUrl: baseUrl + '/openai' };
    setSessionApiKey('vector', prefixed, 'synthetic-prefix-key');
    await embedText(prefixed, 'prefix-path');
    assert(requests.some(x => x.url === '/openai/embeddings'));
    const failing = { mode: 'openai-compatible', baseUrl: baseUrl + '/fail', model: 'summary-model' };
    await assert.rejects(() => testProviderApi('summary', failing, {}, 'synthetic-key'), error => !error.message.includes('private-upstream-response'));
    setSessionApiKey('vector', configA, null);
    assert.equal(await embedText({ mode: 'disabled' }, 'synthetic'), null);
    await assert.rejects(() => service.embedText('synthetic', { strict: true }), /向量请求失败/);
} finally {
    server.close();
}
