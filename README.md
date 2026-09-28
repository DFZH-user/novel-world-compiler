# 小说世界编译器

Windows 本地小说编辑与游玩工具。当前整理版本：**0.3.0-integrated.15**。

## 下载和使用

在 GitHub Releases 下载本版安装包，或完整解压免安装 ZIP 后运行 `win-unpacked/小说世界.exe`。单文件便携版每次启动会自解压，日常推荐安装版或一次解压版。

操作路径：**书库选书 → 编译工作台或沉浸阅读 → 选择进入事件、地点、身份和模式 → 开始游玩**。

- 编译工作台保存人物、事实、事件、地点及来源证据；支持暂停、续跑和备份恢复。
- 阅读自动装配独立世界书、精简人物资料、玩家身份与场景。
- 已确认事件可按名称或原文段落搜索进入；其他时间点从工程既有数据离线装配，保留已审核草稿。
- 阅读页左侧行动建议、中间正文与输入、右侧当前剧情，两侧可折叠及拖动。
- 人物中心关系时间线及分层示意地图；没有证据的坐标、空间关系和状态不冒充小说事实。
- 兼容 OpenAI Chat Completions 接口，密钥保存在本机系统安全存储中。

详细版本记录见 [CHANGELOG](CHANGELOG.md)，当前用法和验收范围见 [本版说明](docs/releases/本次修订使用说明.md)。

## 从源码运行

使用 Windows、Node.js 24 和 npm。依赖安装需要联网；源码仓库不保存 `node_modules`。

```powershell
npm ci
npm --prefix vendor/sillytavern ci
Copy-Item vendor/sillytavern/default/config.yaml vendor/sillytavern/config.yaml
npm run dev
```

配置复制仅用于首次准备；已有本地配置时请保留。

```powershell
npm run typecheck
npm test
npm run build
npm run dist:win
```

安装与打包可能下载 Electron 和 Windows 打包工具。内置 SillyTavern 的依赖必须先安装，打包会检查运行资源。

## 模型设置

“模型”字段填写接口的准确 **模型 ID**，区分大小写。北邮网关已知目录展示名 `DeepSeek V4 Flash` 会对应到 `deepseek-v4-flash`，其他服务商的 ID 保持原样。

输出上限与截断重试上限应服从实际服务端限制。若接口提示 `max_tokens` 允许范围为 `[1, 98304]`，两项都不得超过 98304；可以使用首次 32768、截断重试 98304。范围以你所用接口的报错或文档为准。

## 数据与验证范围

仓库包含应用源码、测试、文档和内置运行时源码。小说原文、工程数据库、API 配置、个人聊天、运行依赖和生成产物不进入源码仓库。

本版已通过类型检查、生产构建、模型请求模拟及打包态设置页测试；旧工程时间地点选择与历史保留在 integrated.14 完成离线验收。部分历史研究测试依赖未随仓库提供的本地 verification-results 或工程副本，完整测试集可能因缺少夹具而跳过或失败；不能据此宣称所有历史测试通过。没有在线模型生成验收。

## 第三方运行时

内置 SillyTavern 基础版本 1.18.0，包含本项目阅读界面扩展。其 AGPL-3.0 许可和上游版权声明随源码保留，见 [第三方说明](THIRD-PARTY-NOTICES.md) 与 `vendor/sillytavern/LICENSE`。
