# 第三方源码说明

- `vendor/sillytavern`：SillyTavern 1.18.0 本地定制快照，包含小说世界阅读与移动界面的改动。许可为 AGPL-3.0，完整条文位于该目录 `LICENSE`。上游项目：https://github.com/SillyTavern/SillyTavern 。
- 第三方 JavaScript 库、字体、默认资源与 tokenizer 依其原始许可；对应声明保留在各目录或依赖包中。
- 用户的小说工程、聊天记录、密钥与个人 initial-data 不属于本次源码快照。源码首次启动使用运行时默认配置；GitHub 发布包同样不包含这些个人初始资料。

- `segmentit` 2.0.3：中文分词与词性标注，MIT；随包保留完整许可，见 `third-party-licenses/segmentit-MIT.txt`。上游：https://github.com/linonetwo/segmentit 。
- 本地摘录排序借鉴 TextRank 算法，自行用 TypeScript 实现，没有复制 TextRank4ZH 的 Python 源码。论文：https://aclanthology.org/W04-3252/ 。
