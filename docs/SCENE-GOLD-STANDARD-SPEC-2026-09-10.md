# 真实场景金标准规范（阶段 0 待审稿）

> 日期：2026-09-10  
> 上游方案：`POINT-IN-TIME-CONTEXT-ASSEMBLY-DESIGN-2026-09-10.md`  
> 状态：待审；本阶段只定义和人工标注样本，不修改数据库，不训练模型。

## 1. 阶段目标

建立一组人数不多、但证据完整且可以反复回放的真实场景，用来回答：

1. 场景边界能否可靠定位？
2. 世界真相、读者已知和角色认知能否被分别表达？
3. 在指定入口时点，哪些信息必须进入模型，哪些信息必须禁止进入？
4. 角色面对未知、谣言、误解和后来更新的事实时，应怎样回答？
5. 后续检索、上下文装配和不同适配器的差异，能否在同一套用例上复现？

阶段 0 不追求覆盖整本小说，也不追求自动标注率。它首先建立正确的判断标准。

## 2. 样本单位

金标准的最小单位不是随机段落，而是 **场景用例（scene case）**。每个用例包含：

- 一段有明确起止边界的连续原文；
- 一个发生在场景开始前、场景中或场景结束后的入口锚点；
- 一个主要受测角色；
- 必要时增加一名对照角色；
- 入口时点的世界状态、读者公开状态和角色认知状态；
- 一组应该回答、应该保留不确定、应该拒绝或不应提前知道的问题；
- 每个判断对应的原文证据。

一个场景发生多次重要认知变化时，可以从同一场景派生多个入口用例，但不得复制并悄悄改写证据。

## 3. 第一批样本规模

建议第一轮只做 **8 个场景、12–16 个入口用例**。每个场景至少由两名人工审核者独立复核。

样本应覆盖以下结构，而不是随机抽取：

| 类型 | 最低数量 | 目的 |
| --- | ---: | --- |
| 平稳人物互动 | 2 | 建立基础角色一致性基线 |
| 明确信息揭示 | 2 | 检查入口前后读者与角色知识变化 |
| 谣言或未经证实信息 | 1 | 区分“知道有传闻”和“相信传闻为真” |
| 角色误解或错误信念 | 1 | 检查错误认知能否驱动回答而不污染世界真相 |
| 秘密只向部分角色公开 | 1 | 检查同一时点不同主体的权限差异 |
| 后续纠正或状态更新 | 1 | 检查旧事实失效和新认知生效 |

第一轮优先选择证据集中、人物数量可控、转折明确的场景。现有真实质量样本中的机械入口候选多数位于场景中部，只可作为“错误入口”负例，不能直接充当金标准场景边界。

## 4. 场景选择规则

### 4.1 必选条件

- 能从原文中指出场景开始和结束的具体段落。
- 能说明边界依据，例如时间跳转、地点变化、在场人物变化、叙述焦点切换或明确章节切分。
- 至少存在一个值得验证的角色状态或知识状态。
- 关键判断能绑定原文证据，而不是依赖读者对全书的模糊印象。
- 场景长度足以保留前因后果，但不把多个独立场景合并成一个样本。

### 4.2 暂不选择

- 边界严重依赖长篇隐喻或多线并行、两名审核者都无法稳定定位的场景。
- 需要整本作品背景才能判断、而附近原文没有足够证据的场景。
- 主要依靠现实常识或模型预训练记忆才能回答的问题。
- 角色身份、版本或文本来源不明的样本。

复杂场景不是永久排除，而是放到第二轮压力测试。

## 5. 标注对象

### 5.1 场景边界

每个场景记录：

- `scene_id`：稳定的人类可读标识；
- `source_revision_id`：原文版本；
- `start_paragraph_id` / `end_paragraph_id`；
- `boundary_evidence`：为何从这里开始、到这里结束；
- `boundary_confidence`：`high | medium | low`；
- `location`、`time_hint`、`present_characters`；
- `previous_scene_dependency`：理解本场景所需的最少前置信息。

`low` 置信边界不进入第一轮正式评分，只保留为探索样本。

### 5.2 入口锚点

每个入口记录：

- `entry_id`；
- `anchor_paragraph_id`；
- `position`：`before_scene | within_scene | after_scene`；
- `entry_semantics`：模型被视为处在该段之前还是之后；
- `primary_character_id`；
- `allowed_history_end`：允许使用的最后一个原文位置；
- `forbidden_future_start`：从哪个位置起视为未来信息。

入口语义必须固定。第一版统一采用：**角色与模型只拥有锚点段落开始之前已经成立并允许获知的信息**。如果产品未来需要“段落结束后入口”，另建用例，不能混用。

### 5.3 规范命题

每条受测信息先写成与措辞无关的规范命题：

- `claim_id`；
- `subject`、`predicate`、`object/value`；
- `world_truth_status`：`true | false | disputed | unresolved`；
- `valid_from` / `valid_to`；
- `evidence_spans`；
- `supersedes_claim_id`（如为后续纠正）；
- `notes`（不进入模型的审核说明）。

不要把“某角色相信 X”写成世界事实 X。它应拆成世界命题 X 和角色对 X 的认知状态。

### 5.4 读者公开状态

对每个入口和受测命题记录：

- `reader_disclosure`：`disclosed | hinted | not_disclosed`；
- `disclosure_evidence`；
- `narrative_channel`：第一版固定为当前原文版本的普通读者；
- `first_disclosed_at`（若可确定）。

第一版暂不区分不同读者版本、付费章节或多叙述频道，但字段语义不得阻止以后扩展。

### 5.5 角色认知状态

对每个角色、入口和命题记录：

- `epistemic_state`：`known | believed | doubted | disbelieved | unknown`；
- `acquired_at`；
- `acquired_from`：人物、事件或原文证据；
- `valid_from` / `valid_to`；
- `may_disclose`：角色是否允许向当前对话对象说出；
- `confidence`：只用 `high | medium | low` 表示标注置信度，不表示角色主观概率；
- `evidence_spans`。

第一版不引入连续置信分数。无法从原文分辨 `believed` 与 `doubted` 时，必须标记待裁决，不能强行选择。

### 5.6 运行时准入标签

每个命题在指定入口下记录：

- `runtime_policy`：`must_include | eligible | must_exclude`；
- `reason`：`character_core | scene_state | relevant_memory | unknown_to_character | future_spoiler | expired | contradicted | private | irrelevant | insufficient_evidence`；
- `priority`：`critical | high | normal | low`；
- `expected_source`：确定性核心、场景快照、关键词、向量、关系扩展或不应召回。

这里标的是策略期望，不是某个适配器碰巧产生的结果。

## 6. 问题与期望行为

每个入口至少配置以下问题：

1. 一个当时明确知道的问题；
2. 一个当时尚未知晓的未来问题；
3. 一个需要区分真相与角色信念的问题；
4. 一个无原文依据的问题；
5. 一个多轮诱导或换种说法追问的问题；
6. 一个与人物语气、立场或关系有关但不要求复述事实的问题。

每个问题记录：

- `question_id`、问题文本和改写版本；
- `target_claim_ids`；
- `expected_behavior`：`answer | answer_as_belief | express_uncertainty | deny_knowledge | refuse_disclosure | stay_silent`；
- `required_points`；
- `forbidden_points`；
- `acceptable_variations`；
- `evidence_spans`；
- `severity_if_failed`：`critical | major | minor`。

不要求模型逐字复述标准答案。评分首先看是否越过知识和时点边界，其次才看表达风格。

## 7. 推荐的标注模板

```yaml
case_id: scene-001-entry-before-reveal
source_revision_id: revision-id
scene:
  start_paragraph_id: paragraph-id
  end_paragraph_id: paragraph-id
  boundary_confidence: high
  boundary_evidence:
    - evidence span id
  location: normalized place id
  present_characters:
    - character id
entry:
  anchor_paragraph_id: paragraph-id
  entry_semantics: before_anchor_paragraph
  primary_character_id: character-id
  allowed_history_end: paragraph-id
  forbidden_future_start: paragraph-id
claims:
  - claim_id: claim-001
    proposition: "规范化命题"
    world_truth_status: true
    reader_disclosure: disclosed
    character_epistemic_state: unknown
    runtime_policy: must_exclude
    policy_reason: unknown_to_character
    evidence_spans:
      - evidence span id
questions:
  - question_id: q-001
    text: "问题"
    expected_behavior: deny_knowledge
    required_points: []
    forbidden_points:
      - "不得提及入口之后的揭示"
    severity_if_failed: critical
review:
  annotator_a: pending
  annotator_b: pending
  adjudication: pending
```

正式文件可以使用 JSON，但字段语义以本规范为准。阶段 0 不把该模板直接变成数据库表。

## 8. 标注流程

### 第一步：候选选择

由一名整理者只根据原文选择完整场景，并记录选择原因。不得先看模型回答再挑对模型有利的场景。

### 第二步：独立标注

两名审核者独立标注边界、入口、命题、读者公开和角色认知。此时不得互相看到结论。

### 第三步：机械校验

检查：

- 段落 ID 与修订是否存在；
- 起止顺序是否合法；
- 所有关键判断是否有证据；
- `must_include` 是否意外指向未来；
- `must_exclude` 是否与角色明确知情冲突；
- 被更新命题的有效区间是否重叠；
- 问题的 forbidden points 是否可机器定位到命题。

### 第四步：分歧裁决

审核者比较差异，但不得用“取平均”代替裁决。分歧分为：

- 原文事实分歧；
- 场景边界分歧；
- 认知状态分歧；
- 策略优先级分歧；
- 问题表述分歧。

裁决人给出最终结论、证据和理由。无法裁决的样本标为 `ambiguous`，进入探索集，不进入正式分数。

### 第五步：盲测冻结

正式用例冻结后生成内容指纹。检索或装配逻辑开发者可以看到训练/调试子集，但最终保留一部分盲测入口，避免针对具体问题硬编码。

## 9. 数据集分区

- `calibration`：用于统一标注尺度和演示。
- `development`：用于开发投影与装配逻辑，可查看完整答案。
- `blind`：只由评测负责人掌握金标准，阶段验收时使用。
- `exploratory`：边界或解释存在合理歧义，不计正式分数。

同一场景派生的不同入口必须处于同一分区，防止未来信息从开发集泄漏到盲测集。

## 10. 回放协议

每次回放固定记录：

- 数据集版本与用例指纹；
- 项目数据修订；
- 投影和装配策略版本；
- 适配器及模型配置；
- 最终 Prompt Receipt；
- 实际输入/输出 token、延迟和错误；
- 模型原始回答；
- 人工评分、自动辅助评分和分歧。

同一个回答不能只给一个总分。至少分别记录：

- `temporal_leakage`：是否泄露未来；
- `epistemic_violation`：是否声称知道不该知道的内容；
- `truth_belief_confusion`：是否把传闻或错误信念当成真相；
- `unsupported_claim`：是否编造无依据事实；
- `required_context_recall`：必要信息是否召回；
- `character_consistency`：身份、关系、目标和表达是否一致；
- `disclosure_violation`：是否说出虽知道但不允许透露的秘密；
- `trace_completeness`：回执能否解释结果。

其中未来泄露、主体认知越界和保密泄露属于关键失败，不应被语言风格高分抵消。

## 11. 匿名化与反作弊

为区分系统确实提供了正确上下文，还是基础模型凭预训练记忆回答，第一批用例至少制作一组匿名回放版本：

- 替换角色、地点和组织名称；
- 保留人物关系和事件结构；
- 改写问题但不改变目标命题；
- 不改变证据与入口时点；
- 记录匿名映射，但不得把映射交给受测模型。

原名版和匿名版差异过大时，应单独报告，不能把原名版高分直接归因于本项目方案。

## 12. 质量门槛

阶段 0 完成必须同时满足：

- 至少 8 个完整场景和 12 个可回放入口；
- 必选场景类型全部覆盖；
- 每个正式用例经过双人独立标注和裁决；
- 所有关键标签都有原文证据；
- 正式用例中不存在未裁决的场景边界或角色认知分歧；
- 至少保留一组匿名版本和一组多轮诱导问题；
- 数据集可生成稳定指纹；
- 能明确指出哪些用例进入 calibration、development、blind 和 exploratory。

这一阶段不以模型得分作为完成条件。模型测试从数据冻结后开始。

## 13. 当前项目的直接行动建议

1. 不把现有 3 个机械入口候选直接升级为入口金标准；先向前、向后扩展成完整场景并由人工确认边界。
2. 从现有 18 个真实窗口中按本规范筛选 8 个场景，优先覆盖信息揭示、秘密和认知更新。
3. 先人工完成 2 个 calibration 场景，验证字段是否够用。
4. 字段不足时只修订本规范与样例，不立即改 schema。
5. 两个 calibration 场景达成一致后，再标注其余 development 和 blind 用例。

## 14. 下一道决策门

只有在两个 calibration 场景完成双人标注和裁决后，才起草阶段 1 的 TypeScript 合同。若这两个场景仍无法清楚区分世界真相、读者公开和角色认知，应先修改概念模型，而不是通过增加提示词补丁绕过问题。
