export class EmbeddingService {
    constructor(options = {}) {
        this.provider = options.provider || 'transformers';
        this.getRequestHeaders = options.getRequestHeaders || (() => ({ 'Content-Type': 'application/json' }));
        this.enableRemoteVector = options.enableRemoteVector !== false;
        this.cache = new Map();
    }

    /**
     * 调用 SillyTavern 原生向量接口将文本转为 Float32Array 向量；若环境不支持则返回 null 交由稀疏+图检索处理
     */
    async embedText(text) {
        if (!text || !text.trim()) return null;
        const normalized = text.trim();
        if (this.cache.has(normalized)) {
            return this.cache.get(normalized);
        }
        if (!this.enableRemoteVector || typeof fetch === 'undefined') {
            return null;
        }
        try {
            const response = await fetch('/api/vector/embed', {
                method: 'POST',
                headers: this.getRequestHeaders(),
                body: JSON.stringify({
                    source: this.provider,
                    text: normalized
                })
            });
            if (!response.ok) throw new Error(`Embedding HTTP ${response.status}`);
            const data = await response.json();
            const vec = Array.isArray(data.embedding) ? new Float32Array(data.embedding) : null;
            if (vec) this.cache.set(normalized, vec);
            return vec;
        } catch {
            return null;
        }
    }

    /**
     * 余弦相似度计算（Float32Array 点积）
     */
    cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dot += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dot / denom;
    }
}
