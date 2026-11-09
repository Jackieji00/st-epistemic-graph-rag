/**
 * 图谱导入 / 导出（与 SillyTavern 无关的纯逻辑，便于离线测试）
 *
 * 导入格式：
 * {
 *   "npcs": ["角色A", "角色B"],
 *   "events": [{
 *     "id": "evt_1",
 *     "messageId": 12,
 *     "timestamp": "第12楼 深夜",
 *     "location": "地点",
 *     "participants": ["角色A"],
 *     "summary": "一句话概述",
 *     "facts": [{
 *       "id": "fact_1",
 *       "content": "客观发生的具体事实",
 *       "entities": ["角色A", "物品", "地点"],
 *       "keywords": ["检索关键词"],
 *       "isSecret": true,
 *       "supersedesFactId": "被取代的旧事实id"
 *     }],
 *     "grants": [{
 *       "npcId": "角色A",
 *       "factId": "fact_1",
 *       "sourceType": "ACTOR | WITNESS | HEARSAY | INFERRED | RUMOR_FALSE",
 *       "sourceNpc": "角色B",
 *       "learnedAtMsg": 12,
 *       "confidence": 1.0,
 *       "distortedContent": "该角色实际听到的版本"
 *     }]
 *   }]
 * }
 */

export async function importGraphJson(text, targetGraph) {
    let payload;
    try {
        payload = typeof text === 'string' ? JSON.parse(text) : text;
    } catch (err) {
        throw new Error('JSON 解析失败：' + err.message);
    }
    if (!payload || typeof payload !== 'object') throw new Error('导入内容必须是 JSON 对象');

    const npcs = Array.isArray(payload.npcs) ? payload.npcs : [];
    const events = Array.isArray(payload.events) ? payload.events : [];
    if (!npcs.length && !events.length) throw new Error('JSON 里没有 npcs 或 events');

    for (const n of npcs) {
        const name = typeof n === 'string' ? n : (n?.name || n?.id);
        if (name) targetGraph.ensureNpc(name, name);
    }

    let factCount = 0;
    let edgeCount = 0;
    const warnings = [];

    for (const ev of events) {
        const participants = Array.isArray(ev.participants) ? ev.participants : [];
        for (const p of participants) targetGraph.ensureNpc(p, p);

        const facts = Array.isArray(ev.facts) ? ev.facts : [];
        for (const f of facts) {
            if (!f.id || !f.content) {
                warnings.push(`事件 ${ev.id || '?'} 中有一条事实缺少 id 或 content，已跳过`);
            }
        }

        const grants = Array.isArray(ev.grants) ? ev.grants : [];
        const validFacts = new Set(facts.map(f => f.id).filter(Boolean));
        const validGrants = grants.filter(g => {
            if (!g.npcId || !g.factId) {
                warnings.push(`事件 ${ev.id || '?'} 中有一条 grants 缺少 npcId/factId，已跳过`);
                return false;
            }
            if (validFacts.size && !validFacts.has(g.factId)) {
                warnings.push(`grants 指向了本事件内不存在的 factId=${g.factId}，已跳过`);
                return false;
            }
            return true;
        });

        await targetGraph.ingestEvent({
            event: {
                id: ev.id || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                messageId: Number(ev.messageId ?? 0),
                timestamp: ev.timestamp || '',
                location: ev.location || '',
                participants,
                summary: ev.summary || ''
            },
            facts,
            epistemicGrants: validGrants
        });

        factCount += facts.length;
        edgeCount += validGrants.length;
    }

    return {
        npcs: npcs.length,
        events: events.length,
        facts: factCount,
        edges: edgeCount,
        warnings
    };
}

export function exportGraphJson(targetGraph) {
    const data = targetGraph.serialize();
    const factsByEvent = new Map();
    for (const [fid, f] of data.facts) {
        if (!factsByEvent.has(f.eventId)) factsByEvent.set(f.eventId, []);
        factsByEvent.get(f.eventId).push([fid, f]);
    }

    return JSON.stringify({
        npcs: data.npcs.map(([id, v]) => v?.name || id),
        events: data.events.map(([, ev]) => ({
            id: ev.id,
            messageId: ev.messageId,
            timestamp: ev.timestamp,
            location: ev.location,
            participants: ev.participants,
            summary: ev.summary,
            facts: (factsByEvent.get(ev.id) || []).map(([, f]) => ({
                id: f.id,
                content: f.content,
                entities: f.entities,
                keywords: f.keywords,
                isSecret: f.isSecret
            })),
            grants: data.knowledgeEdges.flatMap(([npcId, edges]) =>
                edges
                    .filter(([, e]) => (factsByEvent.get(ev.id) || []).some(([fid]) => fid === e.factId))
                    .map(([, e]) => ({
                        npcId,
                        factId: e.factId,
                        sourceType: e.sourceType,
                        sourceNpc: e.sourceNpc,
                        learnedAtMsg: e.learnedAtMsg,
                        confidence: e.confidence,
                        distortedContent: e.distortedContent
                    }))
            )
        }))
    }, null, 2);
}
