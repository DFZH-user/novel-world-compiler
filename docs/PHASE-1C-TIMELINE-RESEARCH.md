# 阶段 1C：事件时间线研究结论

## 参考结论

### 中文事件抽取

PaddleNLP UIE/PP-UIE 将事件拆成事件触发词和事件论元，并通过 schema 指定时间、地点、参与者等字段。它适合作为可选的本地模型适配器，但模型体积、Python/Paddle 运行时和部署成本不适合作为当前 Electron 桌面版的强制依赖。

本项目采用相同的结构化事件 schema，但先复用现有可替换 API 管线；未来允许用户额外安装本地 UIE 适配器。

### 小说时间线

TimeML 将事件、时间表达、时间信号和时间关系分开。叙事时间线研究也更适合把事件作为节点、时间关系作为边，而不是强迫所有事件获得具体年月日。

本项目因此同时保存：

- 原文叙述顺序；
- 原文明示的时间表达；
- 事件之间的 `before / after / simultaneous / includes / is_included / unknown` 偏序关系；
- 将来归一出的故事内时间；
- 每条关系的证据和审核状态。

倒叙、插叙和回忆不会通过修改段落顺序解决，而是用事件关系表示。

### 小说知识图谱

NOVEL2GRAPH 等项目把人物聚类、关系发现、知识图谱和可视化拆开，并保留半监督探索流程。对本项目的启示是：事件、人物、地点和关系要用稳定 ID 连接，模型提出候选，用户确认关键关系。

### 角色卡格式

Character Card V2 规定 `name`、`description`、`personality`、`scenario`、`first_mes`、`mes_example`，以及 `creator_notes`、`system_prompt`、`post_history_instructions`、`alternate_greetings`、`character_book`、`tags`、`extensions` 等字段。

其中 `creator_notes` 不能混进实际提示词；`character_book` 用于按关键词插入世界信息。人物卡生成器必须分别构造这些字段，不能把一份人物总结复制到所有字段。

## 选定实现方案

### 第一层：事件证据

逐分块提取最小事件单元，每个事件包含：

- 事件类型、标题和简述；
- 原文触发词及逐字证据；
- 参与人物及其角色；
- 地点候选；
- 原文时间表达；
- 是否为回忆、传闻、计划、假设或实际发生；
- 置信度和审核状态。

无法对齐原文的事件不进入正式事件库。

### 第二层：时间表达

本地规则先识别具体日期、时辰、节气、年龄阶段以及“次日、三年前、片刻后、当晚、后来”等相对表达，并保存段落内精确位置。

模型只负责解释这些表达与事件的关联，不负责凭空补日期。

### 第三层：事件关系图

只建立有证据或可解释规则支持的偏序边。发生冲突时保留两条候选关系并进入审核，不通过排序算法偷偷删除冲突边。

### 第四层：故事时间轴

在关系图无已确认矛盾后，进行拓扑排序，输出：

- 可以确定的事件先后；
- 同时或同一时间容器内的事件；
- 顺序仍不确定的事件组；
- 发生循环的冲突关系。

### 第五层：按进入时间生成角色卡

用户选择事件节点或章节后，只读取该节点之前已经生效、且玩家/角色在该阶段应知的事实；后期身份、秘密、伤势、能力和关系不会泄露到前期角色卡。

## 下一批实施顺序

1. schema v9：事件、参与者、地点候选、时间表达、事件证据和时间关系表。
2. 本地时间表达扫描与审核界面。
3. 可恢复的分块事件抽取任务与证据校验。
4. 事件偏序关系审核及循环检测。
5. 进入节点选择和阶段状态查询。

## 主要资料

- PaddleNLP UIE: https://github.com/PaddlePaddle/PaddleNLP/blob/develop/slm/model_zoo/uie/README.md
- PaddleNLP PP-UIE: https://github.com/PaddlePaddle/PaddleNLP/blob/develop/llm/application/information_extraction/README.md
- UIE paper/code: https://github.com/universal-ie/UIE
- TimeML: https://timeml.github.io/
- Extracting Narrative Timelines as Temporal Dependency Structures: https://aclanthology.org/P12-1010/
- NOVEL2GRAPH: https://github.com/IDSIA/novel2graph
- Character Card V2 specification: https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md
- SillyTavern character card documentation: https://docs.sillytavern.app/
