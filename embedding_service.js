import { embedText as requestEmbedding, normalizeProviderConfig } from './provider_api.js';

export class EmbeddingService {
    constructor(options = {}) {
        this.getConfig = options.getConfig || (() => options.config || { mode: 'disabled' });
        this.cache = new Map();
    }

    get spaceId() {
        const config = normalizeProviderConfig('vector', this.getConfig());
        return config.mode === 'openai-compatible' ? JSON.stringify([config.mode, config.baseUrl, config.model]) : '';
    }

    async embedText(text, { strict = false } = {}) {
        if (typeof text !== 'string' || !text.trim()) {
            if (strict) throw new Error('无法为无文本内容创建向量');
            return null;
        }
        let config;
        try { config = normalizeProviderConfig('vector', this.getConfig()); }
        catch (error) { if (strict) throw error; return null; }
        if (config.mode !== 'openai-compatible') {
            if (strict) throw new Error('向量 API 未启用');
            return null;
        }
        const normalized = text.trim(), cacheKey = this.spaceId + '\0' + normalized;
        if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
        try {
            const vector = await requestEmbedding(config, normalized);
            this.cache.set(cacheKey, vector);
            return vector;
        } catch (error) {
            if (strict) throw new Error('向量请求失败：' + String(error?.message || '未知错误').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]'));
            return null;
        }
    }

    cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dot += vecA[i] * vecB[i]; normA += vecA[i] * vecA[i]; normB += vecB[i] * vecB[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dot / denom;
    }
}
