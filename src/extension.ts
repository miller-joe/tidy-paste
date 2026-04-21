import * as vscode from "vscode";
import { cleanCopiedText } from "./cleaner.js";

let output: vscode.OutputChannel | undefined;
let statusBar: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Tidy Paste");
  context.subscriptions.push(output);

  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.text = "$(clippy) Tidy Paste: idle";
  statusBar.tooltip =
    "Tidy Paste status. Updates on each terminal copy. Click to open the Output panel.";
  statusBar.command = "tidy-paste.showOutput";
  statusBar.show();
  context.subscriptions.push(statusBar);

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

  context.subscriptions.push(
    vscode.commands.registerCommand("tidy-paste.showOutput", () => {
      output?.show(true);
    }),
  );
}

export function deactivate(): void {
  statusBar?.dispose();
  output?.dispose();
}

function setStatus(text: string): void {
  if (statusBar) {
    statusBar.text = `$(clippy) Tidy Paste: ${text}`;
  }
}

async function terminalCopyClean(): Promise<void> {
  const config = vscode.workspace.getConfiguration("tidyPaste");
  if (config.get<boolean>("enabled") === false) {
    await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
    setStatus("disabled");
    return;
  }

  await vscode.commands.executeCommand("workbench.action.terminal.copySelection");

  const raw = await vscode.env.clipboard.readText();
  if (!raw) {
    setStatus("empty clipboard");
    return;
  }
  if (!raw.includes("\n")) {
    setStatus("single line, no change");
    return;
  }

  const terminalColumns = getActiveTerminalColumns();

  const result = cleanCopiedText(raw, {
    terminalColumns,
    appWrapColumn: config.get<number>("appWrapColumn") ?? 80,
    minWrapLines: config.get<number>("minWrapLines") ?? 2,
    stripTrailingWhitespace: config.get<boolean>("stripTrailingWhitespace") ?? true,
    preserveCodeFences: config.get<boolean>("preserveCodeFences") ?? true,
  });

  if (config.get<boolean>("debug")) {
    output?.appendLine("------");
    output?.appendLine(
      `[copy] terminalColumns=${terminalColumns} appWrap=${config.get<number>("appWrapColumn") ?? 80} changed=${result.changed} rawLines=${raw.split("\n").length}`,
    );
    for (const n of result.notes) output?.appendLine(`  ${n}`);
    if (!result.changed && raw.split("\n").length > 1) {
      // Show the first few lines with their lengths so the user can see why the
      // heuristic didn't fire.
      const sample = raw.split("\n").slice(0, 6);
      output?.appendLine("  [nothing matched] first lines:");
      for (let i = 0; i < sample.length; i++) {
        const line = sample[i]!;
        const end = line.length > 0 ? JSON.stringify(line[line.length - 1]!) : "(empty)";
        output?.appendLine(`    ${i}: len=${line.length} lastChar=${end}`);
      }
    }
  }

  if (result.changed) {
    await vscode.env.clipboard.writeText(result.text);
    const joined = result.notes.length;
    setStatus(joined > 0 ? `joined ${joined} cluster(s)` : "cleaned whitespace");
  } else {
    setStatus("no change");
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
        terminalColumns: 0,
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
  setStatus("editor selection cleaned");
}

function getActiveTerminalColumns(): number {
  const term = vscode.window.activeTerminal;
  if (!term) return 0;
  const dims = (term as unknown as { dimensions?: { columns: number; rows: number } }).dimensions;
  return dims?.columns ?? 0;
}
