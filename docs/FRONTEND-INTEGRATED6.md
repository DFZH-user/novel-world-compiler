# integrated.6 前端改版

基于 integrated.5 工作目录的现有成果，保留编译、证据、导出、任务以及独立 SillyTavern 数据链路。无数据库结构迁移。

- 首页改为真实工程书库：半透明立体封面、搜索、列表、滚轮与方向键选书；进入编译器时封面收拢展开。首次打开旧工程后自动登记，下次可以直接选择。封面为基于书名的程序绘制排版。
- 编译器改为浅色文档工作台，导航分组；保留现有业务页面与操作。返回书库再打开同一工程时保留页面。
- 酒馆新增沉浸阅读、全页参数设置。设置直接使用原生控件与事件；支持分类和标签搜索。切换时保留聊天 DOM、草稿和滚动位置。原生布局入口保留扩展工具访问。
- 38px 简笔画鲸鱼光标；局部文字水波折射。提供开关、强度及阅读字号设置，选中文字、编辑、滚动、后台与减少动态效果时暂停水波。
- 书库索引保存在应用用户目录 project-library.json，原工程仍在原位置；不扫描或移动用户文件。酒馆仍需载入编译器导出的角色卡或世界书，不会把选中工程自动变成会话。

## 验证

- TypeScript、Vite、tsup 与 node:sqlite 构建约束检查。
- Vitest 全套：181 通过，1 跳过。
- 新增 Electron 回归：真实七工程书库、搜索与切换、编译器导航保留；酒馆双页面、原生参数入口、草稿保留、光标尺寸、水波选择暂停。
- 页面截图位于 verification-results/frontend-integrated6/。
- 使用隔离临时工程；未调用付费模型接口。

## 维护

酒馆适配入口为 public/scripts/novel-world.js 与 public/css/novel-world.css。升级上游版本时，应重新验证 drawer 节点、APP_READY 事件、原生参数保存、扩展、消息编辑和会话切换。

动效公共源为 public/world-effects.js / .css；酒馆保留相同副本 novel-world-effects.js 与 css/novel-world-effects.css。修改动效时同步两处并运行 Electron 回归。

## 实际打包验证

2026-09-13：集成包内的书库、真实 TXT 导入、编译器导航、酒馆启动、参数/阅读切换、草稿保留和动效测试全部通过（2 项 Electron 回归）。

酒馆 node_modules 使用独立 extraResources 映射，避免打包器跳过资源根目录的 node_modules。afterPack 会验证酒馆界面文件与 express、yaml、yargs、webpack 等依赖均可在包内解析。

本次输出目录为 release/integrated6；旧 integrated.5 便携版保留。
