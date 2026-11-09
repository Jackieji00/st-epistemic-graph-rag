/**
 * Epistemic Hybrid GraphRAG 核心引擎
 * 解决多角色知情边界（Epistemic Boundary）与百楼级长期记忆（500+ Floors Long-Term Memory）
 */
export class LongTermEpistemicGraph {
    constructor(embeddingService) {
        this.embedder = embeddingService;
        this.npcs = new Map();             // npcId -> { id, name, aliases }
        this.entities = new Map();         // entityName -> Set<factId>
        this.events = new Map();           // eventId -> { id, messageId, timestamp, location, participants, summary }
        this.facts = new Map();            // factId -> { id, eventId, messageId, timestamp, content, entities[], keywords[], supersededBy, isSecret, embedding }
        this.chapters = new Map();         // chapterId -> { id, startMsg, endMsg, summary, participants[], embedding }
        this.knowledgeEdges = new Map();   // npcId -> Map<factId, { factId, sourceType, sourceNpc, learnedAtMsg, confidence, distortedContent }>
        this.messagePresence = new Map();  // messageId -> Set<npcId>
    }

    ensureNpc(npcId, name = npcId, aliases = []) {
        if (!this.npcs.has(npcId)) {
            this.npcs.set(npcId, { id: npcId, name, aliases });
            this.knowledgeEdges.set(npcId, new Map());
        }
    }

    /**
     * 录入客观事件与拆解后的原子事实切片
     */
    async ingestEvent({ event, facts = [], epistemicGrants = [] }) {
        this.events.set(event.id, event);
        if (typeof event.messageId === 'number' && Array.isArray(event.participants)) {
            this.messagePresence.set(event.messageId, new Set(event.participants));
            for (const p of event.participants) {
                this.ensureNpc(p);
            }
        }

        for (const f of facts) {
            const vec = f.embedding
                ? new Float32Array(f.embedding)
                : (this.embedder ? await this.embedder.embedText(f.content) : null);

            const factRecord = {
                id: f.id,
                eventId: event.id,
                messageId: f.messageId ?? event.messageId ?? 0,
                timestamp: f.timestamp || event.timestamp || `第${event.messageId ?? 0}楼`,
                content: f.content,
                entities: Array.isArray(f.entities) ? f.entities : [],
                keywords: Array.isArray(f.keywords) ? f.keywords : [],
                supersededBy: f.supersededBy || null,
                isSecret: Boolean(f.isSecret),
                embedding: vec
            };
            this.facts.set(f.id, factRecord);

            // 时序状态覆盖链：若本条事实取代了旧事实（如物品位置转移），更新旧事实的 supersededBy 指针
            if (f.supersedesFactId && this.facts.has(f.supersedesFactId)) {
                this.facts.get(f.supersedesFactId).supersededBy = f.id;
            }

            // 建立实体倒排与图谱邻接表（用于 1-Hop 子图扩散）
            for (const ent of factRecord.entities) {
                if (!this.entities.has(ent)) {
                    this.entities.set(ent, new Set());
                }
                this.entities.get(ent).add(f.id);
            }
        }

        for (const grant of epistemicGrants) {
            this.grantKnowledge(grant);
        }
    }

    /**
     * 授予某个 NPC 对某条原子事实的认知边
     */
    grantKnowledge({
        npcId,
        factId,
        sourceType = 'WITNESS',
        sourceNpc = null,
        learnedAtMsg = 0,
        confidence = 1.0,
        distortedContent = null
    }) {
        this.ensureNpc(npcId);
        this.knowledgeEdges.get(npcId).set(factId, {
            factId,
            sourceType,       // 'ACTOR' | 'WITNESS' | 'HEARSAY' | 'INFERRED' | 'RUMOR_FALSE'
            sourceNpc,
            learnedAtMsg,
            confidence,
            distortedContent
        });
    }

    /**
     * 角色间信息传递：NPC A 将某条自己已知的事实（或局部/失真版本）告知 NPC B
     */
    propagateFact({
        fromNpcId,
        toNpcId,
        factId,
        learnedAtMsg = 0,
        confidence = 0.8,
        partialOrDistortedText = null,
        isFalseRumor = false
    }) {
        const senderEdges = this.knowledgeEdges.get(fromNpcId);
        if (!senderEdges || !senderEdges.has(factId)) {
            throw new Error(`违规传递：角色 [${fromNpcId}] 自身并不知道事实 [${factId}]，无法向 [${toNpcId}] 传递`);
        }
        this.grantKnowledge({
            npcId: toNpcId,
            factId,
            sourceType: isFalseRumor ? 'RUMOR_FALSE' : 'HEARSAY',
            sourceNpc: fromNpcId,
            learnedAtMsg,
            confidence,
            distortedContent: partialOrDistortedText
        });
    }

    /**
     * 核心：受角色知情边界严格限制的混合 GraphRAG 检索
     * 流程：
     *   1. 知情边白名单硬过滤（物理隔绝未知秘密）
     *   2. 认知时间差判定（若事实在全局已过期，但该 NPC 不知晓新事实，则仍作为该 NPC 的当前信念保留）
     *   3. 向量相似度 + 实体/关键词命中 + 楼层时间衰减混合打分
     *   4. 在该 NPC 已知子图内做 1-Hop 实体扩散，捞出多跳关联事实
     */
    async retrieveContextForNpc({ npcId, queryText = '', currentMsgId = 0, topK = 8 }) {
        this.ensureNpc(npcId);
        const npcEdges = this.knowledgeEdges.get(npcId);
        if (!npcEdges || npcEdges.size === 0) {
            return { activeFacts: [], historicalFacts: [] };
        }

        const queryVec = this.embedder ? await this.embedder.embedText(queryText) : null;
        const candidateMap = new Map();

        for (const [factId, edge] of npcEdges.entries()) {
            const fact = this.facts.get(factId);
            if (!fact) continue;

            // 判断在该 NPC 的主观认知里，这条事实是否已经被他所知晓的后续事实覆盖
            let isSupersededInNpcMind = false;
            let curr = fact;
            const visited = new Set([fact.id]);
            while (curr && curr.supersededBy && !visited.has(curr.supersededBy)) {
                visited.add(curr.supersededBy);
                if (npcEdges.has(curr.supersededBy)) {
                    isSupersededInNpcMind = true;
                    break;
                }
                curr = this.facts.get(curr.supersededBy);
            }

            const effectiveText = edge.distortedContent || fact.content;

            let denseScore = 0;
            if (queryVec && fact.embedding && this.embedder) {
                denseScore = this.embedder.cosineSimilarity(queryVec, fact.embedding);
            } else {
                denseScore = this._sparseSimilarity(queryText, effectiveText, fact.keywords);
            }

            let entityBonus = 0;
            for (const ent of fact.entities) {
                if (ent && queryText.includes(ent)) {
                    entityBonus += 0.3;
                }
            }
            for (const kw of fact.keywords) {
                if (kw && queryText.includes(kw)) {
                    entityBonus += 0.2;
                }
            }

            const age = Math.max(0, currentMsgId - (edge.learnedAtMsg || 0));
            const recencyScore = 1 / (1 + 0.004 * age);

            const statusMultiplier = isSupersededInNpcMind ? 0.35 : 1.0;
            const finalScore = (
                0.55 * denseScore +
                0.30 * Math.min(0.6, entityBonus) +
                0.15 * recencyScore
            ) * statusMultiplier;

            candidateMap.set(factId, {
                factId,
                effectiveText,
                entities: fact.entities,
                timestamp: fact.timestamp,
                learnedAtMsg: edge.learnedAtMsg,
                sourceType: edge.sourceType,
                sourceNpc: edge.sourceNpc,
                confidence: edge.confidence,
                isSupersededInNpcMind,
                globallyOutdatedButNpcUnaware: Boolean(fact.supersededBy && !isSupersededInNpcMind),
                isHopExpanded: false,
                viaEntity: null,
                score: finalScore
            });
        }

        const sortedSeeds = Array.from(candidateMap.values())
            .filter(c => !c.isSupersededInNpcMind)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);

        const selectedIds = new Set(sortedSeeds.map(s => s.factId));
        const activeFacts = [...sortedSeeds];

        // Step 4: 子图 1-Hop 实体关联扩散（严格限制在 npcEdges 白名单内）
        for (const seed of sortedSeeds.slice(0, 3)) {
            for (const ent of seed.entities) {
                const linkedFactIds = this.entities.get(ent);
                if (!linkedFactIds) continue;
                for (const linkedId of linkedFactIds) {
                    if (selectedIds.has(linkedId) || !npcEdges.has(linkedId)) continue;
                    const neighbor = candidateMap.get(linkedId);
                    if (neighbor && !neighbor.isSupersededInNpcMind && activeFacts.length < topK + 4) {
                        selectedIds.add(linkedId);
                        activeFacts.push({
                            ...neighbor,
                            isHopExpanded: true,
                            viaEntity: ent
                        });
                    }
                }
            }
        }

        const historicalFacts = Array.from(candidateMap.values())
            .filter(c => c.isSupersededInNpcMind)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);

        return { activeFacts, historicalFacts };
    }

    /**
     * 对发往 LLM 的聊天历史执行物理级遮蔽与百楼滑动窗口裁剪
     */
    sanitizeChatHistoryForNpc(chatArray, activeNpc, recentWindowSize = 16) {
        if (!Array.isArray(chatArray)) return [];
        const total = chatArray.length;
        const startIdx = Math.max(0, total - recentWindowSize);
        const windowed = chatArray.slice(startIdx).map((msg, idx) => {
            const msgId = msg.mes_id ?? (startIdx + idx);
            // 最新一条玩家输入不遮蔽
            if (startIdx + idx === total - 1 && msg.is_user) {
                return { ...msg };
            }
            const presentSet = this.messagePresence.get(msgId);
            if (presentSet && !presentSet.has(activeNpc)) {
                return {
                    ...msg,
                    mes: `[第${msgId}楼历史隔离：该事件发生时 ${activeNpc} 不在场，无现场记忆]`
                };
            }
            return { ...msg };
        });
        return windowed;
    }

    /**
     * 将检索结果格式化为注入模型的强边界 XML 提示词块
     */
    buildEpistemicPrompt({ npcId, activeFacts, historicalFacts = [] }) {
        const formatSource = (f) => {
            if (f.sourceType === 'ACTOR') return '亲身经历';
            if (f.sourceType === 'WITNESS') return '亲眼目击';
            if (f.sourceType === 'INFERRED') return '自身推理';
            if (f.sourceType === 'RUMOR_FALSE') return `轻信传言(来自${f.sourceNpc || '他人'})`;
            return `听【${f.sourceNpc || '他人'}】转述(可信度${Math.round((f.confidence ?? 0.8) * 100)}%)`;
        };

        const activeLines = activeFacts.length > 0
            ? activeFacts.map((f, i) => {
                const hopTag = f.isHopExpanded ? ` [关联实体:${f.viaEntity}]` : '';
                const lagWarning = f.globallyOutdatedButNpcUnaware
                    ? ' 【认知滞后锁定：后续客观世界虽已发生改变，但该角色毫不知情，扮演时必须坚信此旧事实！】'
                    : '';
                return `${i + 1}. [${f.timestamp} | ${formatSource(f)}${hopTag}] ${f.effectiveText}${lagWarning}`;
            }).join('\n')
            : '（暂无与当前话题相关的已知事实）';

        const historyLines = historicalFacts.length > 0
            ? '\n【该角色已知晓的过往旧状态（已被新事实取代）】：\n' +
              historicalFacts.map((f, i) => `${i + 1}. [旧记忆@${f.timestamp}] ${f.effectiveText}`).join('\n')
            : '';

        return [
            `<epistemic_long_term_memory character="${npcId}">`,
            `【当前发言角色】：${npcId}`,
            `【${npcId} 的当前有效认知子图（GraphRAG 检索结果）】：`,
            activeLines,
            historyLines,
            `【角色知情边界铁律】：`,
            `1. 你只能基于上述【当前有效认知子图】与你在场的对话进行回答、行动与推理。`,
            `2. 凡是未出现在【当前有效认知子图】中的隐秘事件、物品位置或他人私密对话，${npcId} 一律不知情；被追问时必须表现出真实的茫然、反问或仅凭既有传闻猜测，严禁跨视角全知泄密。`,
            `3. 若某条记忆标注了【认知滞后锁定】，说明信息尚未同步给 ${npcId}，必须严格按该角色的滞后认知行动。`,
            `</epistemic_long_term_memory>`
        ].filter(Boolean).join('\n');
    }

    _sparseSimilarity(query, targetText, keywords = []) {
        let score = 0.05;
        const q = (query || '').toLowerCase();
        const t = (targetText || '').toLowerCase();
        for (const kw of keywords) {
            if (kw && q.includes(kw.toLowerCase())) {
                score += 0.35;
            }
        }
        const makeBigrams = (s) => {
            const set = new Set();
            for (let i = 0; i < s.length - 1; i++) {
                const bg = s.slice(i, i + 2).trim();
                if (bg.length === 2) set.add(bg);
            }
            return set;
        };
        const qSet = makeBigrams(q);
        const tSet = makeBigrams(t);
        if (qSet.size > 0) {
            let overlap = 0;
            for (const b of qSet) {
                if (tSet.has(b)) overlap++;
            }
            score += overlap / qSet.size;
        }
        return Math.min(1.0, score);
    }

    serialize() {
        return {
            npcs: Array.from(this.npcs.entries()),
            entities: Array.from(this.entities.entries()).map(([k, set]) => [k, Array.from(set)]),
            events: Array.from(this.events.entries()),
            facts: Array.from(this.facts.entries()).map(([k, v]) => [
                k,
                { ...v, embedding: v.embedding ? Array.from(v.embedding) : null }
            ]),
            knowledgeEdges: Array.from(this.knowledgeEdges.entries()).map(([npcId, edgeMap]) => [
                npcId,
                Array.from(edgeMap.entries())
            ]),
            messagePresence: Array.from(this.messagePresence.entries()).map(([msgId, set]) => [
                msgId,
                Array.from(set)
            ])
        };
    }

    deserialize(data) {
        if (!data) return;
        this.npcs = new Map(data.npcs || []);
        this.entities = new Map((data.entities || []).map(([k, arr]) => [k, new Set(arr)]));
        this.events = new Map(data.events || []);
        this.facts = new Map((data.facts || []).map(([k, v]) => [
            k,
            { ...v, embedding: v.embedding ? new Float32Array(v.embedding) : null }
        ]));
        this.knowledgeEdges = new Map((data.knowledgeEdges || []).map(([npcId, arr]) => [
            npcId,
            new Map(arr)
        ]));
        this.messagePresence = new Map((data.messagePresence || []).map(([msgId, arr]) => [
            Number(msgId),
            new Set(arr)
        ]));
    }
}
