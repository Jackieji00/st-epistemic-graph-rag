const sessionKeys = new Map();

export function normalizeProviderConfig(kind, config = {}) {
    const modes = kind === 'summary' ? ['tavern', 'profile', 'openai-compatible'] : ['disabled', 'openai-compatible'];
    const mode = config.mode ?? modes[0];
    if (!modes.includes(mode)) throw new Error('请选择有效的 API 连接方式');
    const out = { mode };
    if (mode === 'profile') {
        out.profileId = String(config.profileId || '').trim();
        if (!out.profileId) throw new Error('请选择一个连接档');
    }
    if (mode === 'openai-compatible') {
        let url;
        try { url = new URL(String(config.baseUrl || '').trim()); } catch { throw new Error('API 地址无效'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址必须为无凭证、无查询参数的 HTTP(S) 地址');
        url.pathname = url.pathname.replace(/\/+$/, '');
        if (/\/(embeddings|chat\/completions)$/.test(url.pathname)) throw new Error('API 地址填写 base URL，请移除 /embeddings 或 /chat/completions');
        out.baseUrl = url.toString().replace(/\/$/, '');
        out.model = String(config.model || '').trim();
        if (!out.model) throw new Error('请填写模型名称');
    }
    return out;
}

function keyId(kind, config) { const normalized = normalizeProviderConfig(kind, config); return kind + ':' + (normalized.baseUrl || ''); }

export function setSessionApiKey(kind, config, key) {
    const id = keyId(kind, config);
    if (typeof key !== 'string' || !key.trim()) return sessionKeys.delete(id);
    sessionKeys.set(id, key.trim());
    return true;
}

async function compatibleRequest(kind, config, payload, keyOverride) {
    const id = keyId(kind, config);
    const key = keyOverride === undefined ? sessionKeys.get(id) : (typeof keyOverride === 'string' && keyOverride.trim() ? keyOverride.trim() : null);
    const prefix = new URL(config.baseUrl).pathname === '/' ? '/v1' : '';
    const url = config.baseUrl + prefix + (kind === 'summary' ? '/chat/completions' : '/embeddings');
    const response = await fetch(url, {
        method: 'POST', credentials: 'omit', redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
        body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error('API 请求失败 (HTTP ' + response.status + ')');
    try { return await response.json(); }
    catch { throw new Error('API 返回了无效 JSON，请核对基础地址'); }
}

export async function generateSummary(config, { systemPrompt = '', prompt = '', responseLength = 1024 } = {}, ctx = {}, keyOverride) {
    const normalized = normalizeProviderConfig('summary', config);
    if (normalized.mode === 'tavern') {
        if (typeof ctx.generateRaw !== 'function') throw new Error('当前上下文不支持酒馆原生生成');
        return ctx.generateRaw({ systemPrompt, prompt, responseLength, trimNames: false });
    }
    if (normalized.mode === 'profile') {
        const service = ctx.ConnectionManagerRequestService;
        if (!service?.sendRequest || !normalized.profileId) throw new Error('当前酒馆未提供所选连接档请求服务');
        const result = await service.sendRequest(normalized.profileId, [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }], responseLength,
            { includePreset: false, includeInstruct: false, stream: false });
        const content = typeof result === 'string' ? result : result?.content;
        if (typeof content !== 'string' || !content.trim()) throw new Error('连接档未返回文本');
        return content;
    }
    const data = await compatibleRequest('summary', normalized, {
        model: normalized.model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }], max_tokens: responseLength, stream: false
    }, keyOverride);
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('API 未返回文本');
    return text;
}

export async function embedText(config, text, keyOverride) {
    const normalized = normalizeProviderConfig('vector', config);
    if (normalized.mode !== 'openai-compatible') return null;
    const data = await compatibleRequest('vector', normalized, { model: normalized.model, input: text }, keyOverride);
    const vector = data.data?.[0]?.embedding;
    if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)) throw new Error('API 未返回有效向量');
    return new Float32Array(vector);
}

export async function testProviderApi(kind, config, ctx = {}, keyOverride) {
    const normalized = normalizeProviderConfig(kind, config);
    if (kind === 'summary') await generateSummary(normalized, { systemPrompt: 'Return only the supplied token.', prompt: 'SYNTHETIC_LOCAL_TEST', responseLength: 32 }, ctx, keyOverride);
    else {
        const vector = await embedText(normalized, 'SYNTHETIC_LOCAL_TEST', keyOverride);
        if (!vector) throw new Error('向量 API 未启用');
        return '连接成功（向量维数 ' + vector.length + '）';
    }
    return '连接成功';
}
