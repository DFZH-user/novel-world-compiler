# 小说世界编译器项目交接摘要

日期：2026-08-30  
实际项目目录：`D:\xiaoshuo`  
当前应用版本：`0.2.0`（后续阶段处于未发布开发态）  
当前数据库 schema：`v21`  

## 1. 项目目标

这是一个 Windows 本地桌面应用，用来把长篇 TXT 小说整理成可追溯、可人工审核、可恢复、可导出的“小说世界工程”。核心原则是：模型只生成候选，事实必须保留原文证据并经过人工审核；进入位置之前不得泄露未来内容；临时使用 GLM-5.3 不代表业务绑定某个模型，所有 OpenAI 兼容服务都通过可替换配置接入。

## 2. 已完成阶段

### 阶段 0：工程底座

- TXT 编码检测与人工确认、原始文件和规范化 UTF-8 双份保留。
- 章节识别与编辑、稳定段落 ID、边界感知分析分块 V2、SourceSpan V2 和 FTS5 trigram 全文搜索。
- `node:sqlite` 文件直连工程、WAL/完整性校验、任务恢复、在线备份/恢复、路径安全与校验和。
- API 密钥仅由主进程安全存储，不写入小说工程、日志或导出文件。

### 阶段 1：人物、事实、对白、时间线和角色卡

- 人物普查、别名/同名治理、合并拆分与撤销。
- 人物事实抽取、证据逐字对齐、真实性/信息来源/可见性分层和人工审核。
- 对白识别、说话人审核、语言画像。
- 时间表达、事件、事件偏序和进入时间人物状态。
- Character Card V2 草稿、模型润色建议逐字段审核、质量门槛和单个/批量导出。
- 阶段 1 已封版并通过完整 Electron 流程验收。

### 阶段 2：人物关系图谱（已随 0.2.0 完成）

- 关系候选、正式关系断言、证据、有效期、首次揭示位置与 truth status。
- 本地/模型候选扫描均可暂停、恢复、重试；模型不能绕过候选和正式断言两道审核闸门。
- 防剧透人物关系图、演化、冲突、路径、社区摘要。
- 版本化 `character_graph.json` 和 SillyTavern 世界书导出。

### 阶段 3/4 当前完成部分：地点知识图与叙事地图

- schema v16–v18：地点身份、别名、逐字提及、同名异地约束、合并拆分/撤销、模型地点扫描、空间关系候选和正式关系双闸门。
- 已用真实智谱 `glm-5.3-flash` 做过小样本完整验证：地点别名、身份连接、空间候选、正式关系和地图投影均通过；密钥未进入工程或结果文件。
- 统一防剧透地点投影和 Cytoscape 叙事地图已完成：包含层级、通路、方位、远近、搜索、筛选、拓扑寻径、人物叙述轨迹、证据和关系演化。
- 可导出版本化 `world_map.json` 和 SillyTavern 地点世界书。
- schema v19 新增独立 `place_geometries`：只允许地球 WGS84 Point，区分人工核对/外部地名库、三档确定性、来源名称/链接、备注和审核状态。
- 坐标只能登记到已确认地点；保存或修改会回到 pending，人工确认后才可导出；外部地名库记录确认时必须有来源名称和 HTTP(S) 链接。
- 可导出 RFC 7946 GeoJSON，只包含当前阅读位置已揭示且坐标已确认的地点；坐标顺序为 `[经度, 纬度]`，保留来源、确定性、围栏、指纹与 SHA256。
- 最近视觉验收发现并修复了地点搜索聚焦把 Cytoscape 节点移到 Canvas 外的问题；现在会在布局完成/容器变化后重新 fit，搜索定位直接以画布中心聚焦，并由 E2E 校验实际 rendered position。

## 3. 当前验证基线

- TypeScript：通过。
- Vite 前端与 Electron main/preload/worker 生产构建：通过。
- Vitest：30 个测试文件、80 项通过；1 个真实外部流程按显式开关跳过。
- 真实 `Test.novelworld` 已在临时克隆上完成 schema v13→v21 迁移验证，原工程未修改。
- Electron E2E：10 项中 7 项本地流程通过；3 项真实 API 流程按显式付费开关跳过。
- 真实桌面回归覆盖：地点审核、模型空间候选双闸门、叙事地图、`world_map.json`、地点世界书、WGS84 候选保存/确认和 `.geojson` 导出。
- 视觉截图确认：两个地点节点、`route_to` 关系线和右侧真实坐标审核卡均正常显示。

## 4. 已采用的外部案例与标准

- Recogito：地名库只给候选，人工确认后才进入地图/GeoJSON。
- Linked Places Format 与 World Historical Gazetteer：地点、名称、几何、来源、时间和不确定性分离；记录来源证明而非宣称自动结果为唯一真相。
- StoryMapJS：叙事顺序属于展示层，不等于真实道路或移动轨迹。
- CHGIS、浙大学术地图、中国文学地图和南京文学地图：真实地理、人物行迹、社会/文学关系和数字展项分层呈现。
- RFC 7946：GeoJSON 使用 WGS84，Point 顺序严格为 `[longitude, latitude]`；不确定性与来源写在 properties。
- OpenStreetMap 官方公共瓦片有署名、标识、缓存和禁止批量/离线抓取要求，不能直接硬编码成生产底图。

详细资料见：`docs/PHASE-3-NARRATIVE-MAP-RESEARCH-PLAN.md`。

## 5. 下一步建议

下一步先做“只读真实地图预览 + 可替换地图供应商配置”，再做自动地名库候选：

1. 增加地图供应商下拉和安全配置页，支持全球 WGS84 服务、国内服务和自定义 style/tile URL；供应商能力与业务逻辑分离。
2. 使用 MapLibre 的内联 GeoJSON source 展示已确认坐标；真实地图与 Cytoscape topology 继续保持两个视图，不互相覆盖事实。
3. 不硬编码 OSM 公共瓦片，不做后台预取或离线抓取；底图署名必须可见。
4. 国内服务需单独处理 WGS84/GCJ-02 等坐标语义，绝不能静默改写数据库中的 WGS84 原始事实。
5. 地名库/地理编码结果只能写入 pending 候选，继续经过人工确认；不知道就保持无坐标。
6. 地图配置页完成后再通知用户填写地图服务密钥。不要让用户把密钥发到聊天中，也不要把 GLM 模型密钥当成地图密钥。
7. 完成真实地图预览后，继续角色卡 `character_book` 绑定和可直接游玩的整合包。

## 6. 重要文件

- `src/NarrativeMapView.tsx`
- `src/styles/narrative-map.css`
- `src/shared/contracts.ts`
- `electron/worker/schema.ts`
- `electron/worker/place-service.ts`
- `electron/worker/place-map-export-service.ts`
- `electron/worker/place-geometry-service.ts`
- `tests/integration/place-geometry-geojson.test.ts`
- `tests/e2e/electron-smoke.spec.ts`
- `README.md`
- `CHANGELOG.md`

## 7. 接续任务开场要求

- 首先确认工作目录是 `D:\xiaoshuo`，不要误改当前 Codex 外壳项目 `E:\SillyTavern`。
- 先审阅本交接文件、README、CHANGELOG、阶段三计划和现有实现，再决定修改。
- 继续执行“先审核、验证完全通过，再进入下一步”的工作方式。
- 保持模型供应商可替换；当前 GLM-5.3 只是临时选择。
- 不读取、显示或记录任何明文 API 密钥。
