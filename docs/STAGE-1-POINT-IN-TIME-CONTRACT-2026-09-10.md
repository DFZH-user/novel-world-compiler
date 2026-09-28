# 阶段 1：时点知识内存合同原型

> 日期：2026-09-10  
> 状态：合同原型、旧投影兼容桥与真实 calibration 回执完成；未接数据库、UI、模型或运行时  
> 上游阶段门：`provisional-single-owner-approved`

## 1. 本阶段完成的内容

新增独立合同模块：

`src/shared/point-in-time-context.ts`

它没有修改现有 `StoryKnowledgeProjection`，而是在旁路中定义下一代上下文装配需要的概念边界：

- `WorldClaim`：世界中的规范命题、真值状态、有效区间和证据；
- `ReaderDisclosure`：读者何时已经看到、只得到暗示或尚未获知；
- `CharacterBelief`：指定角色何时知道、相信、怀疑、不信或未知；
- `SceneSnapshot`：场景边界、入口锚点、在场人物、地点、目标、冲突和禁止未来范围；
- `ContextAssemblyRequest`：目标角色、候选命题、必选命题和预算桶；
- `ProjectionReceipt`：逐命题记录世界、读者、角色和运行时四个维度的投影结果。

## 2. 固定语义

### 入口

第一版只接受：

`before_anchor_paragraph`

若入口锚点为 P25020，则模型最多只能使用 P25019 及以前的信息。合同要求：

- `knownThroughOrdinal = anchorOrdinal - 1`；
- `prohibitedFuture.fromOrdinal = anchorOrdinal`。

不满足时直接拒绝解析，避免不同模块对入口含义产生不同理解。

### 有效区间

所有状态区间统一使用：

- `fromOrdinal`：包含；
- `toOrdinalExclusive`：不包含；
- `null`：尚未结束。

同一角色对同一命题的认知区间不能重叠；同一命题的读者公开区间也不能重叠。

### 未来证据

- 角色认知证据不能晚于认知获得时点；
- 读者公开证据不能晚于公开生效时点；
- 入口之后才形成的角色认知返回 `future_knowledge`，不能倒灌到更早入口。

世界事实可以在更早时点已经客观成立、但到后来才被证实，因此世界命题证据没有被错误等同为角色知情证据。

## 3. 运行时决策

第一版运行时策略只有三类：

- `must_include`：场景必需且目标角色当时拥有该认知；
- `eligible`：允许进入，后续由装配器按相关性和预算决定；
- `must_exclude`：未知、未来或不相关。

同时保留表达方式：

- `world_truth`：角色明确知道；
- `character_belief`：只能以角色信念表述；
- `uncertainty`：角色仍在怀疑；
- `counterbelief`：角色不相信该命题；
- `withheld_secret`：模型可以知道以指导行为，但角色不能向对话对象泄露；
- `excluded`：不得进入角色上下文。

因此，“角色知道但不能说”不会被错误处理成“角色不知道”。

## 4. 已覆盖的 calibration 情况

专项测试使用两个真实场景的关键结构作为内存夹具：

1. **装晕**：世界状态为假，但埋伏者相信王扬已经昏迷；运行时只能按埋伏者信念表达。
2. **盐水机制**：读者已经看到自然解释，普通围观者仍不知道；不得因为读者知情而给角色。
3. **保密认知**：角色知道一条信息，但被禁止说出；内容可以指导行为，输出必须保持秘密。
4. **宜都蛮推断**：P25039 才形成的推断在更早入口返回 `future_knowledge`，P25040 才可以按信念进入。
5. **认知更新**：同一角色可从怀疑状态进入知道状态，旧状态到期后不再生效。
6. **不相关内容**：即使事实和认知都存在，不属于候选集合时也明确返回 `irrelevant`。
7. **确定性**：命题和认知数组顺序变化，不改变最终回执顺序。

## 5. 与现有系统的关系

现有 `StoryKnowledgeProjection` 继续负责已经上线的保守策略：

- 只使用已确认信息；
- 只使用入口之前的证据；
- 公开事实基线；
- 不把私密信息自动加入导出。

新合同不会改变其行为。后续需要单独的兼容桥，把现有公开事实映射为候选 `WorldClaim`，但不能据此自动制造 `CharacterBelief`。角色是否知情仍需明确证据或人工确认。

## 6. 当前没有做的事情

- 没有新增数据库表或迁移；
- 没有把 calibration 建议写入正式知识库；
- 没有修改 Character Card、World Info 或 Bundle 导出；
- 没有生成最终 Prompt；
- 没有运行模型；
- 没有 token 裁剪、关键词检索、向量检索或重排；
- 没有宣称正式金标准或质量分数。

## 7. 兼容桥与真实回执

只读兼容桥位于 `src/shared/legacy-context-bridge.ts`。它把现有公开事实转成候选 `WorldClaim`，但有三项保守约束：

1. 不自动创建任何 `CharacterBelief`；
2. 不自动创建任何 `ReaderDisclosure`；
3. 缺少世界有效起点时标记 `unresolved`，并输出 `unknown-world-validity` 警告，不能把首次看到证据的时间冒充世界事实生效时间。

真实 calibration 投影生成器位于 `scripts/generate-calibration-projection.mjs`。本次生成：

- 2 个真实场景；
- 7 个入口；
- 18 组入口与主体投影；
- 72 条逐命题运行时决策；
- 22 条 `must_include`；
- 5 条 `eligible`；
- 45 条 `must_exclude`；
- 其中 11 条因 `future_knowledge` 排除；
- 其中 34 条因 `unknown_to_character` 排除；
- 模型调用为 0。

回执文件：`verification-results/real-quality-review/scene-calibration-46f60d706fb1/projection-run-v1.json`。

运行指纹为 `97d3c2b366bd7b7b07e6e5f15b76353ddcef2a555bd2191e6541ce33c5b765a2`，已经通过重新计算验证。它仍明确标记 `formalGoldStandard: false`。

## 8. 阶段结论与下一步

阶段 1 的合同表达和真实 fixture 回放目标已经完成。下一阶段是阶段 2 的 Dry-run 上下文装配器：

1. 只消费投影结果，不重新解释世界真相或角色认知；
2. 按角色核心、场景快照、激活设定、检索记忆和对话记忆分预算桶；
3. 先完成确定性装配、去重与预算裁剪；
4. 输出 Prompt Receipt 和最终文本预览，但仍不调用模型；
5. 每个排除和裁剪决定都必须带原因。
