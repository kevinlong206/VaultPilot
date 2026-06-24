# Repository Guidelines

## Project overview

VaultPilot is a desktop-only Obsidian plugin that provides an in-vault chat and note-assistance workflow backed by a local GitHub Copilot-compatible CLI command. The plugin captures the active Markdown note or selection, composes a prompt with vault context, runs the configured Copilot command, and renders Markdown responses in an Obsidian sidebar view.

## Important files

- `src/main.ts`: Main plugin source. Contains plugin lifecycle, commands, chat view, settings tab, Copilot command execution, JSON event parsing, and helper functions.
- `styles.css`: Obsidian UI styles for the VaultPilot chat view.
- `manifest.json`: Obsidian plugin metadata. Keep version and desktop-only metadata aligned with releases.
- `esbuild.config.mjs`: Bundles `src/main.ts` to `main.js`.
- `main.js`: Generated bundle. Do not edit manually; regenerate with `npm run build`.
- `package.json` / `package-lock.json`: npm scripts and locked dependencies.

## Development commands

- Install dependencies: `npm install`
- Development watcher: `npm run dev`
- Production build/type check: `npm run build`

There is no separate test script currently. Use `npm run build` as the required validation for TypeScript changes.

## Code conventions

- Use TypeScript with strict settings from `tsconfig.json`.
- Keep edits focused in `src/main.ts` unless changing styling, packaging metadata, or docs.
- Follow the existing style: tabs for indentation, single quotes, semicolons, explicit return types on methods/functions, and Obsidian API helpers such as `createDiv`, `createEl`, `Notice`, and `MarkdownRenderer`.
- Avoid `any` and broad casts. Prefer small interfaces and type guards consistent with the existing `CopilotJsonEvent` and metadata types.
- Preserve the plugin's desktop assumptions: local command execution uses `node:child_process`, `node:fs`, and Obsidian's desktop adapter `basePath`.
- Keep user-facing errors visible through `Notice` or chat error messages; do not silently swallow failures.

## Behavior and safety notes

- Default command mode is automatic. On macOS/Linux it runs `copilot` directly; on Windows it prefers a Node loader when discoverable, then falls back to `copilot.cmd` through a shell.
- Be careful when changing command execution. Preserve argument-array spawning for non-shell paths, prompt templating for `{prompt}`, `{vault}`, and `{file}`, timeout handling, and JSON output parsing.
- The default Copilot arguments request JSON output so streaming response chunks and metadata can be parsed. If changing output handling, support both streaming `assistant.message_delta` events and final `assistant.message` content.
- The active note or selected text may contain private vault content. Do not add logging that exposes prompts, note contents, stdout, or stderr unless it is explicitly user-facing and necessary for troubleshooting.
- `includeActiveNoteByDefault` controls whether the full active note is sent when no selection exists. Preserve this privacy-sensitive behavior.

## Build artifacts and release files

- Do not manually edit generated `main.js`; update `src/main.ts` and run `npm run build`.
- Keep `manifest.json`, `main.js`, and `styles.css` ready for copying into `<vault>/.obsidian/plugins/vaultpilot/`.
- Avoid committing local Obsidian runtime files such as `.hotreload` and `data.json`.

