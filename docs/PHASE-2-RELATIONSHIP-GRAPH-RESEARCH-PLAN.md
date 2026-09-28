# 阶段二：人物关系图谱研究与分批实施方案

状态：第一至第四批实现、验收与 0.2.0 封版已完成  
研究日期：2026-08-25  
阶段一基线：应用 0.1.3、schema v13

## 1. 结论摘要

人物关系不能建模为会被后文覆盖的单一边。阶段二采用“版本化关系断言 + 原文证据 + 有效时间 + 首次揭示位置”的本地事实模型：SQLite 是唯一事实源，图形布局、社区、摘要和导出都是可重建投影。

抽取链路分两层：

1. 候选层只回答“这两个人之间可能有值得审查的关系线索”。共现、规则和模型都只能产生候选。
2. 断言层保存方向、类型、强度、极性、信息来源、truth status、有效期、揭示位置、置信度和审核状态。断言必须引用已确认人物，并至少有一条能够对齐当前小说版本原文的支持证据。

防剧透不是 UI 过滤器，而是统一查询条件：任何面向某一进入位置的关系投影都必须同时满足 `review_status = confirmed`、`first_revealed_ordinal <= entry_ordinal`，以及有效期覆盖进入位置。未来可把同一条件收束到专门的 fence repository，供可视化、世界书和检索共同调用。

## 2. 参考方案与取舍

### Graph Every Novel

项目采用本地工作区、逐章抽取、SQLite 累计状态、稳定图筛选和独立 `character_graph.json` 导出，证明“章节抽取不等于最终图谱”、图谱投影应与内部事实存储解耦。阶段二借鉴其本地累计、关系裁决和导出契约思想，不直接移植 Python/Flet/NetworkX 技术栈，也不采用只面向全书最终稳定图的单一状态，因为本项目必须保留关系演化与进入时间视角。

来源：https://github.com/Renakoni/graph-every-novel

### StoryWeave

项目明确区分“世界客观真相”和“读者读到第 N 章时已获知的图谱”，并让节点、边和属性携带揭示章节，通过统一查询层实施防剧透。阶段二采用同样的数据库级揭示闸门，但把章号细化为可对齐的段落 ordinal，并同时保留 truth status、信息来源和有效时间，避免把“读者已知”误写成“客观为真”。

来源：https://github.com/Shashank-ssls/StoryWeave

### BookNLP

BookNLP 提供人物名称聚类、指代消解、引语说话人归因、事件和人物动作等长篇文学 NLP 能力；其文档也明确指出全书级共指仍是开放问题，并默认采用更保守的共指策略。阶段二借鉴“身份聚类与关系抽取分离”“说话人归因成为信息来源”的设计，不直接使用英文 BookNLP 模型处理中文小说。现有 `person_identities`、别名、cannot-link 和引语归因继续作为关系端点与来源门禁。

来源：https://github.com/booknlp/booknlp

### Microsoft GraphRAG

GraphRAG 的 TextUnit、实体/关系/claim 抽取、细粒度来源引用、Leiden 社区和分层社区摘要适合后续整书检索与概览。阶段二第一批只吸收“分块抽取必须可溯源”和“图投影可重建”；社区检测、嵌入和摘要推迟到第四批，不能让 GraphRAG 自动抽取结果绕过人物确认、证据对齐和人工审核。

来源：https://microsoft.github.io/graphrag/

### 中文人物关系抽取

中文人物关系研究常见路线包括规则/词句特征、远程监督、多标签分类和人工整理数据。文学文本另有别名、代词、跨段推理、关系长尾与同名异人问题，因此本项目不选择单一端到端分类器作为事实写入器。首选路线是：已确认人物与别名提供受限实体集合；局部规则、共现和对话结构产生候选；结构化 LLM 对候选做带证据抽取；人工审核决定是否进入确认图。

参考：

- 《融合结构和内容的方志文本人物关系抽取方法》：https://doi.org/10.11925/infotech.2096-3467.2021.0922
- PersonGraphDataSet / CCKS 人物关系数据说明：https://github.com/liuhuanyong/PersonGraphDataSet
- Chinese entity relation extraction（ACL Anthology）：https://aclanthology.org/P08-2023/

### 时间化知识图谱

时间知识图谱研究的基本动机是静态事实无法表达会变化的关系。阶段二不先做嵌入预测，而采用可解释的有效期断言：关系可引用开始/结束事件、开始/结束时间表达，并保留映射到叙述段落的有效 ordinal。新状态以新断言和 `supersedes_relationship_id` 连接旧状态，绝不覆盖历史行。

来源：

- IJCAI 2023 Temporal Knowledge Graph Completion survey：https://doi.org/10.24963/ijcai.2023/734
- Event-Centric Temporal Knowledge Graph Construction survey：https://doi.org/10.3390/math11234852

## 3. 数据模型底线

- 端点只允许当前 revision 中 `review_status = confirmed` 的不同人物身份。
- 同名异人依赖不同 identity id；别名不能直接成为图节点。
- 共现只写 `character_relationship_candidates`，不会自动写 `character_relationships`。
- 关系类型允许受控文本逐步演进；方向固定为 directed、undirected、reciprocal。
- strength 为 0..1，polarity 为 -1..1；两者都允许未知。
- information source 分 narrator、character、unknown；character 必须引用已确认人物。
- truth status 分 asserted、suspected、disputed、false、unknown、rumor。
- 有效期可引用事件、时间表达，并保存用于进入位置查询的 ordinal。
- `first_revealed_ordinal` 由最早的已对齐支持证据计算，不接受模型自行指定。
- pending 关系不会进入防剧透投影；rejected 保留以便审计。
- 冲突、传闻和纠正都保存为独立断言；同一人物对不设覆盖式唯一约束。

## 4. 分批实现

### 第一批：事实底座与门禁（已完成）

- schema v13 → v14 独立事务迁移，迁移成功后再更新工程清单。
- 候选、候选证据、关系断言、关系证据四类表和查询索引。
- 共享 TypeScript 领域契约。
- RelationshipService：已确认人物门禁、证据精确/归一化对齐、候选审核、关系审核、有效期校验、历史链和按进入位置查询。
- utility worker、main IPC、preload API 接口贯通，为下一批 UI 和抽取 worker 预留稳定边界。
- 集成测试覆盖 v13 数据保留、共现不升级、待确认人物拒绝、伪造证据拒绝、事务回滚、关系演化和防剧透围栏。

### 第二批：可恢复抽取与审核工作台

进度（2026-08-26）：2A 已完成 schema v15、本地关系 scan run/chunk result/job attempt、异常恢复、幂等候选来源、本地近距离共现与明确关系词句生成，以及 worker/IPC/preload 接口。2B 已完成结构化模型关系候选、断言建议持久化、相关人物/引语/事件受限上下文、DeepSeek V4 非思考 JSON 请求、token 记账、本地多重门禁，以及证据案卷式 React 审核台；支持候选确认/排除/修正、人工新建和正式断言的二次审核。

- 新增 relationship scan run / chunk result / job attempt，沿用独立 worker、租约、暂停、重试和断点恢复模式。
- 只向模型提供已确认人物、已确认别名、cannot-link 约束、引语归因、事件与 core 段落。
- DeepSeek V4 结构化请求显式使用 `thinking: { type: 'disabled' }`；输出经 Zod、identity、chunk core、证据和数值范围多重校验。
- 本地候选生成器提供共现、明确亲属/称谓/动作/对话线索，但所有共现候选默认 pending。
- React 审核台显示双端人物、关系字段、支持/矛盾证据和历史断言；支持确认、拒绝、修正与人工新建。

### 第三批：可视化与时间/防剧透交互

进度（2026-08-28）：第三批核心能力已完成。采用 Cytoscape.js 3.34.2 并保留可重复性能样本；新增统一关系图投影，关系、可见历史、证据和未到达的有效期终点由同一入口位置裁剪。React 图谱已支持时间滑块、方向/极性/强度/truth/source/冲突编码、演化轴、人物定位、同快照最短路径、置信度/度数过滤、主连通分量过滤和大图布局自动降级。完整类型检查、17 文件 45 项 Vitest、生产构建和 Electron E2E 均通过。真正的社区检测、社区摘要与可追溯社区导出仍按第四批处理，不在渲染层制造第二事实源。

- 引入 Cytoscape.js 或 Sigma.js 前先用性能样本比较；默认优先 Cytoscape.js，以利用成熟的交互、过滤与布局插件。
- 阅读位置滑块统一调用 fence query；图节点、边、详情、搜索和路径查询不得各自实现过滤逻辑。
- 展示方向、极性、强度、truth status、来源视角、冲突边和关系演化时间轴。
- 大图采用核心人物/度数/置信度过滤、社区折叠和渐进布局，避免一次渲染全量边。

### 第四批：导出、GraphRAG 增强与发布验收

进度（2026-08-28）：版本化 `character_graph.json` 1.0、当前 SillyTavern 世界书、确定性社区与可追溯摘要已经完成；两个导出共用统一防剧透投影。安全备份恢复、1/10/50 MB 回归、完整本地模拟 API 整链、生产构建、Electron E2E 和独立 Windows 解包审计版均已通过。0.1.2 三个回滚产物的大小与 SHA-256 已复核，便携目录版启动通过；其内部版本误报 0.1.1 已记录为历史注意事项。真实 DeepSeek 测试仍保持显式付费开关，不自行消耗用户额度。

- 设计可版本化 `character_graph.json` 与世界书导出契约，所有导出接受进入位置参数。
- 在已确认图上生成社区与摘要，摘要必须保存来源关系 id 和证据 id，且可以完全重建。
- 补齐本地模拟 API 整链、少量真实 DeepSeek 小请求、桌面 E2E、1/10/50MB 回归、备份恢复、安装版和便携版启动。
- 发布新版本前先重新验证 0.1.2 回退产物，并在发布记录中写明回退目标；本批不删除也不改写 0.1.2 产物。

## 5. 第一批完成标准

- v13 工程打开后 schema 变为 v14，阶段一设置和事实仍可读取。
- migration 失败时事务回滚，工程清单不提前升级。
- 未确认人物、跨 revision 证据、无法对齐原文的证据均不能写入关系层。
- 共现候选无论置信度多高都不会自动成为关系。
- 关系支持方向、类型、强度、极性、来源、truth status、事件/时间有效期、首次揭示位置、置信度与人工审核。
- 同一人物对可以保留多个相继或冲突断言。
- 进入位置查询看不到未来揭示、未确认或在该位置无效的关系。
- 类型检查、全部 Vitest 和生产构建通过；Electron 冒烟验证 preload API 存在且 renderer sandbox 未扩大。

## 6. 暂不采用

- 不把 Neo4j/专用图数据库引入阶段二内核；sql.js 已足够承担可审计事实源，图查询先通过索引和内存投影实现。
- 不用共现次数直接生成亲属、恋爱、敌对等语义边。
- 不自动合并别名或同名身份；继续沿用 must-link/cannot-link/人工审核。
- 不让最新抽取覆盖旧关系。
- 不在第一批调用真实 DeepSeek；数据底座和本地门禁不需要消耗真实 API。
