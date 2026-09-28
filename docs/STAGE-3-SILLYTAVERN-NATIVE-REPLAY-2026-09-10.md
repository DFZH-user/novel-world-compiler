# 阶段 3：SillyTavern 原生回放

> 日期：2026-09-10  
> 状态：全部 18 个入口与主体组合的确定性关键词 World Info Dry-run 已完成；模型 A/B 尚未开始  
> 目标客户端：本机 SillyTavern 1.18.0，独立临时 data root

## 1. 验收范围

当前只有项目负责人一人参与，因此阶段 3 采用低操作量方案：不要求第二位评审、不连接模型、不建立真实聊天，只验证最关键的客户端差异风险——SillyTavern 是否会按中文关键词实际激活我们允许的上下文，以及是否会把阶段 2 已排除的未来知识重新带入。

验收先用两个代表性入口打通链路：

1. 夜战早期入口：王扬尚未推断袭击者身份；
2. 夜战身份入口：王扬已经形成“袭击者属于宜都蛮”的推断。

两个入口共用同一命题，便于直接比较时点变化。链路稳定后已扩展到校准集全部 18 个“入口 × 主体”组合。

## 2. 实际执行链路

回放适配器 `scripts/lib/sillytavern-native-replay.ts` 把 Stage 2 收据中 `included` 条目转换为临时 Character Book：

- 每条内容使用同一个明确的中文触发词；
- `constant: false`，只允许关键词激活；
- 关闭递归，概率固定为 100%；
- 每条内容带稳定的 `NWC_ITEM` 标识；
- Stage 2 的 `excluded` 条目根本不进入临时书。

显式 E2E `tests/e2e/sillytavern-context-replay.spec.ts` 在独立临时 data root 中启动真实 SillyTavern 1.18.0，并在系统 Microsoft Edge 的隔离无头会话中调用客户端原生能力：

- `convertCharacterBook`；
- `/api/worldinfo/edit`；
- `setWorldInfoSettings`；
- `getWorldInfoPrompt(..., isDryRun=true)`；
- `/api/settings/get` 与 `/api/worldinfo/get`。

这里核对的是客户端实际生成的 `worldInfoString`，不是仅检查导出 JSON，也没有调用模型。

## 3. 回放结果

机器可读结果：

`verification-results/real-quality-review/scene-calibration-46f60d706fb1/sillytavern-native-replay-v1.json`

逐入口差异表：

`verification-results/real-quality-review/scene-calibration-46f60d706fb1/sillytavern-native-replay-diff-v1.md`

结果：

- SillyTavern 版本：1.18.0；
- 回放入口：18，全部通过；
- 预期条目 63，原生实际条目 63；
- 缺失、额外、文本差异和顺序差异均为 0；
- 45 条 Stage 2 禁入候选在对应入口的泄漏数为 0；
- 早期入口的“袭击者属于宜都蛮”和“用于火祭”均未出现，而形成推断后的入口正确出现；
- 中文关键词触发成功；
- 模型调用为 0；
- 每轮结束后临时 data root 均删除。

结果绑定 Stage 2 的 Dry-run `runId`，并对稳定内容计算 SHA-256：

`56b3ea3a26b6a78042d9a61c57cbe55f1fb1c958dc367214e566817d9ccfb82e`

全部 18 个入口连续执行两次得到相同指纹，`reproducible: true`。

## 4. 已发现并解决的客户端差异

验收发现并解决了两个客户端适配差异。

第一，最初尝试通过导入角色卡并按角色名称选择角色，但 SillyTavern 的欢迎页/用户初始化会使前端角色列表状态不适合作为稳定测试入口。最终改为：

1. 仍使用原生 `convertCharacterBook` 转换；
2. 将临时书写入隔离 World Info；
3. 作为唯一全局世界书激活；
4. 直接调用原生 World Info Dry-run。

这条路径移除了角色选择和聊天创建的无关 UI 状态，同时保留了需要验收的原生转换、中文匹配、排序、预算和 Prompt 内容生成逻辑。

第二，SillyTavern 会先按 `insertion_order` 排序，再把 `before_char` 内容逐条前插。若直接沿用阶段 2 的正序优先级，最终 Prompt 顺序会反转。回放适配器已经反向映射插入顺序，18 个入口的实际顺序全部与 Prompt Receipt 一致。

## 5. 当前结论

Stage 3 的确定性关键词基线已完成：阶段 2 的前置认知过滤可以安全跨过 Character Book → SillyTavern World Info 的客户端边界；高分未来知识不会因客户端关键词扫描而“复活”；中文触发与最终条目顺序可以稳定复现。

这不是角色扮演质量验收。尚未覆盖：

- 多条世界书同时启用时的优先级和预算竞争；
- 递归激活、选择性次关键词、正则与向量触发；
- Prompt Inspector UI 截图和真实 tokenizer 数字；
- 真实模型回答、延迟、输入/输出 token 与多轮质量。

## 6. 下一步

下一阶段进入阶段 4 的最小单角色真实 A/B：只选王扬一个角色、夜战早期与身份推断后两个时点，固定同一个模型和参数，比较现有原生基线与新上下文方案。开始付费或真实模型调用之前应再次取得项目负责人确认；负责人只需对少量匿名化回答做一次简短质量判断。
