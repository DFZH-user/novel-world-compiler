# 阶段 2：Dry-run 上下文装配与 Prompt Receipt

> 日期：2026-09-10  
> 状态：确定性装配器、真实 calibration 回放与可复现产物完成；未接数据库、UI 或模型  
> 上游阶段门：`provisional-single-owner-approved`，仍非正式金标准

## 1. 本阶段完成的内容

新增旁路装配器 `src/shared/dry-run-context-assembler.ts`，只消费阶段 1 的 `ProjectionReceipt`，不自行重新判断世界真相、读者知情或角色认知。

装配流程固定为：

1. 解析并校验输入、预算与唯一 ID；
2. 先按投影结果过滤 `future_knowledge`、`unknown_to_character` 等禁止内容；
3. 对允许内容加上认知表达标签；
4. 按必选级别、预算桶、优先级、检索分和稳定 ID 排序；
5. 在预算计算前去重；
6. 分桶和总预算裁剪；
7. 输出 Prompt 预览和逐项 Prompt Receipt。

所有步骤均为确定性逻辑，模型调用为 0。

## 2. 五个预算桶

- `characterCore`：角色核心约束；
- `sceneSnapshot`：入口、已知截止点和场景边界；
- `activatedLore`：被规则激活的设定；
- `retrievedMemory`：关键词、向量、混合或图检索候选；
- `conversationMemory`：对话历史。

若任一 `must_include` 内容无法放入所属桶，装配器不会悄悄丢弃它，而是返回 `blocked_required_budget`，并取消整张 Prompt。这避免了“关键事实因预算不足而无声消失”。

## 3. 认知表达标签

阶段 1 的投影决定阶段 2 如何渲染命题：

- `world_truth` → `[角色已知]`；
- `character_belief` → `[角色信念，不代表世界真相]`；
- `uncertainty` → `[角色存疑]`；
- `counterbelief` → `[角色不相信]`；
- `withheld_secret` → `[角色知道，但不得主动透露]`；
- `excluded` → 不进入 Prompt。

这样既不会把角色误信写成世界真相，也不会把“知道但不能说”误处理成“不知道”。

## 4. Prompt Receipt 的审计范围

每张收据记录：

- 场景、入口、目标角色和已知截止段落；
- 总预算及每个预算桶的限制与使用量；
- 每个收录/排除条目的策略、原因和估算 token；
- 命题的角色投影原因与渲染方式；
- 来源段落 ID、段落序号；
- 检索方式、分数、触发器和路径；
- 最终 Prompt 文本预览；
- `actualInputTokens: null` 和 `modelCalls: 0`。

当前 token 数是用于确定性 Dry-run 的 CJK 友好估算值，不冒充真实模型 tokenizer 结果。

## 5. 真实 calibration 回放结果

生成器：`scripts/generate-calibration-dry-run.mjs`

产物：`verification-results/real-quality-review/scene-calibration-46f60d706fb1/dry-run-context-v1.json`

运行结果：

- 18 张 Prompt Receipt；
- 18 张成功装配，0 张预算阻断；
- 63 条内容进入 Prompt；
- 45 条候选被阶段 1 投影前置排除；
- 其中 11 条为 `future_knowledge`；
- 其中 34 条为 `unknown_to_character`；
- 45 条被排除内容的模拟检索分均不低于 0.99；
- 总估算输入 token 为 1998；
- 模型调用为 0。

运行指纹：

`f63a8f25f43b18b301d53e726f0bc6b26f0d5a89f702eaec85d2fed35f6d065b`

独立重建验证结果为 `valid: true`、`reproducible: true`、`formalGoldStandard: false`。

## 6. 关键行为证据

在夜战场景早期入口，命题“袭击者属于宜都蛮”的混合检索分被故意设为 `0.999`，但阶段 1 将其判定为 `future_knowledge`，因此阶段 2 仍将其排除，Prompt 预览中不存在该文本。

到 P25039 之后王扬形成推断时，同一命题才以：

`[角色信念，不代表世界真相] 袭击者属于宜都蛮`

进入 Prompt。

这验证了总体方案中的关键顺序：先做时间点与角色认知过滤，再考虑检索分数和预算，而不是先检索后靠提示词提醒模型忽略泄漏内容。

## 7. 当前没有做的事情

- 没有接入正式数据库或改动现有导出链路；
- 没有向现有知识库写入 calibration 命题；
- 没有接入关键词、向量或图数据库的真实检索服务；
- 没有使用目标模型 tokenizer；
- 没有调用模型生成回答；
- 没有做 UI 展示或人工逐张收据审核；
- 没有解除第二位评审缺失，因此仍不是正式金标准。

## 8. 阶段结论与下一步

阶段 2 的核心目标已经完成：系统能从真实场景的时间点投影确定性地组装角色安全 Prompt，并留下可复现、可追责的收据。

下一阶段建议进入阶段 3 的最小运行时接入：

1. 先接一个只读入口，不替换现有正式生成链路；
2. 从现有故事状态生成 `SceneSnapshot`；
3. 把旧知识投影经兼容桥作为候选输入；
4. 同时输出旧上下文和新 Prompt Receipt，做 shadow comparison；
5. 只有在泄漏率、关键事实覆盖率和预算阻断率达到门槛后，才考虑小范围启用模型调用。
