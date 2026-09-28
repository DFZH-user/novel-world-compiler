# Stage 5 前置：三组运行时对照就绪审计

> 日期：2026-09-10  
> 结论：暂不进入 Skill 或长期记忆评测；缺少真实生产 V2 角色卡基线

## 已具备

- SillyTavern 1.18.0 原生关键词 World Info 回放；
- `point-in-time-context.v1` 权限投影；
- `dry-run-context-assembler.v1` 上下文装配与回执；
- `epistemic-guard.v2` 行为层证据等级约束；
- 单角色双时点 30 次 DeepSeek A/B 暂定通过结果。

## 唯一阻断项

当前校准目录没有王扬从真实小说工程导出的、已经审核的完整 Character Card V2。Stage 4 使用的 A 是公开事实近似，只适合证明“角色认知信息是否有方向性收益”，不能回答以下问题：

- 原生 Character Card 本身已经能做到多少；
- 原生关键词 World Info 带来多少增益；
- 权限前置混合检索在 World Info 之上是否仍有独立收益。

项目中存在陆沉的历史 Skill 原型角色卡，但角色、小说和场景均不一致，不能替代王扬基线。

## 正确的下一步

从真实小说工程导出王扬已审核 V2 卡，并同时固定：

1. 当前 revision；
2. 进入事件与入口 ordinal；
3. 角色卡来源指纹；
4. 是否嵌入 `character_book`；
5. 角色卡实际进入模型的字段与 token。

随后构建三组盲测：

- A：完整 V2 Character Card；
- B：A + 原生关键词 World Info；
- C：B + 权限前置混合检索与重排。

在 C 相对 B 有稳定净收益之前，不继续开发长期记忆、人物 Skill 或多角色代理。
