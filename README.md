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

## MCP：在局域网把 OpenCode 暴露给 Claude Code

通过 Streamable HTTP 启动一个 MCP server，Claude Code（或其他 MCP 客户端）即可在局域网内调用本机的 OpenCode 代理。

```bash
# 推荐把 key/allowed hosts 打开，避免局域网误用
OPENCODE_BASE_URL=http://127.0.0.1:8787 \
OPENCODE_BEARER=local \
OPENCODE_MCP_HOST=0.0.0.0 \
OPENCODE_MCP_PORT=8800 \
OPENCODE_MCP_KEY=your-key \
# 例如 OPENCODE_MCP_ALLOWED_HOSTS="192.168.31.10,localhost" 仅允许特定 Host 头
npm run start:mcp
```

关键环境变量：

- `OPENCODE_BASE_URL`：要代理的 OpenCode/Claude 本地接口，默认 `http://127.0.0.1:8787`
- `OPENCODE_BEARER`：转发时带上的 `Authorization: Bearer`，默认沿用 `local`
- `OPENCODE_MCP_HOST`/`OPENCODE_MCP_PORT`：MCP server 监听地址，默认 `0.0.0.0:8800`
- `OPENCODE_MCP_PATH`：MCP 路径，默认 `/mcp`
- `OPENCODE_MCP_KEY`：如果设置，客户端必须带 `x-api-key`
- `OPENCODE_MCP_ALLOWED_HOSTS`：允许的 Host 白名单（逗号分隔）；未设置且绑定 0.0.0.0 时会有风险提示

Claude Code/桌面版示例配置（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "opencode": {
      "transport": {
        "type": "http",
        "url": "http://<你的局域网IP>:8800/mcp",
        "headers": { "x-api-key": "your-key" }
      }
    }
  }
}
```

MCP 能力：

- 工具：`opencode.chat`（非流式 `/v1/messages`）、`opencode.listModels`
- 资源：`opencode://health`、`opencode://models`

## 依赖

- Node.js 18+（内置 `fetch`，但此项目使用 `node-fetch`）
- 本地运行的 Ollama（默认端口 `11434`）

## 相关工具

- `mac-control-hub/`：用于在 Termux 远程控制 Mac 的辅助服务。
