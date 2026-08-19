# Skills、MCP 与插件

[English](skills-and-mcp.md) | 简体中文

omdsh 将这些能力都保留在 DeepSeek Harness 接口之后。Skills 由 Harness Skill Registry 和文件系统 Provider 发现；每个 MCP Server 会被适配为一个 `@deepseek-ai/dsh-mcp-client` 插件实例；树外插件通过普通的 Harness 插件加载器挂载。TUI 不实现这些协议。

## Skills

Skills 默认启用。文件系统 Provider 按以下优先级搜索：

- `<project>/.dsh/skills`
- `<project>/.agents/skills`
- `$OMDSH_HOME/skills`（若未设置，则依次使用 `$DSH_HOME/skills` 和 `~/.dsh/skills`）
- `~/.agents/skills`

Skill 可以是包含 `SKILL.md` 的目录，也可以是一个独立的 Markdown 文件。例如：

```text
.dsh/skills/code-review/SKILL.md
```

```markdown
---
name: code-review
description: Review a change for correctness and maintainability.
---

Review the current diff, run focused tests, and report findings by severity.
```

Skills 与普通 Slash Command 共用同一份目录，采用与 pi/OMP 相同的平铺模型。输入 `/skill:` 可以浏览和筛选 Skills，并在列表中查看简短说明；按 Enter 即可调用。旧的 `/code-review` 形式仍可兼容 Harness 的用户调用语义，但不会继续展示。模型也会通过 Harness `skill` 工具收到相同目录，并可以按需加载匹配的 Skill。

## MCP

omdsh 按以下顺序读取 MCP 配置：

1. `$OMDSH_HOME/mcp.json`、`$DSH_HOME/mcp.json` 或 `~/.dsh/mcp.json`
2. `<project>/.dsh/mcp.json`

项目级定义会覆盖同名的用户级定义。项目 MCP 文件可以启动本地程序，因此在不熟悉的仓库中运行 omdsh 前，应先检查该文件。

配置文件使用常见的 `mcpServers` 结构。以下是一个 stdio Server：

```json
{
  "mcpServers": {
    "memory": {
      "command": "mcp-server-memory",
      "args": [],
      "env": {
        "MEMORY_FILE_PATH": "/absolute/path/to/memory.jsonl"
      }
    }
  }
}
```

以下是一个 Streamable HTTP Server：

```json
{
  "mcpServers": {
    "github": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer token"
      }
    }
  }
}
```

可选字段包括 `enabled`、`timeout`（或 `toolCallTimeoutMs`）、`failOnStartupError` 以及 Harness `reconnect` 对象。stdio 配置还接受 `cwd`，HTTP 配置则接受 `headers`。字符串值支持 `${NAME}` 和 `${NAME:-default}` 环境变量展开，因此凭据不必直接写入 JSON 文件。没有默认值且无法解析的占位符会保持原样。

发现的工具使用 `mcp__<server>__<tool>` 名称，并进入普通 Harness Tool Registry。`/mcp` 按 Server 对已连接工具进行分组，`/tools` 则将它们与原生工具一起展示。MCP 重连后的工具列表变化会自动更新这两个界面。当前 Harness MCP Client 只支持工具，因此 MCP Resources 和 Prompts 尚未接入。

## 插件

Harness Home 的 omdsh 命名空间（`$OMDSH_HOME/omdsh`，若未设置则依次使用 `$DSH_HOME/omdsh` 和 `~/.dsh/omdsh`）中的两个可选文件，在出厂组合之上扩展树外 DeepSeek Harness 插件：

1. `plugins.yml` — 一份额外插件行的 YAML 条目列表。它通过独立的 include 挂载，因此裸包名会在该文件旁解析：用普通包管理器把包安装到 `~/.dsh/omdsh/node_modules` 即可。
2. `cordis.patch.yml` — 一份补丁列表，在出厂组合和 MCP 行之后应用：按 id 定向的配置覆盖、禁用与插入列表，允许 `!!js` 表达式。

例如，使用 [dsh-observe](https://github.com/PerryLink/dsh-observe) 将会话遥测导出到 Langfuse：

```sh
cd ~/.dsh/omdsh
npm install dsh-observe
```

```yaml
# ~/.dsh/omdsh/plugins.yml
- id: storage
  name: '@deepseek-ai/dsh-storage'

- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: !!js "(process.env.OMDSH_HOME || process.env.DSH_HOME || process.env.HOME + '/.dsh') + '/storages'"

- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json

- id: dsh-observe
  name: dsh-observe
  config:
    enabled: !!js "Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY)"
    langfuse: !!js "process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY ? { baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com', publicKey: process.env.LANGFUSE_PUBLIC_KEY, secretKey: process.env.LANGFUSE_SECRET_KEY } : null"
```

一行挂载一个插件及其配置；如果插件依赖额外服务（这里是持久离线缓冲所需的 storage 三件套），其自身文档会给出对应的行。这两个文件都会响亮地失败：存在但无法解析或挂载的文件会中止启动，而不是静默跳过该层。

插件与 omdsh 本身拥有相同的权限 — 它可以读取文件、使用凭据并访问网络。安装前请检查源码，就像对待 MCP Server 一样。
