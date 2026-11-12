# Arbor

An extensible runtime for coding agents.

Arbor 是独立开发的轻量本地编码 Agent Harness，提供 CLI 和 TypeScript SDK。当前 `0.1.0` 实现了流式模型接入、读写与精确修改、命令执行、JSONL 会话续接、显式笔记和手动上下文压缩。

## 安装与启动

需要 Node.js **22.20 或更高版本**。在仓库目录执行：

```sh
npm ci
npm run build
```

通过环境变量配置自己的模型凭据。PowerShell 示例：

```powershell
$env:DEEPSEEK_API_KEY = "你的 API Key"
npm run dev -- --cwd "E:\项目\your-repo"
```

默认模型为 `deepseek-flash`，可通过 `--model` 或 `DEEPSEEK_MODEL` 修改；`--base-url` 或 `DEEPSEEK_BASE_URL` 设置服务地址。凭据通过环境变量读取，不作为命令行参数或会话配置保存。

## 使用

输入代码理解、修改或调试任务，查看流式回复和工具执行结果。默认写入、修改和命令执行需要确认。本地执行使用当前用户权限，**不是操作系统沙箱**；默认不向命令子进程传递模型 Key。

| 操作 | 用途 |
| --- | --- |
| `/help`、`/session` | 查看命令与当前会话 ID |
| `/note 保留现有接口` | 保存显式约束，后续请求和压缩后仍加载 |
| `/compact` | 压缩较早历史，保留近期完整交互与原始记录 |
| `/cancel`、Ctrl+C | 取消当前操作 |
| `/exit` | 保存并退出 |

任务运行中输入普通文本，会在工具批次结束后作为补充要求送入下一轮。

```sh
# 单次只读任务；JSON 模式将结构化事件写入 stdout
node dist/cli.js --cwd /path/to/repo -p "读取 package.json 并说明测试入口" --read-only --json

# 列出和继续会话
node dist/cli.js --cwd /path/to/repo --list
node dist/cli.js --cwd /path/to/repo --resume <session-id>
```

`--trusted` 显式允许本地写入和命令免逐次审批，适用于你信任的仓库。非交互模式没有审批处理器，未指定该选项时写入与命令会被拒绝。`--max-turns`、`--max-tool-calls`、`--max-duration` 限制执行预算。

数据默认保存在工作区的 `.arbor/`；通过 `--data-dir` 或 `ARBOR_DATA_DIR` 修改。会话和产物包含任务文本、代码及工具输出，请按本地项目资料管理。

## SDK

```typescript
import { createCodingSession, DeepSeekProvider } from "arbor-harness";

const session = await createCodingSession({
  cwd: "/path/to/repo",
  provider: new DeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY! }),
  permissions: "read-only",
});
try {
  const result = await session.prompt("读取 package.json 并说明测试入口");
  console.log(result.finalText);
} finally {
  await session.dispose();
}
```

当前包未发布到 npm，SDK 用法适用于本仓库自引用或通过本地路径安装后的环境。运行 `npm run check` 完成类型检查、测试与构建。

`fixtures/timeout` 是刻意保留错误的练习仓库，可让 Arbor 定位并修复零值超时配置。当前版本支持本地单会话写入与会话续接；Docker、分支操作、自动压缩、Skills 和 MCP 尚未实现。真实模型效果取决于配置，尚无对外性能或 Token 节省指标。

当前在 Windows + Node.js 22.20 上验证；真实模型联调和其他操作系统验证待完成。请求失败或服务未返回用量时，Token 记录使用估算，不能视为服务商账单。
