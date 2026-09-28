# 真实小说质量验收：抽样与标注准备

日期：2026-09-06。接续世界书一致性阶段。本次完成本地抽样工具与待审核样本包，**没有完成真实模型质量验收，也没有人工金标准**。

## 本次产物

- 工具：`scripts/prepare-quality-review.mjs`；核心逻辑：`scripts/lib/quality-review.ts`；隔离导入入口：`scripts/lib/prepare-quality-review-entry.ts`。
- 样本目录：`verification-results/real-quality-review/quality-review-73b4d2be9471/`。
- `dataset.json`：固定抽样底稿，包含来源修订、原文 SHA-256、规范 UTF-8 字节坐标、段落 ID、摘录及摘录哈希。不要编辑。
- `review.json`：待填写的人工标注，18 个样本、3 个候选进入点均为 pending。
- `README.md`：原文窗口和阅读说明；`preparation-result.json`：生成时的检查结果快照，不随后续人工标注自动更新。当前状态请重新运行 validate。

原文《冒姓琅琊》1–375 章经正式导入器处理，识别 375 个编号章节和 1 个正文前节点、30,818 个段落。原文件 SHA-256：`4ad9c628259d8f3772ea33c1cec9ada56ce44909df6ff58df7cd053abb3439bb`。导入前、导入副本、导入后哈希相同；54 段摘录逐一与规范原文的字节坐标匹配。只创建并清理本次临时工程，不打开真实小说工程、不读取密钥、不调用模型。

## 为什么这样抽样

1. 以全书段落顺序分为前、中、后三层，每层默认 6 个窗口；约 4 个锚点来自“王扬”字面命中，另外 2 个由剩余候选中伪随机选择。对照也可能包含人物名字，不是负例标签。
2. 默认上下文为锚点前后各 1 段。来源哈希、种子和段落顺序决定抽样结果，不依赖模型预测；修改种子会产生新的数据集。
3. 名字字面匹配不是身份消歧；三层是段落比例而非章节数量。少于 10 个字符的段落不作锚点，但可出现在上下文中；稀少层如实报告不足，不补造样本。
4. 窗口允许重叠，本轮样本小且偏向核心人物，不适合直接推断全书准确率。短窗口不足以判断时必须记录 unknown，并回到原文补看上下文；若需要额外结构化证据，应新建扩展数据集版本，不能改写现有底稿。

三个机械候选位置是 P3082（第47章）、P15409（第214章）、P27737（第347章），不是已确认剧情事件。人工需结合原文判断是否适合场景入口，之后再映射到正式工程的已审核事件。

## 如何填写标注

先审核候选进入点，然后逐窗口核对身份/别名、事实、对白归属、人物关系和地点。每项断言使用独立 ID、逐字证据；不要只标注正确命中，也记录可能遗漏、误认或不可使用的信息。无可标注断言的窗口应保留并写明原因。`minutes` 是人工审核耗时，未知时保留 null。

下面仅说明一个断言对象的字段，**是虚构格式示例，不是这部小说的事实**。实际 `evidence` 必须使用本窗口里的真实段落 ID 和逐字引文；`decisions` 要填满当前数据集全部进入点，不能只填一项。

```json
{
  "id": "claim-unique-001",
  "kind": "fact",
  "statement": "示例人物听到了城门关闭的公告",
  "truthStatus": "asserted",
  "visibility": "public",
  "knownBy": ["示例人物"],
  "evidence": [{ "paragraphId": "从本窗口复制实际 ID", "exactQuote": "从该段复制逐字引文" }],
  "decisions": [{
    "checkpointId": "从候选位置复制实际 ID",
    "decision": "unknown",
    "subjectKnowledge": "unknown",
    "reason": "尚未核对人物在这一时点是否听到公告"
  }]
}
```

- `kind`：identity / fact / quote / relationship / place。
- `truthStatus`：asserted / suspected / disputed / false / unknown / rumor。审核过的传闻仍是 rumor，不会变成 asserted。
- `visibility`：public / private / secret / unknown；`knownBy` 只列有依据的人物。
- 每个进入点分别填写 `decision`：allow / forbid / unknown，以及 `subjectKnowledge`：known / not-known / unknown。全书知情名单不能替代“这个时点已知情”。原因应说明证据是否足够、知情依据及不确定性。
- 当前 allow 专指可作为公开且已证实事实使用；并非完整的人物记忆授权。private 或 rumor 可以标注，但不能据此通过当前公开事实基线。未来如要允许“人物知道某个秘密”或“人物听到但未相信传闻”，需要单独扩展策略版本，不能混用 allow 的含义。
- `audience` 默认 character；此时 allow 必须显式确认目标人物当时知情。reader 仅取消人物知情要求，不取消原文证据、进入点、公开/已证实限制。
- 将样本或进入点改为 reviewed 时必须填写 `reviewer`。该字段是人工记录，不是身份认证；脚本不会验证审核人的身份或判断其语义结论正确。

## 运行方法

在仓库根目录，使用支持 `node:sqlite` 的 Node 与已安装项目依赖：

```powershell
node scripts/prepare-quality-review.mjs --source 'D:\小说\冒姓琅琊(1-375章).txt' --output verification-results/real-quality-review --subject 王扬
node scripts/prepare-quality-review.mjs --validate verification-results/real-quality-review/quality-review-73b4d2be9471
```

可选参数：`--seed`、`--encoding`（默认 utf8）、`--per-stratum`（2–12）、`--radius`（0–2）。默认种子 quality-review-v1。相同参数重复生成遇到已有目录会拒绝覆盖，保护人工标注；验证现有包应使用第二条只读命令。

校验错误返回非零退出码；结构有效但仍 pending 时退出码为 0，`readyForManualScoring` 为 false。所有审核齐全且至少有一个断言后，该字段才可能为 true；它仅表示可以进入人工评分准备，不代表语义正确、覆盖充分或模型通过验收。`score` 始终为 null，当前工具没有模型预测、评分器或通过率。

哈希只能发现与保存指纹不一致的改动，不是数字签名；一致重写数据和指纹不在其保证范围内。样本包含本地小说摘录，未上传或发布，分享前应确认作品使用权限。

## 验证与下一步

新增 10 项测试覆盖：固定种子复现、三层与对照抽样、少量/无名字候选、原始底稿改动、引文伪造、越界允许信息、读者与人物知情区分、逐进入点知情、缺失审核项、正式导入与 UTF-8 坐标、不覆盖现有标注，以及永不伪造评分。

全量 TypeScript 通过；Vitest 123 通过、1 跳过；Vite、tsup、SQLite 打包断言通过；隔离用户目录的 Electron 普通回归 6 通过、8 跳过，临时用户目录已清理。真实模型、酒馆专项、完整长篇流程没有在本轮运行；真实小说仅作隔离导入抽样。

2026-09-09 已完成 24 条独立助手候选及候选/人工底稿隔离校验，详见 `QUALITY-REVIEW-CANDIDATE-PROPOSAL-2026-09-09.md`。三处机械进入点均位于进行中的场景，当前保持 pending，不机械选定。

下一步由人工完成这 18 个窗口和候选进入点的语义审核，基于正式工程的已审核事件选择场景边界，再选少量高置信断言制作最小场景包。之后冻结人工基准并对照原生世界书动态激活、按需检索及可选 Skill；不要把已有确定性假模型流程验收、抽样成功或助手候选写成真实质量成绩。
