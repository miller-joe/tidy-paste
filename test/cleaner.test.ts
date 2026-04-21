import { describe, it, expect } from "vitest";
import { cleanCopiedText } from "../src/cleaner.js";

describe("terminal soft-wrap rejoining", () => {
  it("rejoins a 3-line wrap at terminal width", () => {
    const input =
      "The quick brown fox jumps over the lazy dog and then immediately\n" +
      "turns around to jump back over because he forgot something he had\n" +
      "left on the other side of the fence.";
    const r = cleanCopiedText(input, { terminalColumns: 65 });
    expect(r.changed).toBe(true);
    expect(r.text).toBe(
      "The quick brown fox jumps over the lazy dog and then immediately turns around to jump back over because he forgot something he had left on the other side of the fence.",
    );
  });

  it("leaves a real paragraph break alone", () => {
    const input =
      "First paragraph line one that is exactly sixty-five chars wide wr\n" +
      "last line of paragraph one.\n" +
      "\n" +
      "Second paragraph starts here.";
    const r = cleanCopiedText(input, { terminalColumns: 65 });
    expect(r.text).toContain("\n\nSecond paragraph starts here.");
  });

  it("does not rejoin short lines (below minWrapLines)", () => {
    const input = "hi\nhello";
    const r = cleanCopiedText(input, { terminalColumns: 80 });
    expect(r.changed).toBe(false);
    expect(r.text).toBe("hi\nhello");
  });
});

describe("app-side 80-col wrap (default)", () => {
  it("rejoins 80-col wrapped text regardless of terminal width", () => {
    // Exactly 80 chars, does not end in a sentence terminator.
    const line1 = "The quick brown fox jumped over the lazy dog and then did some other things here";
    const line2 = "and after that it rolled around on the grass.";
    const input = line1 + "\n" + line2;
    const r = cleanCopiedText(input, { terminalColumns: 200, appWrapColumn: 80 });
    expect(line1.length).toBe(80);
    expect(r.changed).toBe(true);
    expect(r.text.includes("\n")).toBe(false);
  });

  it("respects minWrapLines when only one 80-col line is present", () => {
    // Single 80-char line (at boundary) followed by short line: not a cluster.
    const input =
      "12345678901234567890123456789012345678901234567890123456789012345678901234567890\n" +
      "short tail";
    const r = cleanCopiedText(input, { terminalColumns: 0, appWrapColumn: 80, minWrapLines: 3 });
    expect(r.changed).toBe(false);
  });
});

describe("sentence terminators", () => {
  it("does not rejoin a line ending in a period even if at column boundary", () => {
    const input = "Short sentence.\n" + "Next independent sentence.";
    const r = cleanCopiedText(input, { terminalColumns: 15 });
    expect(r.changed).toBe(false);
  });

  it("handles closing punctuation too", () => {
    const input = "Everything in parens here (works)\n" + "Next independent line.";
    const r = cleanCopiedText(input, { terminalColumns: 33 });
    expect(r.changed).toBe(false);
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

describe("preserve code fences", () => {
  it("leaves content inside ``` alone even if at the boundary", () => {
    const input =
      "Intro paragraph wrapping at twenty cols here\n" +
      "and continuing onto the next line.\n" +
      "```ts\n" +
      "const aaaaaaaaaaaaaa = 1;\n" +
      "const bbbbbbbbbbbbbb = 2;\n" +
      "```\n" +
      "After the block.";
    const r = cleanCopiedText(input, { terminalColumns: 44 });
    // The fenced block is preserved line-for-line.
    expect(r.text.includes("```ts\nconst aaaaaaaaaaaaaa = 1;\nconst bbbbbbbbbbbbbb = 2;\n```")).toBe(
      true,
    );
  });

  it("ignores fences when preserveCodeFences=false", () => {
    const input =
      "```\n" +
      "exactly twenty chars1\n" +
      "and next line continues\n" +
      "```";
    const r = cleanCopiedText(input, {
      terminalColumns: 21,
      preserveCodeFences: false,
      minWrapLines: 2,
    });
    // At 21 columns the first two lines would be candidates; with fences off we join.
    expect(r.changed).toBe(true);
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
