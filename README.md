# tidy-paste

VS Code extension that cleans copied text from the integrated terminal before it hits your clipboard. Wrapped lines join back into one, trailing whitespace is stripped, code blocks are left alone. Pasting into anything — editor, chat, browser, Slack — comes out clean.

## Why

Every time you copy a long line from a terminal that visually wrapped at the edge, the clipboard receives those visual wraps as real newlines. VS Code's own fix from 2017 doesn't cover all the cases, and tools that emit their own 80-col hard breaks (many LLM CLIs do this) sidestep it entirely. The existing extensions all require a post-paste command. This one intercepts at copy time, fixes the clipboard, and never makes you think about it again.

## Install

From the VS Code Marketplace: search for "Tidy Paste" (publisher: miller-joe).

Or from a local `.vsix` build:

```bash
git clone https://github.com/miller-joe/tidy-paste
cd tidy-paste
npm install
npm run package          # produces tidy-paste-X.X.X.vsix
code --install-extension tidy-paste-*.vsix
```

Requires VS Code 1.80+.

## How it works

Installing the extension binds `Ctrl+C` / `Cmd+C` in the integrated terminal (only when text is selected) to a command that:

1. Runs VS Code's native `workbench.action.terminal.copySelection`.
2. Reads what landed on the clipboard.
3. Looks at the active terminal's column width.
4. Walks the copied text and identifies clusters of consecutive lines that end exactly at the terminal's column width, or at a fixed app-wrap column (80 by default). These clusters are joined into single lines.
5. Writes the cleaned text back to the clipboard.

When nothing looks wrapped, the clipboard is left untouched. Single-line copies are skipped entirely.

## Settings

| Setting | Default | Description |
|---|---|---|
| `tidyPaste.enabled` | `true` | Master switch. When off, terminal copy behaves as default. |
| `tidyPaste.appWrapColumn` | `80` | Extra fixed column width to detect as an app-side hard wrap. Set to `0` to disable and only use the current terminal width. |
| `tidyPaste.minWrapLines` | `2` | Minimum consecutive candidate lines required to treat a block as wrapped. |
| `tidyPaste.stripTrailingWhitespace` | `true` | Strip trailing whitespace from every line. |
| `tidyPaste.preserveCodeFences` | `true` | Never rewrap text inside a triple-backtick fenced block. |
| `tidyPaste.debug` | `false` | Log rewrite decisions to the Output panel (channel: Tidy Paste). |

## Commands

- **Tidy Paste: Copy Cleaned (terminal)** — `tidy-paste.terminalCopyClean`. Invoked by the `Ctrl+C` keybinding when text is selected in the terminal. You can bind it to something else.
- **Tidy Paste: Clean Selection (editor)** — `tidy-paste.cleanSelection`. Applies the same cleanup to a selection inside a text editor. Useful after pasting already-mangled text from somewhere else.

## What gets joined, what doesn't

A line is a wrap candidate when its length matches the terminal's column width, or the configured `appWrapColumn`, AND it doesn't end with a sentence terminator (`. ! ? : ; , ) ] } " ' backtick`). A cluster of 2+ consecutive candidates is joined into a single line.

Left alone:
- Single short lines.
- Lines ending with sentence terminators.
- Text inside triple-backtick fenced blocks.
- Paragraph boundaries (blank lines between clusters).
- Anything the heuristic isn't confident about. When unsure, preserve.

## Roadmap

Shipped in 0.0.1:

- Terminal copy interception via keybinding
- Terminal-width and app-side wrap detection
- Trailing whitespace strip
- Code fence preservation
- Editor-selection cleanup as a manual command

Planned:

- Clipboard-watcher mode so non-VS-Code paste sources also get cleaned when the clipboard last-writer was a VS Code terminal
- Per-language overrides (aggressive for markdown, conservative for code)
- Undo: a single command to restore the raw copy if the cleanup guessed wrong

## Development

```bash
npm install
npm run watch          # tsc in watch mode
npm test
npm run package        # build a .vsix
```

Requires Node 20+.

## License

MIT
