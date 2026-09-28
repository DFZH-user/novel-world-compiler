# 可游玩整合包

状态：2.0 独立世界书导出与本地回读测试通过；下文保留 1.0 的历史实机验收记录

当前导出规范版本：`novel-world-playable-bundle` 2.0；校验器仍可读取历史 1.0 包

数据库：schema v28（无需工程数据迁移或重新调用模型）

入口：基础稿生成台的“导出可游玩整合包”与“校验已有整合包”

## 目标

把同一防剧透进入点下已经达到正式导出门槛的产物组合为一个可直接交付的目录：

1. 每名核心/重要人物一张 Character Card V2 JSON；
2. 共享世界书独立保存为 `character-book.json`，新角色卡不含 `data.character_book`；
3. 同时保留可单独导入的关系世界书和地点世界书；
4. 保存进入事件、来源指纹、文件 SHA-256 和版本清单。

## 导出门槛

导出必须同时满足：

- 统一精修没有“必须处理”项；
- 进入事件属于当前修订且已经确认；
- 所有核心/重要人物角色卡都使用同一进入事件、已经审阅并达到内容质量门槛；
- 人物关系图和叙事地图在该进入点达到各自正式导出门槛。

基础稿可生成不等于可游玩包可导出。桌面按钮和 worker 服务都会独立复核门槛。

## 2.0 人物与世界分离

2.0 的 Character Card V2 不内嵌共享世界书，也不保存共享世界书的绑定指纹。人物卡只保存本人的资料和整合包来源信息；`character-book.json` 是独立资源，由后续游玩装配流程在当前工程的会话里启用，切换书籍时不得沿用上一本书的世界书。离线导出本身尚不等于完成酒馆自动装配。

独立 `character-book.json` 的条目遵循 Character Card V2 的数组式世界书结构：

- `keys` 来自现有世界书触发词；
- `content` 保留当前进入点可见内容；
- `enabled`、`insertion_order`、`case_sensitive`、`selective`、`secondary_keys`、`constant` 和插入位置由现有世界书字段确定性转换；
- 每条 entry 的扩展保留原关系、地点、证据和事件来源 ID，并增加 `source_book`；
- 独立世界书保存自己的来源指纹，卡片只保存包指纹。

普通单卡导出保持原样；历史 1.0 整合包里的内嵌世界书不会被改写或删除。

## 角色认知边界

显式导出的整合包会在每张卡的 `data.post_history_instructions` 末尾追加一段确定性的角色认知规则，人工填写的原提示词保留在前，不修改角色卡草稿，也不改变审阅状态。规则要求：

- 固定当前进入事件与叙事段落，不把后续剧情、读者知识或其他人物知识交给当前角色；
- 区分角色已知、角色信念和角色存疑，信念/怀疑必须保留不确定措辞，已经确定的信息不能降级成猜测；
- 把共享世界书的“已证实”解释为叙事层真实性，而不是“所有角色都知道”；
- 缺少依据时以角色口吻表示不知道，不补写原著事实，不在回答里暴露内部标签和检查过程。

卡片扩展 `data.extensions.novel_world_compiler.runtime_policy` 记录 `playable-epistemic-runtime.v1`、`point-in-time-context.v1`、`epistemic-guard.v3`、`epistemic-output-gate.v1`、进入事件、段落序号和策略指纹。包指纹也覆盖完整策略内容，因此规则或版本变化会生成新的包目录。

边界说明：Character Card V2 可以让 SillyTavern 等外部宿主执行提示词约束，但不能把本项目的本地输出拦截代码带进外部宿主。因此扩展明确记录 `output_gate_enforcement: not_enforced_by_external_card`。当前导出获得的是“时间点资料 + v3 提示词约束”；`epistemic-output-gate.v1` 只有未来接入本项目自有对话运行时后，才能在发送答案前做真正的程序化阻断。

上游依据：

- Character Card V2：<https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md>
- SillyTavern World Info：<https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/worldinfo.md>

## 目录结构

```text
工程名-可游玩包-P进入段落-包指纹/
├─ manifest.json
├─ entry-point.json
├─ character-book.json
├─ characters/
│  └─ 01-人物名-身份短哈希.json
└─ worldbooks/
   ├─ relationships-world-info.json
   └─ places-world-info.json
```

`manifest.json` 记录每个受管文件的相对路径、类型、字节数和 SHA-256。清单本身不把自己的哈希写入自身，避免循环定义。

## 版本与幂等

包指纹覆盖：

- 当前工程、revision 和进入事件；
- 每张角色卡的实际 JSON 内容，而不只依赖事实来源摘要；
- 关系图、叙事地图和嵌入世界书来源指纹；
- schema 与整合包规范版本。

输出目录包含包指纹前 12 位。相同输入再次导出时逐文件比对确定性序列化内容，完全一致则直接复用；角色卡人工内容、进入点或已确认世界数据变化后生成新目录，旧版本保留。修复不一致文件时只替换该指纹目录内的受管路径，不删除未知文件。

## 只读校验与回读

校验器只读取用户选择的包目录，不修复、不覆盖、不导入任何文件。检查范围包括：

- `manifest.json` 格式、规范版本、schema、文件类型和数量；
- 每个受管文件的实际字节数与 SHA-256；
- 重复路径、反斜杠、非规范路径、`..` 越界，以及真实路径/符号链接越出包目录；
- Character Card V2 必填字段；1.0 要求内嵌 book，2.0 则拒绝角色卡内嵌共享 book；
- 独立 character book、关系世界书、地点世界书和进入点 JSON 契约；
- 历史 1.0 卡片内嵌 book 与独立 book 一致性；2.0 独立 book 的条目数、工程/revision/事件和各来源指纹的跨文件一致性；
- 当前打开工程是否与包来源一致。来源不一致只提示，不把一个结构完整的历史包误判为损坏。

当前兼容档标记为 `SillyTavern 1.18 / Character Card V2`。它与本机 SillyTavern 1.18.0 的内置 `TavernCardValidator` 和 `convertCharacterBook` 消费字段对齐；兼容档不是对未来 SillyTavern 版本的永久保证。

## 历史 1.0 验收记录

- 集成测试覆盖未审阅拒绝、V2 `character_book` 绑定、关系/地点条目合并、逐文件清单、相同输入复用、人工修改生成新版本、正常回读、文件篡改和路径越界拒绝；
- TypeScript、102 项 Vitest、Vite 与 Electron main/preload/worker 构建、`node:sqlite` 产物断言通过；
- Electron 冒烟验证公开 API 和未满足门槛时按钮禁用；
- 375 章、30,818 段真实长篇在生产 Electron 中从页面导出 2 张嵌入式角色卡、3 条世界书条目和 6 个受管资产；桌面回读 6/6 文件通过，第二次导出复用同一包；
- 使用 SillyTavern 1.18.0 的真实服务器和 /api/characters/import，在独立临时 data root 中上传导出的王扬 JSON 卡；角色落盘并由角色列表 API 回读，3/3 个内嵌世界书条目完整保留。临时 data root 和进程均已清理，用户酒馆数据未改动。

## PNG 回环与版本边界

独立兼容探针在 SillyTavern 1.18.0 真实路由中完成 V2 JSON 导入、内部 PNG 回读、JSON/PNG 导出、PNG 再导入和 JSON 再导出。除酒馆明确把私有 fav 归零外，人物 data、未知顶层字段、未知扩展、内嵌 character_book、book/entry 扩展以及进入点与来源指纹均完整保留。

SillyTavern 1.18.0 写 PNG 时会同时写入 V2 chara 和 V3 标签的 ccv3 文本块，读取时优先后者。因此回读和 JSON 再导出观察到 chara_card_v3 / 3.0，但内容仍是原 V2 形状，且缺少公开 V3 提案要求的 group_only_greetings。该行为只证明本次数据回环保留，不等于本项目或 SillyTavern 已按正式 V3 契约迁移这些字段。

当前格式政策：

- Character Card V2 JSON 是可游玩包唯一权威角色文件；
- PNG 暂不进入正式清单，只保留为未来的可选派生候选；
- 头像来源、授权、裁切和确定性编码完成前，不把酒馆默认头像包装成产品资产；
- Character Card V3 状态为“未验证/不支持”，不根据 ccv3 标签提前宣称兼容。

完整矩阵与证据见 docs/verification/SILLYTAVERN-CARD-ROUNDTRIP-2026-09-02.md 和 verification-results/sillytavern-character-card-roundtrip-result.json。

## 后续

JSON 包的最小可交付、格式边界和外部宿主的认知提示层已经闭环。人物 Skill A/B 与随机稳健性验证已完成实用验收；下一步若建设本项目自有对话运行时，应复用同一策略版本，并在答案发出前执行本地输出门。不会因为角色卡带有策略元数据就宣称外部宿主已经具备程序化拦截能力。
