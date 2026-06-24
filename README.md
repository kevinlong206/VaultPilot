# Copilot Direct for Obsidian

Copilot Direct is a desktop-only Obsidian plugin that sends prompts from your vault directly to a local GitHub Copilot-compatible CLI command. It is intended to provide a Claudian-like in-vault chat and note-assistance workflow without routing requests through Agent Maestro.

## Features

- Sidebar chat view for Copilot conversations.
- Commands to ask Copilot about the selected text or active note.
- Commands to insert a response below the selection or replace the selection with a Copilot response.
- Configurable executable, arguments, stdin mode, working directory, timeout, and note-context behavior.

## Setup

1. Install and authenticate the GitHub Copilot CLI you want to use from your terminal.
2. Build this plugin with `npm install` and `npm run build`.
3. Copy `manifest.json`, `main.js`, and `styles.css` into `<vault>/.obsidian/plugins/copilot-direct/`.
4. Enable **Copilot Direct** in Obsidian community plugins.
5. Open the plugin settings and set the command/arguments that match your Copilot CLI.

By default, the plugin runs `copilot` and sends the composed prompt through stdin. If your CLI expects the prompt as an argument instead, disable stdin mode and put `{prompt}` in the argument list.

## Argument templates

Arguments are configured one per line. These tokens are replaced before execution:

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
