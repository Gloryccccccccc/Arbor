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

## 领域工具与 MCP 接入边界

第一版通过 Pi 注册有明确输入输出的领域工具，由工具适配器调用 core 服务。直接调用仍然保留 worker 与容器的执行边界；用户发起升级任务后，由 Harness 控制阶段、权限、预算和完成门槛，Agent 在需要判断的步骤选择工具。

| 工具示例 | 职责与约束 |
| --- | --- |
| inspect_dependencies | 识别声明约束、锁定版本和实际安装版本，无法确认时返回未知 |
| find_sdk_usages | 定位 import、方法调用和项目封装，返回位置与快照依据 |
| search_migration_docs | 按 SDK、源/目标版本、符号及错误检索迁移证据 |
| apply_migration_patch | 在受控工作区内修改代码，实施路径和允许修改范围校验 |
| run_candidate_checks | 运行候选补丁检查并返回结构化结果；最终验收由独立验证流程判定 |

直接接入路径为 Pi → 工具适配器 → core 服务 → 数据库或执行容器。MCP 接入路径为 Agent 的 MCP Client → MCP Server 适配器 → 同一 core 服务。两者共享业务逻辑与执行规则；MCP 标准化能力发现和调用通信，不替代任务编排、数据库、RAG 或权限控制。

MCP 暂不作为首版强制依赖。其他编辑器或 Agent 需要复用能力时，优先开放迁移知识检索和升级影响分析等只读接口。本地接口可采用 stdio，远程共享服务可采用 Streamable HTTP；迁移执行仍须经过相同的任务、授权和独立验证机制，不默认开放任意 shell 或数据库访问。

## 数据、检索与记忆的职责

| 能力 | 职责 |
| --- | --- |
| SQLite 与产物目录 | 保存任务、快照、事件、知识元数据、记忆与证据；大日志和补丁保存为文件并记录哈希 |
| 版本感知 RAG | 检索适用的迁移依据，供 Agent 分析和修改代码 |
| 记忆管理 | 保存任务事实、项目约定与已验证经验，并管理作用域、修订和失效 |
| 上下文构建与压缩 | 在预算内选择本轮信息，生成可追溯摘要，并从真实任务状态恢复工作 |
| 领域工具与 MCP | 提供能力的调用入口，复用 core 服务 |

数据库采用本地 SQLite；共享服务确有需求时，再评估 MySQL 业务事实与 Milvus 向量索引。记忆与压缩的专项设计见[《09 分层记忆与上下文压缩》](09-memory-and-compaction.md)。这些内容均为设计，尚未实现。

## 关键依赖原则

- Pi 当前依赖要求 Node >= 22.19；发布前以锁定版本重新核对。VS Code 宿主的 Node 与用户全局安装的 Node 不能视为同一运行时。
- 固定 Pi、模型配置、工具与知识包版本；先验证可复现构建、依赖资源和运行时兼容，再承诺支持的最低 VS Code 版本。
- Pi 只获得受控工具能力；任意宿主 bash 和任意文件系统读写不作为默认权限。
- 本地插件不强制 FastAPI、MySQL、Redis 或 Milvus。未来服务端复用 core，存储适配器另行扩展。

## 参考来源

- [VS Code 扩展结构](https://code.visualstudio.com/api/get-started/extension-anatomy)
- [Pi TypeScript SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi 包与运行时要求](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json)
- [MCP 官方架构](https://modelcontextprotocol.io/docs/learn/architecture)
