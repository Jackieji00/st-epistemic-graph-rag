# System Explanation

## Purpose

The extension stores objective events as facts and grants each NPC a separate knowledge edge for each fact. Before an eligible SillyTavern assistant reply, it injects graph-building instructions and, when retrieval returns usable memories, a separate epistemic memory prompt. It may then trim old chat messages and mask events for which the current NPC has no presence record. Graph data is persisted separately for each chat in IndexedDB.

## Generation lifecycle (`index.js`)

### `clearGenerationPrompts(): void`

Clears the memory prompt key and the independent build-rule prompt key through SillyTavern's supported `setExtensionPrompt` API. Called at the start of every interceptor invocation and on chat switches, so all early returns leave no stale prompt values.

### `epistemicGraphInterceptor(chat, contextSize, abort, type): Promise<void>`

Inputs: SillyTavern's mutable outgoing message array, context token limit, abort callback, and generation type. Output: no direct return value; it updates extension prompts and may mutate `chat` only after usable graph context has been retrieved.

Flow: clears old extension prompts and increments an epoch; returns without injecting for disabled, non-assistant/auxiliary, missing-chat, unknown-chat-state, or unresolvable-speaker cases. It retrieves against the original, unmodified message tail. After the asynchronous retrieval it verifies epoch, enabled state, chat ID, active NPC, and loaded graph chat to prevent stale results crossing chat or speaker changes. Eligible new turns receive the graph-build rules even when the graph has no facts for that NPC. Continuations may still retrieve memory but do not repeat the build instructions. If retrieval is empty, the original history remains untouched. If memory exists, the interceptor sets the separate memory prompt, masks known absent-history messages when enabled, then applies the configured recent-message window.

Fact IDs are instructed to use a stable per-turn prefix containing the message count and active NPC name plus a sequence suffix. Grant rules limit knowledge to explicitly named characters with an in-story basis; a card/world name is not treated as universal knowledge.

### `syncCurrentChatGraph(): Promise<void>`

Loads serialized graph state for the open chat. It rechecks the chat ID after the IndexedDB read before deserializing, preventing a slow read from replacing the graph after a chat switch. When the destination has no saved graph, it deserializes an empty object to clear prior chat state (`deserialize(null)` intentionally does nothing). It records the loaded chat ID only after state is safely synchronized.

### Chat and message event handlers

`CHAT_CHANGED` increments the generation epoch, invalidates the loaded-chat marker, clears both prompts, waits for any in-flight received-message update to persist under its captured source chat ID, then loads the newly selected chat. `MESSAGE_RECEIVED` captures the raw message and chat ID, queues parsing against the currently loaded graph, and persists directly to that captured ID. This prevents an asynchronous receive update from being saved under a different chat or racing the next graph deserialization. Display-only regex rules can hide metadata without stripping the source message from the graph consumer.

### `parseAndApplyGraphMarkup(messageText, messageId, targetGraph): Promise<boolean>`

Input: raw received message, its chat-array index, and an optional graph. Parses `<ta_graph_delta>` JSON blocks into event/fact/grant records and `<graph_op>` propagation instructions into knowledge edges. Returns whether any graph update occurred. The receive path persists only when this is true.

### `resolveActiveNpc(): string`

Returns the configured manual speaker when manual mode is enabled; otherwise uses SillyTavern's current `name2`, falling back to the first character in context. Returns an empty string when no speaker can be determined.

## Supporting modules

- `long_term_graph_rag.js`: `ensureNpc` creates stable NPC nodes; `ingestEvent` records event, facts, presence, and grants; `grantKnowledge` creates per-NPC edges; `propagateFact` models explicit information transfer; `retrieveContextForNpc` applies knowledge-edge filtering and hybrid ranking; `sanitizeChatHistoryForNpc` is the standalone history-masking helper; `buildEpistemicPrompt` formats retrieved facts; `_sparseSimilarity` scores lexical overlap; `serialize` and `deserialize` convert graph state to/from persistence-safe data.
- `db_store.js`: `init` opens the IndexedDB store; `saveGraph`, `loadGraph`, and `deleteGraph` operate on a chat-ID key. All return promises and keep chats isolated.
- `embedding_service.js`: `embedText` requests a vector when configured and available; `cosineSimilarity` compares numeric vectors and supports retrieval ranking.
- `graph_io.js`: `importGraphJson` validates and merges user-provided graph data, returning counts and warnings; `exportGraphJson` serializes a graph to editable JSON.
- `test/verify_generation_interceptor.mjs`: evaluates the actual plugin source with SillyTavern host stubs and the real graph engine to cover generation prompt lifecycle, empty legacy history, delta receive ingestion, retrieval-based trim, stale prompt clearing, and auxiliary-generation exclusion.

## User-visible behavior

Starting with manifest version 0.3.1, users no longer need to paste the build rules into a card or worldbook for new assistant turns. To hide emitted metadata, configure SillyTavern's regex extension with Display Only; Prompt Only may also be enabled to exclude the metadata from later prompts. These flags apply to their respective processing stages while preserving the raw stored message for `MESSAGE_RECEIVED`. Avoid storage-level rules that rewrite or remove the source message.
