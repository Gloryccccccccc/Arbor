# 08 开发路线与发布协作

路线按可验收产物推进，不预先承诺未经评估的工期。当前完成的是方案整理与 GitHub 公开仓库创建；仓库为 Gloryccccccccc/SDKMorph，插件代码尚未实现。VS Code 发布者身份和首个迁移案例尚未确定。

## 实施阶段

| 阶段 | 交付与验收 |
| --- | --- |
| M0：可行性 | 确定一个 SDK 版本对，验证原/目标环境；完成 Pi SDK、上下文与压缩钩子、SQLite 驱动、插件运行时、打包和容器工具的最小验证 |
| M1：插件骨架 | 命令、依赖扫描、任务事件、取消与 Diff；可生成 VSIX 并在干净环境安装 |
| M2：升级闭环 | 版本感知 RAG、影响分析、基线、受控迁移、独立验证、任务与项目记忆、受控压缩、报告与补丁接受 |
| M3：工程验证 | 预算限制、恢复、凭据与日志处理、失败案例、强制压缩及过期记忆测试、对照评估 |
| M4：对外发布 | VSIX 试用反馈、支持矩阵、Marketplace 预发布、正式发布与更新 |

## 首版技术亮点与暂缓项

重点建设版本感知 RAG、执行反馈修复、独立验收、可取消和可恢复任务，以及任务/项目记忆与受控上下文压缩。迁移经验先人工审核后复用，暂不自动推广为 Skill。单个编辑 Agent 为基线；多 Agent、Jev 路由、MCP 对外接口和跨任务经验自动学习均为按需求及实验收益引入的候选。内部领域工具足够时不强制 MCP，多 Agent 不允许并发写同一工作区。

## 发布方式与用户环境

- 先生成 VSIX 小范围安装，再发布到 VS Code Marketplace；市场发布需要发布者身份和平台检查。
- Pi 作为内部依赖交付，不要求用户先安装 Pi。最低 VS Code 版本依据实际 Node 兼容性和打包验证确定。
- 用户配置自己的模型 Key，执行 Python 迁移需要受支持的 Python 环境；容器执行需要 Docker。首次使用进行环境检测。
- 从明确的操作系统支持范围起步。平台相关依赖若需要，使用对应平台 VSIX；尚未测试的平台不声称可用。

## GitHub 与飞书分工

飞书维护背景、产品方案和技术决策；GitHub 维护代码、Issue、PR、Release 与可执行案例。建议仓库结构 apps/vscode、packages/core、packages/worker、packages/knowledge、packages/runner、fixtures、docs/adr。结构属于建议；GitHub 仓库已创建，插件代码骨架尚未实现。

协作采取人工发起同步：代码变更通过 PR 记录，关键技术决策更新飞书；稳定后可在 CI 生成文档快照与链接校验。未经定义冲突规则，不建立飞书与 GitHub 的双向自动覆盖。首次 GitHub 接入只需要目标仓库信息和浏览器授权，不在聊天中收集密码或 Token。

## 发布参考

- [VS Code 官方发布指南](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [VSIX 安装说明](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix)
