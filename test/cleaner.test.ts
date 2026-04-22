import { describe, it, expect } from "vitest";
import { cleanCopiedText } from "../src/cleaner.js";

describe("basic wrap rejoining", () => {
  it("rejoins a 3-line wrap at terminal width", () => {
    const input =
      "The quick brown fox jumps over the lazy dog and then immediately\n" +
      "turns around to jump back over because he forgot something he had\n" +
      "left on the other side of the fence.";
    const r = cleanCopiedText(input, { terminalColumns: 65 });
    expect(r.changed).toBe(true);
    expect(r.text.includes("\n")).toBe(false);
  });

  it("leaves a real paragraph break alone", () => {
    const input =
      "First paragraph that is exactly sixty-five chars wide, yeah real\n" +
      "tail of paragraph one.\n" +
      "\n" +
      "Second paragraph starts here.";
    const r = cleanCopiedText(input, { terminalColumns: 65 });
    expect(r.text).toContain("\n\nSecond paragraph starts here.");
  });

  it("does not rejoin two short unrelated lines", () => {
    const r = cleanCopiedText("hi\nhello", { terminalColumns: 80 });
    expect(r.changed).toBe(false);
    expect(r.text).toBe("hi\nhello");
  });
});

describe("width-independent / adaptive", () => {
  it("rejoins a long line + short tail when wrap column is unknown", () => {
    const input =
      "  - Did you fully reload VS Code after install? (Command Palette -> \"Developer: Reload\n" +
      "   Window.\")";
    const r = cleanCopiedText(input, { terminalColumns: 0, appWrapColumn: 0 });
    expect(r.changed).toBe(true);
    expect(r.text.includes("\n")).toBe(false);
  });

  it("does not rejoin short bullets (each ends with a period)", () => {
    const input =
      "- Ctrl+Shift+X (Extensions panel).\n" +
      "- Search \"Tidy Paste.\" Confirm it shows.\n" +
      "- Reload the window.";
    const r = cleanCopiedText(input, { terminalColumns: 0, appWrapColumn: 0 });
    expect(r.changed).toBe(false);
  });
});

describe("statistical wrap inference (overrides weak terminators)", () => {
  it("joins a wrap that lands on a period when multiple peer lines share the wrap column", () => {
    // Three lines all near length 76; two end with punctuation that would
    // normally block joining. The statistical mode is strong enough to
    // override the weak terminator on the middle line.
    const a = "This is a first line exactly seventy-six characters long and ending here";
    const b = "a second line that is also seventy-six characters long and ends this way."; // ends with "."
    const c = "Tail continuation short.";
    const input = `${a}\n${b}\n${c}`;
    // a=73 chars, b=74 chars — within slack of each other. Let's verify real lengths.
    expect(a.length).toBeGreaterThanOrEqual(60);
    expect(b.length).toBeGreaterThanOrEqual(60);
    const r = cleanCopiedText(input, { terminalColumns: 0, appWrapColumn: 0 });
    expect(r.changed).toBe(true);
  });
});

describe("markdown tables are protected", () => {
  it("does not merge table rows", () => {
    const input =
      "| Long col header | Other long header | Third column | Data |\n" +
      "| Another row with content         | More content | Still more | Data |";
    const r = cleanCopiedText(input, { terminalColumns: 0, appWrapColumn: 0 });
    expect(r.changed).toBe(false);
  });
});

describe("fenced code blocks", () => {
  it("preserves lines inside ``` fences verbatim", () => {
    const input =
      "Intro line wrapping at twenty cols here\n" +
      "then continuing onto the next line.\n" +
      "```ts\n" +
      "const aaaaaaaaaaaaaa = 1;\n" +
      "const bbbbbbbbbbbbbb = 2;\n" +
      "```\n" +
      "After the block.";
    const r = cleanCopiedText(input, { terminalColumns: 40 });
    expect(r.text).toContain("```ts\nconst aaaaaaaaaaaaaa = 1;\nconst bbbbbbbbbbbbbb = 2;\n```");
  });
});

describe("separate shell commands don't merge", () => {
  it("PowerShell cmdlet on line 2 breaks the cluster", () => {
    const input =
      "  code --uninstall-extension miller-joe.tidy-paste\n" +
      '  Invoke-WebRequest -Uri "https://example.com/file.vsix"';
    const r = cleanCopiedText(input, { terminalColumns: 0, appWrapColumn: 0 });
    expect(r.text.split("\n").length).toBe(2);
  });

  it("two npm commands in sequence stay separate", () => {
    const input = "npm install tidy-paste\nnpm run dev";
    const r = cleanCopiedText(input, { terminalColumns: 0, appWrapColumn: 0 });
    expect(r.changed).toBe(false);
  });
});

describe("URL mid-domain wraps", () => {
  it("joins a URL wrapped mid-domain without inserting a space", () => {
    const input =
      "● v0.1.0 shipped. Download: https://github.com/miller-joe/tidy-paste/releases/downloa\n" +
      "d/v0.1.0/tidy-paste-0.1.0.vsix";
    const r = cleanCopiedText(input, { terminalColumns: 0, appWrapColumn: 0 });
    expect(r.text).toContain("/releases/download/v0.1.0/");
    expect(r.text).not.toContain("downloa d");
  });
});

describe("smart join separator", () => {
  it("no space when next line starts with '.' (URL continuation)", () => {
    const input =
      "Download: https://github.com/miller-joe/tidy-paste/releases/download/v0\n" +
      ".0.4/tidy-paste-0.0.4.vsix";
    const r = cleanCopiedText(input, { terminalColumns: 0, appWrapColumn: 0 });
    expect(r.text).toContain("/v0.0.4/tidy-paste-0.0.4.vsix");
    expect(r.text).not.toContain("v0 .0.4");
  });

  it("single space when joining word-boundary wraps", () => {
    const line1 = "The quick brown fox jumped over the lazy dog and kept right on going";
    const line2 = "across the meadow";
    const r = cleanCopiedText(`${line1}\n${line2}`, {
      terminalColumns: 0,
      appWrapColumn: 0,
    });
    expect(r.text).toBe(`${line1} ${line2}`);
  });
});

describe("list-item continuations", () => {
  it("joins a list item's wrapped tail that's indented to the body column", () => {
    const input =
      "- Did you fully reload VS Code after install? (Command Palette ->\n" +
      "  \"Developer: Reload Window.\")\n" +
      "- Next bullet here.";
    const r = cleanCopiedText(input, { terminalColumns: 0, appWrapColumn: 0 });
    const lines = r.text.split("\n");
    expect(lines[0]).toBe(
      '- Did you fully reload VS Code after install? (Command Palette -> "Developer: Reload Window.")',
    );
    expect(lines[1]).toBe("- Next bullet here.");
  });
});

describe("dedent per block", () => {
  it("strips the common leading indent from a prose block", () => {
    const input = "    Hello world.\n    Second line.";
    const r = cleanCopiedText(input, { terminalColumns: 0, appWrapColumn: 0 });
    expect(r.text.startsWith("    ")).toBe(false);
    expect(r.text).toBe("Hello world.\nSecond line.");
  });

  it("preserves relative indent inside the prose block", () => {
    const input = "  - Item 1\n    - Sub-item\n  - Item 2";
    const r = cleanCopiedText(input, { terminalColumns: 0, appWrapColumn: 0 });
    const lines = r.text.split("\n");
    expect(lines[0]).toBe("- Item 1");
    expect(lines[1]).toBe("  - Sub-item");
    expect(lines[2]).toBe("- Item 2");
  });
});

describe("trailing whitespace", () => {
  it("strips trailing whitespace by default", () => {
    const input = "hello   \nworld\t\t";
    const r = cleanCopiedText(input, { terminalColumns: 0 });
    expect(r.text).toBe("hello\nworld");
  });

  it("keeps trailing whitespace when disabled", () => {
    const input = "hello   \nworld";
    const r = cleanCopiedText(input, { terminalColumns: 0, stripTrailingWhitespace: false });
    expect(r.text).toBe("hello   \nworld");
  });
});

describe("edge cases", () => {
  it("empty input", () => {
    const r = cleanCopiedText("", { terminalColumns: 80 });
    expect(r.text).toBe("");
    expect(r.changed).toBe(false);
  });

  it("single line input", () => {
    const r = cleanCopiedText("just one line, no wrap", { terminalColumns: 80 });
    expect(r.text).toBe("just one line, no wrap");
  });

  it("preserves trailing newline", () => {
    const input = "one line\n";
    const r = cleanCopiedText(input, { terminalColumns: 80 });
    expect(r.text.endsWith("\n")).toBe(true);
  });
});

describe("real-world Claude Code sample", () => {
  it("cleans a bullet-heavy indented markdown block", () => {
    const input =
      "  1. Notification toasts (bottom-right of VS Code). They auto-dismiss. You can view recent ones:\n" +
      "    - Click the bell icon in the bottom-right status bar.\n" +
      '    - Or: Command Palette (Ctrl+Shift+P) → "Notifications: Show Notifications."\n' +
      "  2. Output panel. View → Output. In the channel dropdown (top-right of the panel)\n" +
      "  pick \"Extensions\" or \"Log (Extension Host)\". Scroll for recent errors.";
    const r = cleanCopiedText(input, { terminalColumns: 100, appWrapColumn: 80 });
    // The outer 2-space indent should be gone.
    expect(r.text.startsWith("1.")).toBe(true);
    // The "Output panel. View..." line should be one line (wrap joined).
    const outputPanelLine = r.text
      .split("\n")
      .find((l) => l.startsWith("2. Output panel"));
    expect(outputPanelLine).toBeDefined();
    expect(outputPanelLine).toContain("Scroll for recent errors.");
  });
});
