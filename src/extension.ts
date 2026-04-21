import * as vscode from "vscode";
import { cleanCopiedText } from "./cleaner.js";

let output: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Tidy Paste");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "tidy-paste.terminalCopyClean",
      () => terminalCopyClean(),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "tidy-paste.cleanSelection",
      () => cleanEditorSelection(),
    ),
  );
}

export function deactivate(): void {
  output?.dispose();
}

async function terminalCopyClean(): Promise<void> {
  const config = vscode.workspace.getConfiguration("tidyPaste");
  if (config.get<boolean>("enabled") === false) {
    // Kill switch: just run native copy and stop.
    await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
    return;
  }

  // Step 1: run native copy so the selection lands on the clipboard.
  await vscode.commands.executeCommand("workbench.action.terminal.copySelection");

  // Step 2: read what landed.
  const raw = await vscode.env.clipboard.readText();
  if (!raw || !raw.includes("\n")) return; // single-line copies need no cleanup

  // Step 3: figure out the active terminal's column width.
  const terminalColumns = getActiveTerminalColumns();

  const result = cleanCopiedText(raw, {
    terminalColumns,
    appWrapColumn: config.get<number>("appWrapColumn") ?? 80,
    minWrapLines: config.get<number>("minWrapLines") ?? 2,
    stripTrailingWhitespace: config.get<boolean>("stripTrailingWhitespace") ?? true,
    preserveCodeFences: config.get<boolean>("preserveCodeFences") ?? true,
  });

  if (config.get<boolean>("debug")) {
    output?.appendLine(
      `[copy] terminalColumns=${terminalColumns} changed=${result.changed} notes=${result.notes.length}`,
    );
    for (const n of result.notes) output?.appendLine(`  ${n}`);
  }

  if (result.changed) {
    await vscode.env.clipboard.writeText(result.text);
  }
}

async function cleanEditorSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const config = vscode.workspace.getConfiguration("tidyPaste");

  const ranges = editor.selections.filter((s) => !s.isEmpty);
  if (ranges.length === 0) {
    vscode.window.showInformationMessage("Tidy Paste: nothing selected.");
    return;
  }

  await editor.edit((edit) => {
    for (const sel of ranges) {
      const raw = editor.document.getText(sel);
      const result = cleanCopiedText(raw, {
        terminalColumns: 0, // unknown for editor selection
        appWrapColumn: config.get<number>("appWrapColumn") ?? 80,
        minWrapLines: config.get<number>("minWrapLines") ?? 2,
        stripTrailingWhitespace: config.get<boolean>("stripTrailingWhitespace") ?? true,
        preserveCodeFences: config.get<boolean>("preserveCodeFences") ?? true,
      });
      if (result.changed) {
        edit.replace(sel, result.text);
      }
    }
  });
}

function getActiveTerminalColumns(): number {
  const term = vscode.window.activeTerminal;
  if (!term) return 0;
  // VS Code added Terminal.dimensions in 1.80+. It may be undefined until
  // the terminal has rendered at least once.
  const dims = (term as unknown as { dimensions?: { columns: number; rows: number } }).dimensions;
  return dims?.columns ?? 0;
}
