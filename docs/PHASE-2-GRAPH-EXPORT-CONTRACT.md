# 阶段二关系图导出契约

状态：实现完成，契约版本 `character_graph.json` 1.0  
内部数据库：schema v15

## 1. 统一防剧透边界

两个导出入口都必须接收 `entryOrdinal`，并只读取 `RelationshipService.getGraphProjection(entryOrdinal)`。导出器不能自行查询全书关系后再做界面层过滤。

统一投影只包含当前进入位置已经揭示的已确认人物、关系历史和证据；活动边还必须满足有效期。未到达的结束事件、未来证据、未来推理说明，以及尚未被读者认识的信息来源人物都不得出现在成品中。测试同时覆盖早期位置隐藏、后期位置恢复和导出 JSON 字符串级泄漏检查。

## 2. `character_graph.json` 1.0

顶层固定字段：

- `format = novel-world-character-graph`
- `spec_version = 1.0`
- `schema_version`、`generated_at`
- `project`：工程、名称和活动小说版本
- `fence`：进入段落与本版本最大段落
- `nodes`、`relationships`、`evidence`、`communities`
- `extensions.novel_world_compiler.source_fingerprint`

关系数组保留已经揭示的历史断言，并使用 `active_at_entry` 区分当前有效边；方向、强度、极性、信息来源、真实性、有效区间、首次揭示、置信度、抽取方法、取代链、证据 ID 和冲突状态都不会被扁平化丢失。

社区由当前活动图上的确定性加权模块度合并生成。相同节点和关系集合不受输入顺序影响；社区 ID 来源于稳定成员集合哈希。每条社区摘要保存 `source_relationship_ids` 与 `source_evidence_ids`，因此可以从 SQLite 唯一事实源完全重建，不形成第二事实源。

`generated_at` 不参与来源指纹；同一工程版本、同一进入位置和同一事实状态可得到相同 `source_fingerprint`。落盘使用同目录临时文件加原子改名，返回整个文件的 SHA-256。

## 3. SillyTavern 世界书

世界书使用 SillyTavern 当前 `entries` 对象结构。社区条目提供人物群组概览，活动关系条目提供当前关系、方向、真实性、信息来源和有效区间。每个条目都在扩展字段中保留来源关系 ID 与证据 ID。

中文关键词设置 `caseSensitive = false`、`matchWholeWords = false`；条目默认非常驻、非递归扫描，避免把关系摘要无条件注入每轮上下文。世界书顶层扩展保存图契约版本、schema、工程、小说版本、进入位置和图来源指纹。

兼容性依据：

- SillyTavern 世界信息说明：https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/worldinfo.md
- SillyTavern 当前导入实现：本地源码 `src/endpoints/worldinfo.js`
- SillyTavern 当前字段转换：本地源码 `public/scripts/world-info.js`

## 4. 变更规则

- 新增可选字段只能进入 `extensions`，或在提升 minor 契约版本后加入。
- 删除、重命名、改变现有字段语义或枚举必须提升 major 版本。
- 内部 schema 迁移不能静默改变既有 1.x 导出的语义。
- 所有导出契约变更必须同时更新 Zod schema、服务测试和桌面 E2E。
