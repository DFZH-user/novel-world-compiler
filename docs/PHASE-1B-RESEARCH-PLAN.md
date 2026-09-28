# 阶段 1B—1D：人物档案研究结论与实施方案

## 目标修正

人物卡不能由模型直接对整本小说做一次总结。可靠的产物应分成四层，并且上层只能引用下层：

1. **原始主张层**：保存模型从具体段落提取出的最小事实、逐字证据、陈述者和不确定性。
2. **归一事实层**：把同义主张聚成一个事实概念，但不删除或改写原始主张。
3. **时间状态层**：保存人物属性在剧情中的生效区间和状态变化，不把前后阶段误判为矛盾。
4. **角色卡层**：按用户选择的进入时间点，从已审核事实和当时状态生成角色卡。

现有 `character_facts` 与 `character_fact_evidence` 继续承担原始主张层，不改名、不删除，保证旧项目兼容。

## 参考方法

### 长文抽取与证据

- Google LangExtract 采用分块、并行、多轮抽取，并把结果重新对齐到原文字符区间。对本项目的直接启示是：模型输出不能只保存 JSON 文本，无法对齐到原文的结果不能进入正式事实库。
- Microsoft GraphRAG 先保留 TextUnit，再从 TextUnit 提取实体、关系和 claim；claim 可以保存状态、开始时间、结束时间和来源 TextUnit。它还提供 `max_gleanings` 做补漏，但官方也提醒 claim 提示词必须针对语料调校。
- GraphRAG 默认数据流会先在每个块内抽取描述，再聚合多块描述，而不是让一个提示词一次总结全书。本项目据此把“抽取”和“归并”拆开。

### 小说人物与对白

- BookNLP 将实体聚类、共指、对白检测、说话人归属、事件和人物汇总拆成独立输出。它对整书共指采取保守策略，说明“同名即同人”或“所有代词自动归人”都不安全。
- 中文文学作品的对白归属研究通常拆为对白识别和说话人识别，并组合分类、抽取式问答、多选问答与共指。中文小说研究还显示，说话人通常在对白前的局部上下文出现，但新小说仍需要保留人工复核。
- 全局人物语言风格可帮助解决隐含说话人，但它只能作为候选排序信号，不能替代局部证据。

### 时间与状态

- TimeML 将任务拆成事件、时间表达、时间信号和事件间关系，重点处理事件锚定、先后顺序、模糊时间和持续性。
- ProPara 的核心思想是逐步追踪实体属性，而不是只存一条静态描述。本项目采用相同的数据思想，但把属性扩展为地点、身份、阵营、能力、身体状态、关系态度和知识状态。

## 完整数据流水线

### 1B-2：高召回原始主张

- 每个人物只读取已确认提及、已确认别名命中及相邻上下文。
- 目标批次调整为约 4,000—6,000 中文字符，10,000 字符仅作硬上限；较小上下文优先保证属性归属准确。
- 第 1 轮只抽取原文明示内容；第 2 轮只补漏行为推断、来源性陈述和状态变化。两轮结果分别保存，不能互相覆盖。
- 每条主张增加 `assertion_mode`：旁白断言、自述、他人陈述、传闻、主观信念、行为推断。
- 每条主张增加 `truth_status`：文本断言、存疑、被否定、存在争议、未知。它描述小说中的证据状态，不等同于模型判断的客观真相。
- 可见性、真实性、信息来源严格分离。

### 1B-3：对白与语言样本

- 先用规则抽取中文引号、书名号式引号和破折号对白范围，保留稳定段落和字符偏移。
- 先处理“某某说道”等显式说话人；再为隐式对白生成候选人物和分数。
- 候选信号依次为：局部说话标记、上下文人物、轮流对话结构、共指、已确认人物语言风格。
- 只有高置信且证据完整的归属才自动确认；其他结果进入审核列表。
- 每条对白保存说话人、可能的受话人、对白类型、归属方法和证据。语言风格只从已确认对白统计。

### 1C：事实归一、冲突与时间状态

- 先按人物、类别和规范谓词生成候选簇，再由模型判断同义、支持、矛盾或无关。
- 冲突不能直接二选一覆盖，分类为：真正矛盾、随时间变化、人物观点分歧、传闻被纠正、身份伪装、作者疑似不一致。
- 时间保存两套顺序：可靠的正文段落顺序，以及从故事内容推断的故事内时间。故事内时间不确定时只保留偏序关系。
- 状态变化采用 `before / after / unknown`，并保留触发事件和证据。角色在不同时间受伤、升级、改换阵营等应形成多段状态，而不是多条互相冲突的静态事实。

### 1D：角色卡生成

- 用户先选择进入章节、故事时间或关键事件节点。
- 只选择该时间点有效的已确认事实和状态。
- 角色卡正文由规范事实生成，世界书条目引用人物、地点、组织、规则和事件节点。
- 生成内容与原文事实分栏保存；用户允许补全的设定必须标为 `generated`，永不伪装成原著事实。

## 数据表演进

为兼容现有 schema v4，后续只新增表或做显式迁移：

- `character_fact_claim_metadata`：原始主张的陈述方式、真实性状态、陈述者和抽取轮次。
- `character_fact_clusters`：规范事实概念。
- `character_fact_cluster_members`：事实簇与原始主张的多对多映射。
- `character_fact_conflicts`：主张或事实簇之间的关系与审核状态。
- `character_state_transitions`：属性前值、后值、生效区间、触发事件和证据。
- `character_quotes`：对白原文范围、类型和章节位置。
- `character_quote_attributions`：说话人与受话人候选、方法、置信度和审核状态。
- `character_speech_profiles`：只基于已确认对白得到的分阶段语言特征。

## 审核门槛

- 正式原始主张必须至少有一条可重新对齐的支持证据。
- 自动确认的对白说话人目标精确率不低于 95%；达不到阈值的全部留待审核。
- 推断事实不得伪装成旁白明示事实。
- 时间不明确时允许未知和偏序，不强行生成具体年月日。
- 合并、拆分、冲突裁决和状态修正必须可撤销。
- 最终角色卡中的每个关键字段都能回到原始段落，生成补全除外。

## 实施顺序

1. 先实现主张元数据、较小材料批次和两轮可选补漏，并补迁移与测试。
2. 再实现对白抽取、说话人候选和人工审核。
3. 再实现事实聚类、冲突图和时间状态。
4. 最后实现按进入时间生成角色卡。

每一批都先完成数据层、自动测试和旧项目兼容，再接界面；不提前生成安装包。

## 主要资料

- Google LangExtract: https://github.com/google/langextract
- Microsoft GraphRAG dataflow: https://microsoft.github.io/graphrag/index/default_dataflow/
- Microsoft GraphRAG outputs: https://microsoft.github.io/graphrag/index/outputs/
- Microsoft GraphRAG configuration: https://microsoft.github.io/graphrag/config/yaml/
- BookNLP: https://github.com/booknlp/booknlp
- Automatic Quote Attribution in Chinese Literary Works: https://aclanthology.org/2024.sighan-1.1/
- Approaches and Challenges for Resolving Different Representations of Fictional Characters for Chinese Novels: https://aclanthology.org/2024.lrec-main.125/
- Improving Quotation Attribution with Fictional Character Embeddings: https://aclanthology.org/2024.findings-emnlp.744/
- NovelCR: https://aclanthology.org/2025.findings-acl.268/
- TimeML: https://timeml.github.io/
- ProPara: https://aclanthology.org/N18-1144/
