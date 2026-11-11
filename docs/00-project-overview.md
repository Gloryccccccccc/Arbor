# SDKMorph 项目

面向 Python 项目的 SDK 版本管理与自动升级插件。通过版本变更知识、代码影响分析和执行反馈，帮助开发者完成从依赖升级到调用代码迁移、验证与审阅的完整任务。

当前状态：方案已确认，尚未实现 SDKMorph 插件，也没有已测得的成功率、用户量或性能数据。本文记录设计决策与后续验收标准。更新日期：2026-11-11。

## 已确认决策

- 产品入口：桌面版 VS Code 扩展；首版以单个 Python 仓库的一次 SDK 升级为单位。
- 主体实现：TypeScript 插件、TypeScript 领域核心、Pi 编码执行循环。目标项目使用 Python，与插件实现语言相互独立。
- 核心闭环：识别版本 → 检索变更证据 → 定位影响 → 建立原版本基线 → 迁移修复 → 独立验证 → 审阅补丁。
- 交付目标：Pi 作为内部依赖分发，用户配置自己的模型凭据；执行 Python 项目时需要相应运行环境，容器执行需要 Docker。
- 本地优先：无需每个用户部署服务端、MySQL 或 Milvus。团队版和多仓库服务属于后续阶段。

## 第一版完成标准

在一个明确的 SDK 源版本与目标版本之间，对一组可复现案例产生可审阅补丁。报告必须关联迁移依据、实际安装版本、代码差异、基线与目标验证结果，并能够明确报告阻塞和未验证项。首个 SDK 与版本对将在案例盘点后确定，不能直接宣称支持任意 SDK。

## 文档使用方式

产品范围以《产品范围与插件交互》为准，技术边界以《架构与技术选型》和《执行 Harness 与验证沙箱》为准，进度与发布以《开发路线与发布协作》为准。下级文档按主题独立维护。GitHub 公开仓库已创建：Gloryccccccccc/SDKMorph；本次为讨论结论写入飞书，不代表已经建立持续自动同步。

## 后续评审问题

- 首个 SDK、源版本、目标版本与案例许可。
- 支持的操作系统、最低 VS Code 版本和 Pi 的可复现打包方式。
- 版本知识包规模是否需要向量检索，以及与关键词基线相比的实测收益。

## 文档导航

- [01 项目背景与竞品定位](01-background-and-positioning.md)
- [02 产品范围与插件交互](02-product-scope.md)
- [03 架构与技术选型](03-architecture.md)
- [04 版本知识检索与迁移 Skills](04-version-knowledge-and-skills.md)
- [05 执行 Harness 与验证沙箱](05-harness-and-verification.md)
- [06 任务状态与数据存储](06-task-state-and-storage.md)
- [07 评估方案与案例集](07-evaluation.md)
- [08 开发路线与发布协作](08-roadmap-and-publishing.md)

## 代码仓库

GitHub 管理代码、Issue、PR 和版本发布；飞书维护方案与技术决策。

- [SDKMorph GitHub 仓库](https://github.com/Gloryccccccccc/SDKMorph)
