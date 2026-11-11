# 03 架构与技术选型

已选择全 TypeScript 主体方案。Python 是被迁移项目的目标语言和执行环境，不额外引入 Python 后端服务。

## 模块分工

| 模块 | 技术与职责 |
| --- | --- |
| extension | TypeScript + VS Code API；命令、侧边栏、Diff、凭据入口和任务事件展示 |
| core | TypeScript；版本快照、领域状态机、预算、知识选择、验收策略、任务持久化 |
| worker | 独立 Node 进程托管 Pi TypeScript SDK；向扩展传递带 taskId 与序号的事件，支持取消和进程退出检测 |
| tools / adapters | 受控代码读写、Python 分析辅助程序、包管理器与测试适配器；参数验证与路径检查由代码实施 |
| runner | 由宿主启动任务容器，隔离依赖安装、仓库代码和测试执行；收集结构化结果 |
| verification | 独立验证入口，依据冻结的测试、环境与补丁生成验收结论，不由模型自报完成 |

## 选择 Pi 的依据

SDK 升级需要反复阅读代码、修改文件、执行工具并处理失败。Pi 提供编码 Agent 循环、会话与事件、工具扩展和 TypeScript 接口，能复用这些基础能力。领域核心负责升级流程和最终验收；不再叠加另一个功能重复的 Agent 编排框架。扩展、core 与 worker 均可使用 TypeScript，但执行任务仍保持进程边界，避免把长任务直接耦合进编辑器入口。

## 关键依赖原则

- Pi 当前依赖要求 Node >= 22.19；发布前以锁定版本重新核对。VS Code 宿主的 Node 与用户全局安装的 Node 不能视为同一运行时。
- 固定 Pi、模型配置、工具与知识包版本；先验证可复现构建、依赖资源和运行时兼容，再承诺支持的最低 VS Code 版本。
- Pi 只获得受控工具能力；任意宿主 bash 和任意文件系统读写不作为默认权限。
- 本地插件不强制 FastAPI、MySQL、Redis 或 Milvus。未来服务端复用 core，存储适配器另行扩展。

## 参考来源

- [VS Code 扩展结构](https://code.visualstudio.com/api/get-started/extension-anatomy)
- [Pi TypeScript SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi 包与运行时要求](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json)
