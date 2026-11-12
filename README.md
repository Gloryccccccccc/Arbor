# Arbor

An extensible runtime for coding agents.

Arbor 是独立开发的轻量本地编码 Agent Harness，提供 CLI 和 TypeScript SDK。当前 `0.1.0` 实现了流式模型接入、读写与精确修改、命令执行、JSONL 会话续接、显式笔记和手动上下文压缩。

## 安装与启动

需要 Node.js **22.20 或更高版本**。在仓库目录执行：

```sh
npm ci
npm run build
```

支持 Responses 和 Chat Completions 两种模型协议。使用 Responses 中转时，复制配置模板并在本机填写：

```powershell
Copy-Item .env.example .env.local
# 编辑 .env.local，填写 API Base URL、模型 ID 和自己的 Key
npm run dev:local -- --cwd "E:\项目\your-repo"
```

`.env.local` 示例（已被 Git 忽略）：

```dotenv
ARBOR_PROVIDER=responses
ARBOR_BASE_URL=https://your-provider.example/v1
ARBOR_MODEL=gpt-6.1-sol
ARBOR_API_KEY=在本机填写
```

Responses 模式发送 `POST <Base URL>/responses`，采用 `store: false`，在本地保留完整输出项与加密推理数据，以支持工具回传及会话续接。Agent 循环、工具与会话均由 Arbor 执行。协议细节见 [OpenAI 官方文档](https://developers.openai.com/api/docs/guides/function-calling)。

`npm run dev` 仅使用已有环境变量；`npm run dev:local` 会加载仓库的 `.env.local`，进程中已有环境变量优先。构建后可用 `node --env-file=.env.local dist/cli.js` 启动。凭据不作为命令行参数或会话配置保存。

| 模式 | 模型与地址 | Key |
| --- | --- | --- |
| `responses` | `ARBOR_MODEL`、`ARBOR_BASE_URL`，必填 | `ARBOR_API_KEY` |
| `compatible` | 同上，调用 Chat Completions | `ARBOR_API_KEY` |
| `bailian` | `DASHSCOPE_MODEL`，可选 `DASHSCOPE_BASE_URL`，默认北京 | `DASHSCOPE_API_KEY` |
| `deepseek`（未配置时的默认模式） | `DEEPSEEK_MODEL`、`DEEPSEEK_BASE_URL`，默认 `deepseek-flash` | `DEEPSEEK_API_KEY` |

命令行 `--provider`、`--model`、`--base-url` 优先于环境变量，通用 `ARBOR_*` 设置优先于服务商对应设置。模型 ID 按控制台填写，不自动补前缀或替换模型。

百炼使用[兼容接口](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)，支持时可用 `--thinking off` 关闭思考；省略时遵循模型默认设置，工具调用需要的 `reasoning_content` 会随会话保留。具体支持项见[百炼工具调用文档](https://help.aliyun.com/zh/model-studio/qwen-function-calling)。所有模式均可用 `--request-timeout 120 --max-output-tokens 16384` 调整单轮等待时间和输出预算。

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

数据默认保存在工作区的 `.arbor/`；通过 `--data-dir` 或 `ARBOR_DATA_DIR` 修改。会话和产物包含任务文本、代码、工具输出及模型返回的推理字段，请按本地项目资料管理。续接会话需要使用相同协议、服务商地址和模型 ID；切换模型请新建会话。

## SDK

```typescript
import { createCodingSession, ResponsesProvider } from "arbor-harness";

const session = await createCodingSession({
  cwd: "/path/to/repo",
  provider: new ResponsesProvider({
    apiKey: process.env.ARBOR_API_KEY!,
    model: process.env.ARBOR_MODEL!,
    baseUrl: process.env.ARBOR_BASE_URL!,
  }),
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

2026-11-12 在 Windows + Node.js 22.20 上完成 Responses 兼容中转的真实联调：配置模型 ID 为 `gpt-6.1-sol`，通过两轮模型请求完成 `read` 工具调用、结果回传与最终回答。其他服务商及其他操作系统仍待验证。请求失败或服务未返回用量时，Token 记录使用估算，不能视为服务商账单。
