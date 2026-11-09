const DB_NAME = 'ST_EpistemicGraphRAG_DB';
const DB_VERSION = 1;
const STORE_NAME = 'chat_graphs';

export class GraphStorage {
    constructor() {
        this.db = null;
        this.memoryFallback = new Map();
    }

    async init() {
        if (this.db) return this.db;
        if (typeof indexedDB === 'undefined') {
            return null;
        }
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'chatId' });
                }
            };
            req.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async saveGraph(chatId, serializedData) {
        if (!chatId) return false;
        const db = await this.init();
        if (!db) {
            this.memoryFallback.set(chatId, { chatId, updatedAt: Date.now(), ...serializedData });
            return true;
        }
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put({
                chatId,
                updatedAt: Date.now(),
                ...serializedData
            });
            tx.oncomplete = () => resolve(true);
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    async loadGraph(chatId) {
        if (!chatId) return null;
        const db = await this.init();
        if (!db) {
            return this.memoryFallback.get(chatId) || null;
        }
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(chatId);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async deleteGraph(chatId) {
        if (!chatId) return false;
        const db = await this.init();
        if (!db) {
            return this.memoryFallback.delete(chatId);
        }
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(chatId);
            tx.oncomplete = () => resolve(true);
            tx.onerror = (e) => reject(e.target.error);
        });
    }
}
