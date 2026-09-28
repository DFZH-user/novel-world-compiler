# SillyTavern 角色卡导入—导出回环验收

日期：2026-09-02

目标版本：SillyTavern 1.18.0

结论：Character Card V2 JSON 的人物数据除明确的私有 fav 规范化外，可以经过 SillyTavern 内部 PNG、PNG 导出和 PNG 再导入后完整保留；但 SillyTavern 会优先读取其写入的 `ccv3` 元数据块，使回读及再导出的 JSON 带上 `chara_card_v3 / 3.0` 标签。这个标签变化不是本项目已经验证了正式 Character Card V3 契约。

## 隔离方式

- 使用本机 SillyTavern 1.18.0 真实服务器与真实 `/api/characters/import`、`/api/characters/get`、`/api/characters/export` 路由；
- 每次验收分配随机本地端口和独立临时 `dataRoot`；
- 输入一张带未知字段、未知扩展、内嵌 `character_book`、来源 ID 和指纹的 V2 探针卡；
- 流程为 V2 JSON 导入 → 内部 PNG 回读 → JSON/PNG 导出 → PNG 再导入 → JSON 再导出；
- 测试结束关闭进程并删除临时目录，不读写用户已有角色、聊天和配置。

运行命令：`npm run test:sillytavern-roundtrip`

机器可读结果：`verification-results/sillytavern-character-card-roundtrip-result.json`

## 兼容矩阵

| 路径 | 1.18.0 实测结果 | 产品含义 |
| --- | --- | --- |
| 本项目 V2 JSON → SillyTavern 导入 | 支持 | 当前 JSON 交付格式可继续使用 |
| V2 JSON → 酒馆内部 PNG → 回读 | 除私有 fav 归零外，data 语义完整保留 | PNG 具备派生格式基础 |
| 酒馆 PNG → PNG 导出 → 再导入 | 同一规范化边界内语义完整保留 | 未发现二次导入导致的额外字段丢失 |
| 酒馆内部卡 → JSON 再导出 | 人物数据完整，但版本标签变为 V3/3.0 | 不保证输出仍是本项目的 V2 权威文件 |
| 正式 Character Card V3 提案 | 不符合：回环结果缺少必填 group_only_greetings | 当前不能宣布 V3 支持 |

## 保留与规范化边界

逐对象深比较确认保留：人物正文与提示字段、未知顶层字段、`data.extensions` 内未知扩展、数组式内嵌 `character_book`、book 和 entry 的未知扩展，以及工程、revision、进入事件、包指纹和内嵌 book 指纹。

SillyTavern 的预期规范化包括：分享导出时把 `fav` 强制设为 `false`；移除私有 `chat` 字段；导入时可能增加 `create_date` 与兼容旧界面的顶层字段；写 PNG 时同时写 `chara` 与 `ccv3` 文本块并优先读取后者。

这些变化意味着本次验收是“人物数据语义无损”，不是文件字节不变，也不是 V2/V3 可任意互换。

公开 V3 提案除版本标签外还要求 group_only_greetings 等字段；本次回环产物未补该必填字段，进一步证明不能把标签漂移视为格式升级。V3 提案原始来源：<https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md>

## 产品决策

1. `Character Card V2 JSON` 继续作为可游玩包的唯一权威角色文件；
2. 暂不把 PNG 加入正式清单。PNG 还需要头像来源、授权、裁切、确定性编码和本项目自身读写器的产品设计；
3. 暂不输出或宣称支持 Character Card V3。SillyTavern 的 `ccv3` 标签不能替代对正式 V3 模型及跨实现兼容性的验证；
4. 以后若增加 PNG，应由同一 V2 JSON 派生，并始终允许回到权威 JSON 校验来源指纹。

因此本批次关闭格式决策风险，但不扩大当前交付格式。下一阶段可以开始单人物 Skill A/B 原型，角色卡与世界书仍是默认低成本基线。
