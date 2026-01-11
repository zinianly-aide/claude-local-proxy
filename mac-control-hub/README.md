# Mac Control Hub

从 Termux 远程控制 Mac mini 的 Node.js 服务。

## 功能

- `vscode-open` - 在 Mac 上用 VS Code 打开仓库/文件
- `run` - 在指定仓库运行白名单命令（含 gemini）
- `stream` - SSE 实时日志流
- `get` - 获取命令最终结果

---

## Claude Code 使用规则

当我说"在 Mac 上执行/打开 VS Code/调用 gemini"时：

1. 先用 `macctl` 下发命令
2. 如果返回包含 `run id`，则立即 `macctl stream <id>` 并持续读取直到 `end` 事件
3. 只在 `~/code/<repo>` 内操作，不得访问其他路径

### 常用命令

| 操作 | 命令 |
|------|------|
| 打开仓库 | `macctl vscode-open <repo>` |
| 打开文件到指定行 | `macctl vscode-open <repo> <file> <line>` |
| 运行 gemini | `macctl run <repo> gemini <args...>` |
| 实时输出 | `macctl stream <run_id>` |
| 获取结果 | `macctl get <run_id>` |

---

## Mac 端部署

```bash
cd ~/code/mac-control-hub
npm i express cors

export PORT=8787
export API_KEY="your-secret-key"
export REPO_ROOT="$HOME/code"
export ALLOW_IPS="192.168.31.0/24"  # 可选

node server.mjs
```

---

## Termux 配置

```bash
export MAC_HOST="192.168.31.10"  # Mac IP
export MAC_PORT="8787"
export MAC_KEY="your-secret-key"
```
