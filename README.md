# Copilot Direct for Obsidian

Copilot Direct is a desktop-only Obsidian plugin that sends prompts from your vault directly to a local GitHub Copilot-compatible CLI command. It is intended to provide a Claudian-like in-vault chat and note-assistance workflow without routing requests through Agent Maestro.

## Features

- Sidebar chat view for Copilot conversations.
- Commands to ask Copilot about the selected text or active note.
- Commands to insert a response below the selection or replace the selection with a Copilot response.
- Cross-platform auto command mode for Windows, macOS, and Linux.
- Configurable model, executable, arguments, stdin mode, working directory, timeout, and note-context behavior.

## Setup

1. Install and authenticate the GitHub Copilot CLI you want to use from your terminal.
2. Build this plugin with `npm install` and `npm run build`.
3. Copy `manifest.json`, `main.js`, and `styles.css` into `<vault>/.obsidian/plugins/copilot-direct/`.
4. Enable **Copilot Direct** in Obsidian community plugins.
5. Open the plugin settings if you want to select a model or override the Copilot command.

By default, **Command mode** is set to **Auto platform default**:

- Windows: uses the Copilot npm loader directly through Node when it can find it, avoiding `cmd.exe` prompt quoting issues.
- macOS/Linux: runs `copilot` directly from `PATH`.

Auto mode runs Copilot as:

```text
-p
{prompt}
--allow-all
--no-color
--output-format
json
```

Switch to **Custom command** only when your Copilot installation needs a different executable or wrapper.

## Argument templates

In custom command mode, arguments are configured one per line. These tokens are replaced before execution:

- `{prompt}`: the full composed prompt
- `{vault}`: the vault path
- `{file}`: the active Markdown file path, if any

Example argument list for a CLI that accepts a prompt argument:

```text
ask
{prompt}
```

Example argument list for `gh copilot suggest`:

```text
copilot
suggest
--target
shell
{prompt}
```

`gh copilot suggest` is command-oriented rather than general chat-oriented, so a dedicated Copilot chat CLI will provide a better Claudian-like experience.
