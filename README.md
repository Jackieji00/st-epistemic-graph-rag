# st-epistemic-graph-rag

**SillyTavern 扩展｜多角色知情边界 + 百楼长期记忆（知识图谱 × 向量混合检索）**

长篇多角色 RP 的两大硬伤：NPC 全知视角泄密、几百楼后记忆崩坏。本扩展用一张带「认知边」的知识图谱同时解决。

## 核心命题

客观世界发生过的事，不等于每个角色都知道。事件被拆成原子事实，每个事实按角色各自的获知来源单独授权，未获授权的角色在检索层面完全不可见。

## 三个关键机制

| 机制 | 作用 |
| :--- | :--- |
| **原子事实 + 认知边** | 事件拆解为事实切片，以「亲历 / 目击 / 听传 / 谣言」等来源类型建立角色与事实的认知边；同一事件下不同角色的可见范围可以完全不同 |
| **发送前物理隔离** | 生成拦截器把该角色不在场的历史楼层替换为「不在场」，并从图谱子图注入其专属记忆，杜绝注意力穿透泄密 |
| **认知时间差** | 事实存在时序覆盖链；客观状态已被后续事实取代、但角色本身未获知时，仍按该角色的滞后认知渲染，并标注「认知滞后锁定」 |

## 百楼级长期记忆

- 短期窗口只保留最近若干楼原文，其余历史全部转入图谱
- IndexedDB 按 `chatId` 独立持久化，刷新或重开不丢
- 检索流程：知情白名单硬过滤 → 向量 + 关键词 + 时间衰减打分 → 1-Hop 受限子图扩散 → 认知滞后重排
- 主模型按格式输出增量建图标记即可自动落图，不额外增加请求

## 安装

放到第三方扩展目录后刷新页面：

```bash
cd SillyTavern/public/scripts/extensions/third-party/
git clone git@github.com:Jackieji00/st-epistemic-graph-rag.git
```

先点 SillyTavern 顶部的「扩展 / Extensions」按钮 → 打开 **Manage extensions** 刷新一次扩展列表，再确认 UI 里出现 `Epistemic GraphRAG Memory`。

## 怎么用（重要：本扩展默认不产生任何聊天正文）

它只做两件事：**拼一份该角色专属的记忆提示词**、**改写发给模型的历史**。所以在聊天界面上「看不到东西」是正常现象，验证请走面板。

1. 打开任意角色 / 群聊
2. 点顶栏「扩展」→ 找到 **Epistemic GraphRAG** 抽屉并展开
3. 点 **「载入测试图谱」**：写入 3 个 NPC（小王 / 小李 / 小张）+ 1 条秘密 + 1 次部分告知
4. 把「当前发言角色」切到 `手动指定`，依次填 `小王`、`小李`、`小张`
5. 点 **「预览本次注入」**，对比三者在同一提问下能召回的事实差异
6. 确认差异符合预期后，正常发消息即可，拦截器会在生成前自动注入

### 状态栏看不懂时

- `聊天ID：（未打开）` → 说明当前没有打开任何聊天，先开一个角色聊天
- `发言角色：（未识别）` → 用面板手动指定名字
- `事实：0` → 还没载图，点「载入测试图谱」

### 控制台排障

打开浏览器 F12 → Console，过滤 `EpistemicGraphRAG`：

- 有 `index.js 开始加载` 与 `设置面板已挂载` → 加载成功
- 出现 `设置面板挂载失败` → 面板容器 ID 与你的 SillyTavern 版本不符，反馈版本号
- 完全没有日志 → 脚本未执行，检查路径是否为 `third-party/st-epistemic-graph-rag/index.js`

生成时开启「控制台输出注入内容」，可直接看到本轮实际注入的提示词全文。

## 用你自己的世界（自定义）

测试图谱只是示例，真实使用有三条路径，可混用：

### A. 手动导入 JSON（最可控）

面板 → 自定义图谱导入 → 粘贴 JSON → 点「导入 JSON」。模板见 [`examples/custom-graph.example.json`](examples/custom-graph.example.json)。

```json
{
  "npcs": ["角色A", "角色B", "角色C"],
  "events": [{
    "id": "evt_1",
    "messageId": 12,
    "timestamp": "第12楼 深夜",
    "location": "地窖",
    "participants": ["角色A", "角色B"],
    "facts": [
      { "id": "f1", "content": "角色A深夜去过地窖。", "entities": ["角色A", "地窖"], "keywords": ["地窖"] },
      { "id": "f2", "content": "角色A把信物埋在东墙第三块砖后。", "entities": ["角色A", "信物", "砖墙"], "keywords": ["信物", "埋"], "isSecret": true }
    ],
    "grants": [
      { "npcId": "角色A", "factId": "f1", "sourceType": "ACTOR" },
      { "npcId": "角色A", "factId": "f2", "sourceType": "ACTOR" },
      { "npcId": "角色B", "factId": "f2", "sourceType": "WITNESS" },
      { "npcId": "角色C", "factId": "f1", "sourceType": "HEARSAY", "sourceNpc": "角色B",
        "distortedContent": "听角色B说，角色A昨晚一个人去了地窖。" }
    ]
  }]
}
```

字段要点：

| 字段 | 说明 |
| :--- | :--- |
| `messageId` | 该事件发生在聊天第几楼（数组序号，从 0 开始）；决定「不在场遮蔽」是否命中。不确定可先用估算值，遮蔽只会更保守 |
| `facts[].content` | 客观事实，一句话、具体、可检索 |
| `facts[].entities` | 参与实体；同名实体会自动做 1-Hop 关联扩散 |
| `facts[].isSecret` | 仅标记用途，真正控制可见性的是 `grants` |
| `facts[].supersedesFactId` | 本条取代哪条旧事实（物品转移、人物死亡等状态变更） |
| `grants[].sourceType` | `ACTOR` 亲历 / `WITNESS` 目击 / `HEARSAY` 听传 / `INFERRED` 推理 / `RUMOR_FALSE` 谣言 |
| `grants[].distortedContent` | 该角色实际听到的（可能是残缺或错误）版本；填了就用它替代原文 |

⚠️ 只有出现在 `grants` 里的角色 + 事实组合才可见。漏写 = 该角色完全不知道。

### B. 让主模型自动建图（长篇必需）

面板点「复制建图规则」，把内容粘到你预设的系统提示词或世界书条目里。之后模型每轮会在正文后附一个 `<ta_graph_delta>` 块（用酒馆正则设为隐藏/不显示），插件自动解析、落图、持久化 —— 不额外发请求。

告诉模型何时给人「部分告知」、何时用 `supersedesFactId`，是这套规则最关键的两个约束，规则文本里已写明。

### C. 导出 → 手改 → 再导入

先手动导入几条，点「导出到导入框」拿到当前图谱 JSON，按需增删后重新导入（合并语义，不会覆盖已有节点）。

## 目录

| 文件 | 说明 |
| :--- | :--- |
| `long_term_graph_rag.js` | 图谱引擎与混合检索引擎 |
| `index.js` | 拦截器、增量建图、设置面板 |
| `db_store.js` | IndexedDB 持久化 |
| `embedding_service.js` | 向量接口与余弦计算 |
| `test/verify_mvp_and_500floors.mjs` | 离线验证脚本 |

## 离线验证

```bash
node test/verify_mvp_and_500floors.mjs
```
