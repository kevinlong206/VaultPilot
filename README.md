# VaultPilot

VaultPilot is a desktop-only Obsidian plugin that lets you chat with a local GitHub Copilot-compatible CLI from inside your vault.

It is designed for people who want a Copilot-powered, in-vault writing and note-assistance workflow without routing prompts through Agent Maestro or a hosted bridge service.

## Features

- Sidebar chat view for Copilot conversations inside Obsidian.
- Commands for asking Copilot about the selected text or active note.
- Commands to insert a Copilot response below the current selection or replace the selection.
- Automatic command defaults for macOS, Linux, and Windows.
- Configurable model, executable, arguments, stdin behavior, shell usage, working directory, timeout, and active-note context.
- Markdown rendering for assistant responses.
- Basic model and usage metadata when the CLI returns JSON output.

## Requirements

- Obsidian 1.5.0 or newer.
- Desktop Obsidian. This plugin uses local process execution and does not run on mobile.
- Node.js and npm for building from source.
- A local GitHub Copilot-compatible CLI command installed and authenticated.

## Installation from source

Clone and build the plugin:

```sh
git clone https://github.com/kevinlong206/VaultPilot.git
cd VaultPilot
npm install
npm run build
```

Copy the plugin files into your Obsidian vault:

```sh
mkdir -p "<vault>/.obsidian/plugins/vaultpilot"
cp manifest.json main.js styles.css "<vault>/.obsidian/plugins/vaultpilot/"
```

Then open Obsidian, go to **Settings > Community plugins**, enable community plugins if needed, and enable **VaultPilot**.

## Usage

Open VaultPilot from the ribbon icon or the command palette command **Open Copilot chat**.

VaultPilot can use your current Obsidian context:

- If text is selected, the selection is treated as the primary context.
- If no text is selected, the active note can be included by default.
- The active file path is included so Copilot can understand which vault-relative file you are working in.

Available commands include:

- **Open Copilot chat**
- **Ask Copilot about selection or active note**
- **Insert Copilot response below selection**
- **Replace selection with Copilot response**

## Default command behavior

By default, VaultPilot uses **Auto platform default** command mode.

On macOS and Linux, it runs `copilot` from your `PATH`.

On Windows, it first tries to find and run the Copilot npm loader directly through Node. This avoids common `cmd.exe` quoting issues. If the loader is not found, VaultPilot falls back to `copilot.cmd`.

Auto mode sends prompts with these arguments:

```text
-p
{prompt}
--allow-all
--no-color
--output-format
json
```

The JSON output mode lets VaultPilot stream assistant text and display response metadata when available.

## Configuration

Open the VaultPilot settings tab in Obsidian to customize:

| Setting | Description |
| --- | --- |
| Command mode | Use automatic platform defaults or a custom command. |
| Copilot command | Executable to run in custom mode. Use an absolute path if Obsidian cannot find it. |
| Arguments | Custom command arguments, one per line. |
| Model | Optional model passed as `--model`; `Auto` lets Copilot choose. |
| Pass prompt through stdin | Sends the composed prompt through stdin for CLIs that support it. |
| Use shell | Runs the custom command through a shell for aliases or wrappers. |
| Run from vault folder | Uses the vault path as the command working directory. |
| Include active note by default | Sends the full active note when there is no selection. |
| Timeout | Maximum seconds to wait for the command. |

Custom arguments support these templates:

| Template | Value |
| --- | --- |
| `{prompt}` | The full composed prompt. |
| `{vault}` | The vault path. |
| `{file}` | The active Markdown file path, if any. |

Example custom argument list for a CLI that accepts a prompt argument:

```text
ask
{prompt}
```

Example custom argument list for `gh copilot suggest`:

```text
copilot
suggest
--target
shell
{prompt}
```

`gh copilot suggest` is command-oriented rather than general chat-oriented, so a dedicated Copilot chat CLI usually provides a better in-vault chat experience.

## Troubleshooting

### `spawn copilot ENOENT` on macOS

This means Obsidian could not find the `copilot` executable. macOS apps launched from Finder often do not inherit the same `PATH` as your terminal.

VaultPilot automatically adds common CLI locations such as `/opt/homebrew/bin` and `/usr/local/bin` when it runs Copilot. If the error still appears:

1. Find the executable in Terminal:

   ```sh
   which copilot
   ```

2. Open VaultPilot settings.
3. Set **Command mode** to **Custom command**.
4. Paste the full path from `which copilot` into **Copilot command**.
5. Keep the default arguments unless your CLI requires something different.

## Development

Install dependencies:

```sh
npm install
```

Start the development watcher:

```sh
npm run dev
```

Create a production build:

```sh
npm run build
```

The build writes `main.js` from `src/main.ts`. Do not edit `main.js` manually.

## Privacy note

VaultPilot sends the composed prompt to the local CLI command you configure. Depending on your settings, that prompt may include selected text, the active note, and the active file path. Review your CLI configuration and VaultPilot's **Include active note by default** setting before using it with sensitive vault content.

## License

MIT
