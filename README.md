# Arbor

A lightweight, extensible runtime for coding agents.

Arbor 是面向自定义 Agent 的轻量运行内核，提供 Python SDK 和 CLI。当前 `0.2.0` 使用 Python 实现模型流式接入、Agent Loop、文件读写与精确修改、命令执行、JSONL 会话续接、显式笔记和手动上下文压缩。

## 安装与启动

需要 **Python 3.12+** 和 [uv](https://docs.astral.sh/uv/)。在仓库目录执行：

```powershell
uv sync --locked
Copy-Item .env.example .env.local
# 在本机编辑 .env.local，填写模型 API 配置
uv run arbor
```

已有 `.env.local` 时保留原文件。配置示例：

```dotenv
ARBOR_PROVIDER=responses
ARBOR_BASE_URL=https://your-provider.example/v1
ARBOR_MODEL=gpt-6.1-sol
ARBOR_API_KEY=在本机填写
```

CLI 默认加载当前目录的 `.env.local`，也可指定 `--env-file <path>`；已有环境变量优先。配置文件、会话及产物已被 Git 忽略，Key 不作为命令行参数或会话配置保存。模型 ID 按服务商填写，不自动补前缀或替换模型。

| 模式 | 模型与地址 | Key |
| --- | --- | --- |
| `responses` | `ARBOR_MODEL`、`ARBOR_BASE_URL`，必填 | `ARBOR_API_KEY` |
| `compatible` | 同上，使用 Chat Completions | `ARBOR_API_KEY` |
| `bailian` | `DASHSCOPE_MODEL`，可选 `DASHSCOPE_BASE_URL`，默认北京 | `DASHSCOPE_API_KEY` |
| `deepseek`（未配置时默认） | `DEEPSEEK_MODEL`、`DEEPSEEK_BASE_URL`，默认 `deepseek-flash` | `DEEPSEEK_API_KEY` |

`--provider`、`--model`、`--base-url` 优先于环境变量；通用 `ARBOR_*` 配置优先于服务商对应变量。百炼支持时可用 `--thinking off` 关闭思考，省略时遵循模型默认设置。

Responses 模式使用 `store: false`，在本地保留工具调用和加密推理输出项，用于后续回传与会话续接；Chat Completions 模式保留服务商要求的 `reasoning_content`。协议参考 [Responses 工具调用](https://developers.openai.com/api/docs/guides/function-calling)和[百炼兼容接口](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)。

## 使用

```powershell
# 在指定工作区交互使用
uv run arbor --cwd "E:\项目\your-repo"

# 单次只读任务；--json 输出结构化事件
uv run arbor --cwd "E:\项目\your-repo" -p "读取 pyproject.toml，说明测试入口" --read-only --json

# 列出和继续会话
uv run arbor --cwd "E:\项目\your-repo" --list
uv run arbor --cwd "E:\项目\your-repo" --resume <session-id>
```

| 命令 | 用途 |
| --- | --- |
| `/help`、`/session` | 查看命令与会话 ID |
| `/note 保留现有接口` | 保存显式约束，压缩后仍加载 |
| `/compact` | 压缩早期历史，保留近期完整交互及原始记录 |
| `/cancel`、Ctrl+C | 取消当前操作 |
| `/exit` | 保存并退出 |

任务运行中输入普通文本，会在安全边界作为补充要求加入下一轮。默认写入、修改和命令执行需要确认；非交互模式无审批处理器，默认拒绝这些操作。`--trusted` 允许免逐次审批，仅用于你信任的本地工作区。

本地命令使用当前用户权限，**不是操作系统沙箱**。文件工具检查工作区路径、保护配置文件，并要求覆盖或修改前提供文件哈希；命令子进程使用环境变量白名单，默认不继承模型 Key。

`--max-turns`、`--max-tool-calls`、`--max-duration` 限制单次任务预算，`--max-output-tokens`、`--request-timeout` 设置模型输出与等待上限。数据默认位于工作区 `.arbor/`，可用 `--data-dir` 或 `ARBOR_DATA_DIR` 修改。

JSONL 会话沿用版本 1 格式，可读取旧版会话。续接需使用相同模型、协议和服务地址；结果未知的工具调用会被标记，不自动重放。会话包含任务、代码、工具输出及推理字段，请按本地项目资料管理。

## Python SDK

```python
import asyncio
import os

from dotenv import load_dotenv
from arbor import ResponsesProvider, create_coding_session


async def main():
    load_dotenv(".env.local")
    async with ResponsesProvider(
        api_key=os.environ["ARBOR_API_KEY"],
        model=os.environ["ARBOR_MODEL"],
        base_url=os.environ["ARBOR_BASE_URL"],
    ) as provider:
        async with await create_coding_session(
            cwd="E:/项目/your-repo",
            provider=provider,
            permissions="read-only",
        ) as session:
            result = await session.prompt("读取 pyproject.toml，说明测试入口")
            print(result.final_text)


asyncio.run(main())
```

支持订阅事件、注入模型 Provider、自定义工具注册表和审批处理器。包尚未发布到 PyPI；当前通过本仓库使用或从本地路径安装。

## 开发与验证

```powershell
uv run python scripts/check.py
uv build
```

检查包含 Ruff、Mypy 和 pytest。测试覆盖流式中断、工具审批、哈希冲突、输出分页、Windows 进程取消、会话恢复及上下文压缩。`fixtures/timeout` 是刻意保留错误的 Python 练习项目，供 Agent 定位并修复零值超时配置；独立运行其中的测试预期会失败。

已完成 Responses 兼容中转的旧会话续接和真实代码修复验证：先复现失败、修改源码、重跑测试，测试文件保持不变，独立验收通过。

当前已在 Windows + Python 3.13 上验证。其他操作系统、其他服务商真实联调仍待完成。Docker、会话分支操作、自动压缩、Skills 和 MCP 尚未实现；尚无对外性能或 Token 节省指标。用量缺失时使用估算，不能视为服务商账单。
