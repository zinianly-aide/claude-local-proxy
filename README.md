# Claude Local Proxy

将 Anthropic `/v1/messages` 请求转换为 Ollama `/v1/chat/completions`，用于在本地模型上驱动 Claude Code。

## 功能

- 将 Anthropic 消息体转换为 OpenAI 兼容格式
- 支持流式 SSE 输出（Anthropic 事件格式）
- 排队控制并发（`MAX_INFLIGHT`）
- 根据提示词自动选择本地模型

## 快速开始

```bash
npm install
npm run start
```

默认监听 `http://127.0.0.1:8787`。

## 配置

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PROXY_BEARER` | Bearer 鉴权 token | `local` |
| `OLLAMA_TIMEOUT_MS` | 本地模型超时（毫秒） | `600000` |
| `MAX_INFLIGHT` | 并发请求上限 | `1` |

## 健康检查

`GET /health` 返回当前队列与并发状态。

## 依赖

- Node.js 18+（内置 `fetch`，但此项目使用 `node-fetch`）
- 本地运行的 Ollama（默认端口 `11434`）

## 相关工具

- `mac-control-hub/`：用于在 Termux 远程控制 Mac 的辅助服务。
