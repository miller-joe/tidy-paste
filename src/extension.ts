import * as vscode from "vscode";
import { cleanCopiedText } from "./cleaner.js";

let output: vscode.OutputChannel | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let watcherInterval: NodeJS.Timeout | undefined;
let lastProcessed = "";
let windowFocused = true;
/** Last raw clipboard content we cleaned, kept for the undo command. */
let rawBackup: string | null = null;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Tidy Paste");
  context.subscriptions.push(output);

  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.text = "$(clippy) Tidy Paste: idle";
  statusBar.tooltip =
    "Tidy Paste status. Updates on each clipboard change. Click to open the Output panel.";
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

  context.subscriptions.push(
    vscode.commands.registerCommand("tidy-paste.restoreRaw", async () => {
      if (rawBackup === null) {
        vscode.window.showInformationMessage(
          "Tidy Paste: nothing to restore. The clipboard hasn't been cleaned yet.",
        );
        return;
      }
      await vscode.env.clipboard.writeText(rawBackup);
      lastProcessed = rawBackup;
      setStatus("restored raw");
      vscode.window.showInformationMessage(
        "Tidy Paste: clipboard restored to the uncleaned original.",
      );
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      windowFocused = state.focused;
    }),
  );

  // Seed lastProcessed with whatever's in the clipboard right now so the
  // watcher doesn't immediately clean pre-existing content on startup.
  void vscode.env.clipboard.readText().then((seed) => {
    lastProcessed = seed ?? "";
    startClipboardWatcher(context);
  });

  // Re-read settings on change to pick up watcher toggling without reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("tidyPaste")) {
        stopClipboardWatcher();
        startClipboardWatcher(context);
      }
    }),
  );
}

export function deactivate(): void {
  stopClipboardWatcher();
  statusBar?.dispose();
  output?.dispose();
}

function setStatus(text: string): void {
  if (statusBar) {
    statusBar.text = `$(clippy) Tidy Paste: ${text}`;
  }
}

function startClipboardWatcher(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("tidyPaste");
  if (!config.get<boolean>("watchClipboard", true)) {
    setStatus("watcher off");
    return;
  }
  if (!config.get<boolean>("enabled", true)) {
    setStatus("disabled");
    return;
  }
  const intervalMs = Math.max(100, config.get<number>("watchIntervalMs") ?? 300);

  watcherInterval = setInterval(() => {
    if (!windowFocused) return; // cheap bail-out when VS Code is backgrounded
    void tickClipboardWatcher();
  }, intervalMs);

  context.subscriptions.push({ dispose: stopClipboardWatcher });
  setStatus("watching");
}

function stopClipboardWatcher(): void {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = undefined;
  }
}

async function tickClipboardWatcher(): Promise<void> {
  try {
    const current = await vscode.env.clipboard.readText();
    if (!current || current === lastProcessed) return;

    // Quick bail-outs before the heavier cleanup.
    if (!current.includes("\n")) {
      lastProcessed = current;
      return;
    }

    const config = vscode.workspace.getConfiguration("tidyPaste");
    if (!config.get<boolean>("enabled", true)) return;

    const terminalColumns = getActiveTerminalColumns();
    const result = cleanCopiedText(current, {
      terminalColumns,
      appWrapColumn: config.get<number>("appWrapColumn") ?? 80,
      stripTrailingWhitespace: config.get<boolean>("stripTrailingWhitespace") ?? true,
      preserveBlocks: config.get<boolean>("preserveCodeFences") ?? true,
      dedent: config.get<boolean>("dedent") ?? true,
    });

    if (config.get<boolean>("debug", false)) {
      output?.appendLine("------");
      output?.appendLine(
        `[watch] terminalColumns=${terminalColumns} changed=${result.changed} rawLines=${current.split("\n").length}`,
      );
      for (const n of result.notes) output?.appendLine(`  ${n}`);
      if (!result.changed && current.split("\n").length > 1) {
        const sample = current.split("\n").slice(0, 6);
        output?.appendLine("  [nothing matched] first lines:");
        for (let i = 0; i < sample.length; i++) {
          const line = sample[i]!;
          const end =
            line.length > 0 ? JSON.stringify(line[line.length - 1]!) : "(empty)";
          output?.appendLine(`    ${i}: len=${line.length} lastChar=${end}`);
        }
      }
    }

    if (result.changed) {
      rawBackup = current; // keep the uncleaned original for restoreRaw
      await vscode.env.clipboard.writeText(result.text);
      lastProcessed = result.text;
      setStatus(`cleaned ${result.notes.length} boundary/ies`);
    } else {
      lastProcessed = current;
      setStatus(`no change (${current.split("\n").length} lines)`);
    }
  } catch {
    // Silent; clipboard access can fail mid-transition.
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
  // The watcher will pick it up on its next tick. Kick a manual tick now
  // so the user sees instant feedback if invoked from a keybinding.
  await tickClipboardWatcher();
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
          stripTrailingWhitespace: config.get<boolean>("stripTrailingWhitespace") ?? true,
        preserveBlocks: config.get<boolean>("preserveCodeFences") ?? true,
      dedent: config.get<boolean>("dedent") ?? true,
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
