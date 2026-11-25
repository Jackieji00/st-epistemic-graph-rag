/**
 * Epistemic Hybrid GraphRAG 核心引擎
 * 解决多角色知情边界（Epistemic Boundary）与百楼级长期记忆（500+ Floors Long-Term Memory）
 */
import { floorStamp } from './backfill.js';

const wordSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
function words(text) {
    const terms = new Set();
    for (const part of wordSegmenter.segment(text.toLowerCase())) {
        if (part.isWordLike) terms.add(part.segment);
    }
    return terms;
}

function abilityNames(values) {
    if (!Array.isArray(values) || values.some(v => typeof v !== 'string' || !v.trim())) {
        throw new Error('能力请填写为非空名称的数组');
    }
    return [...new Set(values.map(v => v.trim()))];
}

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
        this.coveredFloors = new Map();    // source floor -> verified archive stamp
    }

    ensureNpc(npcId, name = npcId, aliases = []) {
        if (!this.npcs.has(npcId)) {
            this.npcs.set(npcId, { id: npcId, name, aliases });
            this.knowledgeEdges.set(npcId, new Map());
        }
    }

    setAbilities(npcId, values) {
        const abilities = abilityNames(values);
        this.ensureNpc(npcId);
        this.npcs.get(npcId).abilities = abilities;
    }

    perspectiveFor(npcId) {
        const abilities = this.npcs.get(npcId)?.abilities || [];
        return [
            `当前发言角色：${npcId}。已登记的专长：${abilities.join('、') || '暂无'}。`,
            '从本人的位置、感官、注意方向和实际接触过的信息描写。日常观察和常识推断照常；细微信号需要当时确实能察觉的具体机会，专业解读还需要相应专长。',
            '分别写清看见了什么、听谁说了什么、据此怀疑什么。线索能支持几种解释时保留歧义。熟练者也会错过线索；角色卡、旁白、玩家提问和其他人的内心不能充当本人证据。'
        ].join('\n');
    }

    /**
     * 录入客观事件与拆解后的原子事实切片
     */
    async ingestEvent({ event, facts = [], epistemicGrants = [] }) {
        this.events.set(event.id, event);
        if (typeof event.messageId === 'number' && Array.isArray(event.participants)) {
            // A retrospective summary can omit people who were present.
            if (!event.backfill) this.messagePresence.set(event.messageId, new Set(event.participants));
            for (const p of event.participants) {
                this.ensureNpc(p);
            }
        }

        for (const f of facts) {
            const embeddingSpace = f.embedding ? f.embeddingSpace : this.embedder?.spaceId;
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
                subtle: f.subtle === true,
                inferenceTarget: f.inferenceTarget === true,
                requiresAbilities: abilityNames(f.requiresAbilities ?? []),
                embedding: vec,
                embeddingSpace: vec ? embeddingSpace : null
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

        return this.applyGrants(epistemicGrants.map(g => ({ learnedAtMsg: event.messageId, ...g })));
    }

    applyGrants(grants) {
        // A clue or its speaker's grant may appear later in the same delta/import.
        let pending = grants;
        while (pending.length) {
            const unresolved = pending.filter(grant => !this.grantKnowledge(grant));
            if (unresolved.length === pending.length) break;
            pending = unresolved;
        }
        return pending;
    }

    /**
     * 授予某个 NPC 对某条原子事实的认知边
     */
    grantKnowledge({
        npcId,
        factId,
        sourceType = 'WITNESS',
        sourceNpc = null,
        learnedAtMsg,
        confidence = 1.0,
        distortedContent = null,
        noticedCue = '',
        basisFactIds = []
    }) {
        const fact = this.facts.get(factId);
        learnedAtMsg ??= fact?.messageId;
        if (!fact || !npcId || !Number.isFinite(learnedAtMsg) || fact.messageId > learnedAtMsg) return false;
        this.ensureNpc(npcId);
        const indirect = sourceType === 'HEARSAY' || sourceType === 'RUMOR_FALSE';
        const required = fact.requiresAbilities || [];
        const sensitive = fact.subtle || required.length > 0;
        if (sourceType === 'INFERRED') fact.inferenceTarget = true;
        if (!indirect && !required.every(a => this.npcs.get(npcId).abilities?.includes(a))) return false;
        if (sourceType === 'INFERRED') {
            const known = this.knowledgeEdges.get(npcId);
            if (!Array.isArray(basisFactIds) || !basisFactIds.length ||
                !basisFactIds.every(id => id !== factId && known.get(id)?.learnedAtMsg <= learnedAtMsg)) return false;
        } else if (indirect) {
            if (sensitive && (sourceNpc === npcId ||
                !(this.knowledgeEdges.get(sourceNpc)?.get(factId)?.learnedAtMsg <= learnedAtMsg))) return false;
        } else {
            if (!['ACTOR', 'WITNESS'].includes(sourceType)) return false;
            if (sensitive && (!this.events.get(fact.eventId)?.participants?.includes(npcId) ||
                typeof noticedCue !== 'string' || !noticedCue.trim())) return false;
        }
        this.knowledgeEdges.get(npcId).set(factId, {
            factId,
            sourceType,       // 'ACTOR' | 'WITNESS' | 'HEARSAY' | 'INFERRED' | 'RUMOR_FALSE'
            sourceNpc,
            learnedAtMsg,
            confidence,
            distortedContent,
            ...(sourceType === 'INFERRED' && { basisFactIds: [...basisFactIds] }),
            ...(noticedCue && { noticedCue })
        });
        return true;
    }

    /**
     * 角色间信息传递：NPC A 将某条自己已知的事实（或局部/失真版本）告知 NPC B
     */
    propagateFact({
        fromNpcId,
        toNpcId,
        factId,
        learnedAtMsg,
        confidence = 0.8,
        partialOrDistortedText = null,
        isFalseRumor = false
    }) {
        const senderEdges = this.knowledgeEdges.get(fromNpcId);
        if (!senderEdges || !senderEdges.has(factId)) {
            throw new Error(`违规传递：角色 [${fromNpcId}] 自身并不知道事实 [${factId}]，无法向 [${toNpcId}] 传递`);
        }
        return this.grantKnowledge({
            npcId: toNpcId,
            factId,
            sourceType: isFalseRumor ? 'RUMOR_FALSE' : 'HEARSAY',
            sourceNpc: fromNpcId,
            learnedAtMsg: learnedAtMsg ?? senderEdges.get(factId).learnedAtMsg,
            confidence,
            distortedContent: partialOrDistortedText || senderEdges.get(factId).distortedContent
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
    async retrieveContextForNpc({ npcId, queryText = '', currentMsgId, topK = 8 }) {
        this.ensureNpc(npcId);
        const npcEdges = this.knowledgeEdges.get(npcId);
        if (!npcEdges || npcEdges.size === 0) {
            return { activeFacts: [], historicalFacts: [] };
        }

        // Index this speaker's version first. Even the frequency of a clue must
        // be independent of facts (or parts of facts) the speaker has not learned.
        const visible = new Map();
        const byTerm = new Map();
        const query = queryText.toLowerCase();
        const queryTerms = words(query);
        for (const [factId, edge] of npcEdges) {
            const fact = this.facts.get(factId);
            if (!fact || (edge.learnedAtMsg ?? fact.messageId) > (currentMsgId ?? Infinity)) continue;
            const text = edge.distortedContent || fact.content;
            const terms = words(text);
            const entities = [];
            if (!edge.distortedContent) {
                const literal = text.toLowerCase();
                const namedEntities = new Set(fact.entities || []);
                for (const label of new Set([...namedEntities, ...(fact.keywords || [])])) {
                    if (typeof label !== 'string') continue;
                    const term = label.trim().toLowerCase();
                    if (!term || !literal.includes(term)) continue;
                    terms.add(term);
                    if (query.includes(term)) queryTerms.add(term);
                    if (namedEntities.has(label)) entities.push(label);
                }
            }
            visible.set(factId, { fact, edge, text, terms, entities });
            for (const term of terms) {
                if (!byTerm.has(term)) byTerm.set(term, []);
                byTerm.get(term).push(factId);
            }
        }
        const space = this.embedder?.spaceId;
        const canRankByVector = space && Array.from(visible.values()).some(({ fact, edge }) =>
            !edge.distortedContent && fact.embedding && fact.embeddingSpace === space);
        const queryVec = canRankByVector ? await this.embedder.embedText(queryText) : null;
        const candidateMap = new Map();

        const rarity = term => Math.log((1 + visible.size) / byTerm.get(term).length);
        for (const [factId, { fact, edge, text, terms, entities }] of visible) {

            // 判断在该 NPC 的主观认知里，这条事实是否已经被他所知晓的后续事实覆盖
            let isSupersededInNpcMind = false;
            let curr = fact;
            const visited = new Set([fact.id]);
            while (curr && curr.supersededBy && !visited.has(curr.supersededBy)) {
                visited.add(curr.supersededBy);
                if (visible.has(curr.supersededBy)) {
                    isSupersededInNpcMind = true;
                    break;
                }
                curr = this.facts.get(curr.supersededBy);
            }

            let overlap = 0;
            for (const term of terms) {
                if (queryTerms.has(term)) overlap += rarity(term);
            }
            const lexicalScore = overlap / (1 + overlap);
            const similarity = queryVec && !edge.distortedContent && fact.embeddingSpace === space && fact.embedding?.length === queryVec.length
                ? this.embedder.cosineSimilarity(queryVec, fact.embedding) : lexicalScore;
            const age = Math.max(0, (currentMsgId ?? 0) - (edge.learnedAtMsg || 0));
            const recencyScore = 1 / (1 + 0.004 * age);

            const statusMultiplier = isSupersededInNpcMind ? 0.35 : 1.0;
            const finalScore = (
                0.55 * similarity +
                0.30 * lexicalScore +
                0.15 * recencyScore
            ) * statusMultiplier;

            candidateMap.set(factId, {
                factId,
                effectiveText: text,
                entities,
                timestamp: edge.distortedContent ? `第${edge.learnedAtMsg}楼获知` : fact.timestamp,
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

        // Follow a named entity or a current clue through visible text on both ends.
        const neighbors = new Map();
        for (const seed of sortedSeeds.slice(0, 3)) {
            const anchors = new Set(seed.entities.map(name => name.trim().toLowerCase()));
            for (const term of visible.get(seed.factId).terms) {
                if (queryTerms.has(term) && term.length > 1) anchors.add(term);
            }
            for (const term of anchors) {
                const linked = byTerm.get(term);
                if (linked.length < 2 || linked.length * 2 > visible.size || term === npcId.toLowerCase()) continue;
                for (const id of linked) {
                    const neighbor = candidateMap.get(id);
                    if (selectedIds.has(id) || neighbor.isSupersededInNpcMind) continue;
                    if (!neighbors.has(id)) neighbors.set(id, new Set());
                    neighbors.get(id).add(term);
                }
            }
        }
        const links = Array.from(neighbors, ([id, terms]) => {
            const clues = [...terms].sort((a, b) => rarity(b) - rarity(a));
            return { fact: candidateMap.get(id), via: clues[0], weight: clues.reduce((sum, t) => sum + rarity(t), 0) };
        });
        links.sort((a, b) => b.weight - a.weight || b.fact.score - a.fact.score);
        for (const link of links.slice(0, 4)) {
            activeFacts.push({ ...link.fact, isHopExpanded: true, viaEntity: link.via });
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
    sourceFloors(chat, original = []) {
        const dates = new Map();
        for (const [i, row] of original.entries()) {
            if (row?.send_date != null) dates.set(row.send_date, dates.has(row.send_date) ? undefined : i);
        }
        return chat.map((row, i) => {
            if (!row) return undefined;
            if (Number.isInteger(row.mes_id)) return row.mes_id;
            if (row.send_date != null && dates.has(row.send_date)) return dates.get(row.send_date);
            const index = Number.isInteger(row.index) ? row.index : i;
            if (!original.length || row === original[index]) return index;
            if (original[index] && floorStamp(row) === floorStamp(original[index])) return index;
            return undefined;
        });
    }

    restrictSceneDetails(chat, npcId, originalChat = [], floors = this.sourceFloors(chat, originalChat)) {
        const edges = this.knowledgeEdges.get(npcId);
        const restricted = new Set();
        for (const fact of this.facts.values()) {
            const edge = edges?.get(fact.id);
            if (!fact.isSecret && !fact.subtle && !fact.requiresAbilities?.length && !fact.inferenceTarget && !edge?.distortedContent) continue;
            if (!edge || edge.learnedAtMsg > fact.messageId || edge.distortedContent ||
                !['ACTOR', 'WITNESS'].includes(edge.sourceType)) restricted.add(fact.messageId);
        }
        if (!restricted.size && !this.coveredFloors.size) return;
        const visible = new Map();
        for (const fact of this.facts.values()) {
            const edge = edges?.get(fact.id);
            if ((!restricted.has(fact.messageId) && !this.coveredFloors.has(fact.messageId)) ||
                !edge || edge.learnedAtMsg > fact.messageId) continue;
            const lines = visible.get(fact.messageId) || [];
            const source = { INFERRED: '推测', HEARSAY: '听说', RUMOR_FALSE: '传闻' }[edge.sourceType] || '当时所见所做';
            lines.push(source + '：' + (edge.distortedContent || fact.content));
            visible.set(fact.messageId, lines);
        }
        for (const [i, m] of chat.entries()) {
            if (!m || m.is_system || (m.is_user && i === chat.length - 1)) continue;
            const floor = floors[i];
            const covered = this.isCoveredFloor(floor, m, originalChat);
            if (covered || (!m.is_user && restricted.has(floor))) {
                chat[i] = { ...m, mes: (visible.get(floor) || ['【本角色未注意到该段细节】']).join('\n') };
            }
        }
    }

    isCoveredFloor(floor, message, sourceChat = []) {
        if (!Number.isInteger(floor) || !this.coveredFloors.has(floor)) return false;
        const source = sourceChat[floor] ?? message;
        return !!source && floorStamp(source) === this.coveredFloors.get(floor);
    }

    sanitizeChatHistoryForNpc(chatArray, activeNpc, recentWindowSize = 16) {
        if (!Array.isArray(chatArray)) return [];
        const projected = chatArray.slice();
        const floors = this.sourceFloors(chatArray, chatArray);
        this.restrictSceneDetails(projected, activeNpc, chatArray, floors);
        const cutoff = Math.max(0, projected.length - recentWindowSize);
        return projected.flatMap((msg, i) => {
            const floor = floors[i];
            if (this.isCoveredFloor(floor, msg, chatArray)) return i < cutoff ? [] : [msg];
            const present = this.messagePresence.get(floor);
            if (present?.size && !present.has(activeNpc) && !(msg.is_user && i === projected.length - 1)) {
                return [{ ...msg, mes: `[第${floor}楼历史隔离：该事件发生时 ${activeNpc} 不在场，无现场记忆]` }];
            }
            return [msg];
        });
    }

    /**
     * 将检索结果格式化为注入模型的强边界 XML 提示词块
     */
    buildEpistemicPrompt({ npcId, activeFacts, historicalFacts = [] }) {
        const formatSource = (f) => {
            if (f.sourceType === 'ACTOR') return '亲身经历';
            if (f.sourceType === 'WITNESS') return '亲眼目击';
            if (f.sourceType === 'INFERRED') return '据本人线索推测，尚待证实';
            if (f.sourceType === 'RUMOR_FALSE') return `轻信传言(来自${f.sourceNpc || '他人'})`;
            return `听【${f.sourceNpc || '他人'}】转述(可信度${Math.round((f.confidence ?? 0.8) * 100)}%)`;
        };

        const activeLines = activeFacts.length > 0
            ? activeFacts.map((f, i) => {
                const hopTag = f.isHopExpanded ? ' [关联记忆]' : '';
                return `${i + 1}. [${f.timestamp} | ${formatSource(f)}${hopTag} | id=${f.factId}] ${f.effectiveText}`;
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
            `3. 在本人得到新证据前，按最后获知的状态行动。`,
            `</epistemic_long_term_memory>`
        ].filter(Boolean).join('\n');
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
            ]),
            coveredFloors: Array.from(this.coveredFloors.entries())
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
        this.coveredFloors = new Map(data.coveredFloors || []);
    }
}
