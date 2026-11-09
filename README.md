# st-epistemic-graph-rag

**基于知识图谱的多角色知情边界与百楼长期记忆检索扩展（SillyTavern Extension）**

解决酒馆（SillyTavern）长篇多角色扮演中的两大核心痛点：
1. **角色全知视角泄密（Epistemic Boundary Violation）**：世界里发生过的事，不代表每个 NPC 都知道；不在场的 NPC 或只听说部分传闻的 NPC 严禁未卜先知。
2. **几百楼长期记忆衰减与认知时间差（500+ Floors Long-Term Memory & Epistemic Lag）**：当聊天达到 500~2000+ 楼时，通过 **IndexedDB 图谱持久化 + 向量/实体混合检索 + 1-Hop 受限子图扩散 + 时序覆盖链**，精准召回每个角色在自身视角下的长期记忆。

---

## 核心架构

```text
[Chat Message (1 ~ 800+ 楼)]
       │
       ├──► 短期滑动窗口 (最近 16 楼)：执行【不在场角色物理遮蔽 (History Masking)】
       │
       └──► 长期记忆图谱 (IndexedDB + Vectors)：
              ├─ Event (客观事件节点：时间、地点、在场人员)
              ├─ Fact (拆解后的原子事实切片 + Embedding 向量 + 实体关联)
              ├─ SUPERSEDED_BY (时序覆盖链：处理物品转移/状态变更与角色认知滞后)
              └─ Epistemic Edge (NPC ──KNOWS[ACTOR|WITNESS|HEARSAY|RUMOR_FALSE]──► Fact)
```

### 决定成败的四大机制
- **原子事实拆解与部分告知**：同一事件拆分为多个 `Fact`（如 `F1: 小王去过仓库`、`F2: 小王把青铜钥匙藏在第三排木箱下`）。小李目击全部，但只将 `F1` 告知小张；检索小张子图时，`F2` 物理不可见。
- **发送前上下文物理隔离（In-Flight History Masking）**：在 `generate_interceptor` 中将当前发言 NPC 未在场的历史楼层替换为 `[历史隔离：该事件发生时角色不在场]`，彻底消除模型注意力穿透。
- **认知时间差（Epistemic Lag）**：第 20 楼藏钥匙于木箱（小李目击），第 180 楼小王悄悄将钥匙移至花盆（小李不在场）。第 500 楼询问小李时，因小李与第 180 楼新事实无认知边，系统保留第 20 楼事实为小李的当前有效信念并标注 `【认知滞后锁定】`。
- **受限 1-Hop 子图扩散**：向量+稀疏双路召回 Top-K 种子事实后，沿共享实体（Entity）向外扩展 1 跳关联记忆，且扩展节点强制受当前角色知情白名单约束。

---

## 目录结构

- `manifest.json`：SillyTavern 扩展清单（挂载 `epistemicGraphInterceptor` 生成拦截器）
- `long_term_graph_rag.js`：多角色知情边界图谱与百楼混合检索引擎
- `db_store.js`：IndexedDB 持久化存储层（按 `chatId` 独立分区）
- `embedding_service.js`：对接 SillyTavern `/api/vector/embed` 向量接口与余弦计算
- `index.js`：酒馆生命周期挂载、`<ta_graph_delta>` / `<graph_op>` 自动增量建图与设置面板
- `style.css`：扩展抽屉面板样式
- `test/verify_mvp_and_500floors.mjs`：离线自动化验证脚本（覆盖三角色秘密隔离、信息传递、谣言失真与 500 楼认知滞后检索）

---

## 安装与验证

### 1. 安装至 SillyTavern
将本仓库克隆至 SillyTavern 第三方扩展目录：
```bash
cd SillyTavern/public/scripts/extensions/third-party/
git clone git@github.com:Jackieji00/st-epistemic-graph-rag.git
```

### 2. 运行离线验证测试
```bash
node test/verify_mvp_and_500floors.mjs
```
