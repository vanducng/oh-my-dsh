# Skills, MCP, and Plugins

[English](skills-and-mcp.md) | [简体中文](skills-and-mcp.zh-CN.md)

omdsh keeps these capabilities behind DeepSeek Harness interfaces. Skills are discovered by the Harness skill registry and filesystem provider; MCP servers are adapted into one `@deepseek-ai/dsh-mcp-client` plugin instance per server; out-of-tree plugins mount through the ordinary Harness plugin loader. The TUI does not implement any of these protocols.

## Skills

Skills are enabled by default. The filesystem provider searches these roots in priority order:

- `<project>/.dsh/skills`
- `<project>/.agents/skills`
- `$OMDSH_HOME/skills` (or `$DSH_HOME/skills`, then `~/.dsh/skills`)
- `~/.agents/skills`

A skill may be a directory containing `SKILL.md` or a flat Markdown file. For example:

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

Skills share the normal slash-command catalog, following pi/OMP's flat model. Type `/skill:` to browse and filter them with concise descriptions inline, then press Enter to invoke one. The older `/code-review` form is still accepted for compatibility but is no longer advertised. The model receives the same catalog through the Harness `skill` tool and can load a matching skill on demand.

## MCP

omdsh reads MCP configuration from:

1. `$OMDSH_HOME/mcp.json`, `$DSH_HOME/mcp.json`, or `~/.dsh/mcp.json`
2. `<project>/.dsh/mcp.json`

Project definitions override same-named user definitions. A project MCP file can start local programs, so review it before launching omdsh in an unfamiliar repository.

The document uses the common `mcpServers` shape. A stdio server:

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

A Streamable HTTP server:

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

Supported optional fields are `enabled`, `timeout` (or `toolCallTimeoutMs`), `failOnStartupError`, and the Harness `reconnect` object. Stdio entries additionally accept `cwd`; HTTP entries accept `headers`. String values support `${NAME}` and `${NAME:-default}` environment expansion, so credentials do not need to be stored directly in the JSON file. An unresolved placeholder without a default remains literal.

Discovered tools use `mcp__<server>__<tool>` names and enter the normal Harness tool registry. `/mcp` groups the connected tools by server; `/tools` shows them alongside native tools. Tool-list changes after an MCP reconnect update both views automatically. MCP resources and prompts are not bridged because the current Harness MCP client supports tools only.

## Plugins

Install published DeepSeek Harness bundles with `omdsh plugin add`. That command writes them into the omdsh Profile (`$OMDSH_HOME/profiles/omdsh`); those user bundles and the Profile `cordis.patch.yml` overlay the shipped product composition. See [`plugins.md`](plugins.md).

This fork also mounts two optional files from the omdsh namespace of the Harness home (`$OMDSH_HOME/omdsh`, or `$DSH_HOME/omdsh`, then `~/.dsh/omdsh`) after MCP:

1. `plugins.yml` — a YAML entry list of extra plugin rows. It is mounted through its own include, so bare package names resolve beside the file: install packages into `~/.dsh/omdsh/node_modules` with a normal package manager.
2. `cordis.patch.yml` — a patch list applied after the shipped composition and the MCP rows: id-targeted config overrides, disables, and insert lists, with `!!js` expressions allowed.

For example, exporting session telemetry to Langfuse with [dsh-observe](https://github.com/PerryLink/dsh-observe):

```sh
cd ~/.dsh/omdsh
npm install dsh-observe
```

```yaml
# ~/.dsh/omdsh/plugins.yml
- id: dsh-observe
  name: dsh-observe
  config:
    enabled: !!js "Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY)"
    langfuse: !!js "process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY ? { baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com', publicKey: process.env.LANGFUSE_PUBLIC_KEY, secretKey: process.env.LANGFUSE_SECRET_KEY } : null"
```

A row mounts one plugin with its config. The shipped product bundle provides the storage facility (`storage`, `storage-json`, `storage-domain`) that plugins such as dsh-observe use for durable buffers; a plugin that requires services beyond that bundle documents its own rows. Both files fail loud: a present file that cannot parse or mount aborts startup instead of silently skipping the layer.

A plugin runs with the same permissions as omdsh itself — it can read files, use credentials, and reach the network. Review the source before installing, exactly as you would for an MCP server.
