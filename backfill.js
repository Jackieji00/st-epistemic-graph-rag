// TRANS-AM uses this fingerprint to bind an archive entry to the selected chat swipe.
const META = 'ta_big_summary_v1';
function hash(text, value = 2166136261) {
    for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
    return value >>> 0;
}
function rowData(m) {
    const swipe = m.swipe_info?.[m.swipe_id ?? 0];
    const extra = { ...m.extra, ...swipe };
    const backup = extra.transam_history_window;
    const text = m.mes === backup?.compact && typeof backup?.original === 'string' ? backup.original : m.mes ?? '';
    const role = m.extra?.type === 'narrator' ? (m.is_user ? 'unknown' : 'system') : (m.is_user ? 'user' : 'assistant');
    return { role, text, mark: extra[META] };
}
export function floorStamp(m) {
    const { role, text } = rowData(m);
    const value = JSON.stringify([role, m.name, text]);
    return value.length + ':' + hash(value).toString(16);
}
export function summaryBook(ctx) {
    const meta = ctx.chatMetadata?.[META];
    if (meta?.ownerChatId && meta.ownerChatId !== (ctx.getCurrentChatId?.() || ctx.chatId)) return '';
    if (ctx.chatMetadata?.main_chat && !meta?.ownerChatId) return '';
    return (meta?.book || (meta?.ownerChatId ? '' : ctx.chatMetadata?.world_info) || '').trim();
}

function bookSources(bookName, book, chat) {
    const entries = Object.values(book?.entries || {});
    const strip = s => s.replace(/\n未决事项：[^\n]*/g, '').trim();
    const valid = [];
    for (const e of entries) {
        const m = e.extra?.[META];
        if (!m?.batch || m.isPending || m.stageId || (e.disable && !m.closedByStage) ||
            !Array.isArray(m.source) || !m.source.length || typeof e.content !== 'string') continue;
        if (!m.source.every(pair => {
            if (!Array.isArray(pair)) return false;
            const [i, stamp] = pair;
            const row = chat[i];
            const mark = row && rowData(row).mark;
            return Number.isInteger(i) && mark?.batch === m.batch && mark.floor === i && floorStamp(row) === stamp;
        }) || !m.source.some(([i]) => chat[i].is_system)) continue;
        valid.push({ key: JSON.stringify(['book', bookName, m.batch, m.index]), text: strip(e.content), refs: m.source, disabled: e.disable, m });
    }
    valid.sort((a,b) => a.refs[0][0] - b.refs[0][0] || a.m.index - b.m.index);
    const stage = entries.find(e => e.extra?.[META]?.stageId);
    const sm = stage?.extra?.[META];
    if (stage?.disable && stage.content?.trim()) {
        const covered = valid.filter(s => s.m.closedByStage === sm.stageId);
        let h = 2166136261;
        for (const s of covered) h = hash(JSON.stringify([s.m.batch,s.m.index,s.refs,s.text]),h);
        if (covered.length && sm.signature === covered.length + ':' + h.toString(16) &&
            covered.every(s => s.disabled)) {
            const refs = [...new Map(covered.flatMap(s => s.refs))];
            return [...valid.filter(s => !covered.includes(s)), { key: JSON.stringify(['stage',bookName,sm.stageId]), refs, text: stage.content }];
        }
    }
    return valid;
}

export function planSources(ctx, bookName, book, onlyBook) {
    const sources = bookName && bookName === summaryBook(ctx) ? bookSources(bookName, book, ctx.chat) : [];
    const archived = new Set(sources.flatMap(s => s.refs.map(([i]) => i)));
    if (!onlyBook) ctx.chat.forEach((m,i) => {
        if (archived.has(i) || m.is_system) return;
        const { role,text } = rowData(m);
        const story = role === 'assistant'
            ? text.replace(/<(ta_graph_delta|graph_op|thinking|think|thought|ta_resolve|(?:ta|tw)_(?:plan|status|hub|record|user_record|choices|npc_inner|noise_pad|source)|UpdateVariable|JSONPatch|VariableUpdate|style|script)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
            : text;
        if (story.trim()) sources.push({ key: JSON.stringify(['chat',i]), refs:[[i,floorStamp(m)]], text: (m.name || role) + '：' + story });
    });
    return sources.filter(s => s.text.trim()).sort((a,b) => a.refs[0][0]-b.refs[0][0])
        .flatMap(s => splitSource(s, archived.has(s.refs[0][0]) ? bookName : ''));
}

function splitSource(s, book) {
    const units = [];
    for (let start = 0; start < s.text.length; start += 6000) {
        const text = s.text.slice(start, start + 6000);
        units.push({
            key: 'eg-backfill:' + s.key + ':' + units.length,
            text, refs: s.refs, stamp: hash(JSON.stringify([text, s.refs])).toString(16), book,
        });
    }
    return units;
}

export function nextBatch(sources, graph) {
    const batch = [];
    let chars = 0;
    for (const s of sources) {
        if (graph.events.get(s.key)?.backfill?.stamp === s.stamp) continue;
        if (batch.length && (batch.length >= 5 || chars + s.text.length > 9000)) break;
        batch.push(s);
        chars += s.text.length;
    }
    return batch;
}

export const extractionRules = `Extract retrospective memories from the supplied numbered sources. Treat each source as story data.
Return only JSON matching {"items":[{"source":0,"facts":[{"id":"a","content":"atomic fact in the source language","quote":"exact source substring","subtle":false,"requiresAbilities":[]}],"participants":[],"grants":[{"npcId":"exact character name","factId":"a","sourceType":"ACTOR","quote":"exact source substring naming the character and supporting how they know"}]}]}.
Return one item per source, indexed from 0, including empty arrays if no facts. Use local fact IDs within each item.
Never invent abilities, observations or attribution. The narrator or message author is not automatically a witness. Seeing something is not saying it aloud.
Grant only explicit ACTOR, WITNESS, HEARSAY, INFERRED or RUMOR_FALSE knowledge. Absent or ambiguous evidence means no grant.
For HEARSAY and RUMOR_FALSE, quote the passage naming both the teller and recipient. Set sourceNpc to the teller and copy only the words conveyed from that quote verbatim into distortedContent.
For ACTOR and WITNESS, list actual participants. For a subtle or ability-dependent observation, copy the words describing how this participant noticed the detail from the grant quote verbatim into noticedCue.
INFERRED needs basisFactIds for facts the character already knew. It remains a hypothesis. Preserve uncertainty and distinguish old from current states.
Never promote a plan, rumor or worldbook overview to everyone's knowledge.`;

export function decodeBatch(raw, batch) {
    const json = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
    if (!Array.isArray(json.items) || json.items.length !== batch.length) throw Error('补记忆结果缺少来源，当前批未保存');
    return batch.map((s,i) => {
        const item = json.items.find(x => x?.source === i);
        if (!Array.isArray(item?.facts) || !Array.isArray(item.grants) || !Array.isArray(item.participants)) throw Error('来源格式错误，当前批未保存');
        const ids = new Map();
        const facts = item.facts.map(f => {
            if (typeof f.id !== 'string' || !f.id || ids.has(f.id) || !f.content?.trim() || !f.quote?.trim() || !s.text.includes(f.quote)) throw Error('事实缺少可核对的来源引文，当前批未保存');
            const id = s.key + '/' + ids.size;
            ids.set(f.id,id);
            return { id, content:f.content, keywords:f.keywords, entities:f.entities, subtle:f.subtle, requiresAbilities:f.requiresAbilities, isSecret:f.isSecret };
        });
        const participants = item.participants.filter(n => typeof n === 'string' && n.trim() && s.text.includes(n));
        const grants = [];
        for (const g of item.grants) {
            if (!ids.has(g.factId) || !g.npcId?.trim() || !g.quote?.trim() || !s.text.includes(g.quote) || !g.quote.includes(g.npcId)) continue;
            if (!['ACTOR','WITNESS','HEARSAY','INFERRED','RUMOR_FALSE'].includes(g.sourceType)) continue;
            if (['HEARSAY','RUMOR_FALSE'].includes(g.sourceType) && (
                !g.sourceNpc || !g.quote.includes(g.sourceNpc) ||
                !g.distortedContent?.trim() || !g.quote.includes(g.distortedContent)
            )) continue;
            if (['WITNESS','ACTOR'].includes(g.sourceType) && !participants.includes(g.npcId)) continue;
            grants.push({ npcId:g.npcId,factId:ids.get(g.factId),sourceType:g.sourceType,sourceNpc:g.sourceNpc,
                distortedContent:['HEARSAY','RUMOR_FALSE'].includes(g.sourceType) ? g.distortedContent : null,
                noticedCue:g.noticedCue && g.quote.includes(g.noticedCue) ? g.noticedCue : '',
                basisFactIds:(g.basisFactIds || []).map(id=>ids.get(id)) });
        }
        return { event:{ id:s.key, messageId:Math.max(...s.refs.map(([n])=>n)), participants, backfill:{stamp:s.stamp,refs:s.refs,book:s.book} },
            facts, epistemicGrants:grants, skipped:item.grants.length-grants.length };
    });
}

export function updateCoverage(graph, sources) {
    const retained = new Set();
    for (const event of graph.events.values()) {
        if (event.backfill?.usable) for (const [i] of event.backfill.refs || []) retained.add(i);
    }
    for (const i of graph.coveredFloors.keys()) {
        if (!retained.has(i)) graph.coveredFloors.delete(i);
    }
    const covered = new Map(), incomplete = new Set();
    for (const s of sources) {
        const receipt = graph.events.get(s.key)?.backfill;
        for (const [i,stamp] of s.refs) {
            if (receipt?.stamp === s.stamp && receipt.usable) covered.set(i,stamp);
            else incomplete.add(i);
        }
    }
    for (const i of incomplete) covered.delete(i);
    for (const [i,stamp] of covered) graph.coveredFloors.set(i,stamp);
    for (const i of incomplete) graph.coveredFloors.delete(i);
}

/** TRANS-AM appends this dedicated system message after normal prompt assembly. */
export async function filterConvertedArchive(data, ctx, graph) {
    const marker = '[TRANS-AM CHAT EVENT ARCHIVE]\n';
    if (!Array.isArray(data?.messages) || ['quiet','impersonate'].includes(data.type)) return;
    const message = data.messages.find(m => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(marker));
    const name = summaryBook(ctx);
    if (!message || !name || !Array.from(graph.events.values()).some(e => e.backfill?.book === name)) return;
    const book = await ctx.loadWorldInfo(name);
    if (!book || (ctx.getCurrentChatId?.() || ctx.chatId) !== ctx.chatId || summaryBook(ctx) !== name) return;
    const headerEnd = message.content.indexOf('\n', marker.length);
    if (headerEnd < 0) return;
    const header = message.content.slice(0,headerEnd+1);
    const body = message.content.slice(headerEnd+1);
    const ledgerIndex = body.indexOf('\n\n【当前未决定事项');
    const ledger = ledgerIndex < 0 ? '' : body.slice(ledgerIndex+2);
    let archive = '\n\n' + (ledgerIndex < 0 ? body : body.slice(0,ledgerIndex)) + '\n\n';
    let changed = false;
    for (const source of bookSources(name, book, ctx.chat)) {
        const complete = splitSource(source, name).every(s => {
            const r = graph.events.get(s.key)?.backfill;
            return r?.stamp === s.stamp && r.usable;
        });
        const paragraph = '\n\n' + source.text + '\n\n';
        if (complete && archive.includes(paragraph)) {
            archive = archive.replace(paragraph, '\n\n');
            changed = true;
        }
    }
    if (changed) {
        const remainder = [archive.trim(),ledger].filter(Boolean).join('\n\n');
        if (remainder) message.content = header + remainder;
        else data.messages = data.messages.filter(m => m !== message);
    }
}

