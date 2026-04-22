/**
 * Core cleanup logic. Given text copied from a terminal, decide which of
 * the `\n` characters were inserted by visual wrapping and rejoin those,
 * while leaving intentional line breaks alone.
 *
 * Model: we don't classify LINES as wrap-candidates. We classify each
 * NEWLINE BOUNDARY between consecutive lines as join-or-break, using a
 * score that weighs multiple structural signals. Boundaries scoring at
 * or above the threshold get joined.
 *
 * This file is intentionally dependency-free and synchronous so it can
 * be called from both the extension and any future CLI wrapper.
 */

export interface CleanOptions {
  /** The terminal's current column width. Used as one of the wrap-mode candidates. */
  terminalColumns?: number;
  /** A fixed app-side wrap column (many CLIs emit 80-col output). Used as another wrap-mode candidate. */
  appWrapColumn?: number;
  /** Strip trailing whitespace from every non-empty line. */
  stripTrailingWhitespace?: boolean;
  /** Never rewrap inside ``` fenced blocks or detected prompt/table blocks. */
  preserveBlocks?: boolean;
  /** Strip the common leading indent per block. */
  dedent?: boolean;
  /** Join-score threshold (default 3). Lower = more aggressive. */
  threshold?: number;
}

export interface CleanResult {
  text: string;
  changed: boolean;
  notes: string[];
}

// Strong terminators: structural chars that usually end a logical unit.
// '>' is excluded because '->' arrows are common in prose and code.
const STRONG_TERMINATORS = new Set<string>([
  "|",
  "}",
  "]",
  ")",
  "`",
]);

// Weak terminators: clause/sentence punctuation. Can be overridden when the line
// ends at an inferred wrap mode.
const WEAK_TERMINATORS = new Set<string>([
  ".",
  "!",
  "?",
  ":",
  ";",
  ",",
  '"',
  "'",
]);

// Characters that, when they START the next line, imply the newline was
// mid-token (URL slash, decimal point, closing paren, etc.). Quotes are
// NOT included: a quote at the start of a line usually opens a new quoted
// phrase that needs a space before it.
const CONTINUATION_STARTERS = new Set<string>([
  ".",
  "/",
  ")",
  "]",
  "}",
  "`",
  ",",
  ";",
  ":",
  "?",
  "!",
  "-",
]);

const MIN_ADAPTIVE_WRAP_LEN = 40;
const WRAP_COLUMN_SLACK = 2;

export function cleanCopiedText(input: string, opts: CleanOptions = {}): CleanResult {
  const notes: string[] = [];
  const terminalColumns = opts.terminalColumns ?? 0;
  const appWrapColumn = opts.appWrapColumn ?? 80;
  const stripTrailing = opts.stripTrailingWhitespace ?? true;
  const preserveBlocks = opts.preserveBlocks ?? true;
  const doDedent = opts.dedent ?? true;
  const threshold = opts.threshold ?? 3;

  const endedWithNewline = input.endsWith("\n");
  const body = endedWithNewline ? input.slice(0, -1) : input;

  let rawLines = body.split(/\r?\n/);
  if (stripTrailing) rawLines = rawLines.map((l) => l.replace(/[ \t]+$/, ""));

  // 1. Detect hard blocks. Lines inside these are preserved verbatim and
  //    boundaries into/out of them are always breaks.
  const hardLines = preserveBlocks
    ? detectHardBlocks(rawLines)
    : new Set<number>();

  // 2. Dedent per block (prose regions share their own min indent; each
  //    hard block keeps its own indentation).
  const lines = doDedent ? dedentPerBlock(rawLines, hardLines) : rawLines.slice();

  // 3. Compute wrap modes from the length distribution.
  const wrapModes = computeWrapModes(lines, hardLines, terminalColumns, appWrapColumn);

  // 4. Track the active list-item body column at each line.
  const listBodyCols = computeListBodyColumns(lines);

  // 5. Compute a join score for each boundary i→i+1, then merge runs.
  const joinBoundary: boolean[] = new Array(Math.max(0, lines.length - 1)).fill(false);
  for (let i = 0; i < lines.length - 1; i++) {
    const score = scoreBoundary(
      lines[i]!,
      lines[i + 1]!,
      i,
      i + 1,
      hardLines,
      wrapModes,
      listBodyCols,
    );
    joinBoundary[i] = score >= threshold;
    if (joinBoundary[i] && notes.length < 20) {
      notes.push(`join boundary ${i}→${i + 1} (score=${score})`);
    }
  }

  // 6. Merge consecutive join-true runs.
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const cluster: string[] = [lines[i]!];
    let j = i;
    while (j < lines.length - 1 && joinBoundary[j]) {
      cluster.push(lines[j + 1]!);
      j++;
    }
    out.push(cluster.length > 1 ? mergeCluster(cluster) : cluster[0]!);
    i = j + 1;
  }

  let text = out.join("\n");
  if (endedWithNewline) text += "\n";
  return { text, changed: text !== input, notes };
}

// ---- structural detection ----

/**
 * Detect all "hard" blocks: fenced code, markdown tables, prompt/command
 * runs. Returns a set of line indices that are inside one of these blocks.
 * Boundaries in or out of them will always break.
 */
function detectHardBlocks(lines: string[]): Set<number> {
  const inside = new Set<number>();
  let openFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      inside.add(i);
      openFence = !openFence;
      continue;
    }
    if (openFence) inside.add(i);
  }

  // Markdown table: 2+ consecutive lines where each has 2+ `|` separators.
  for (let i = 0; i < lines.length; i++) {
    if (inside.has(i)) continue;
    if (countPipes(lines[i]!) < 2) continue;
    let j = i;
    while (j < lines.length && !inside.has(j) && countPipes(lines[j]!) >= 2) j++;
    if (j - i >= 2) {
      for (let k = i; k < j; k++) inside.add(k);
    }
    i = j - 1;
  }

  // Prompt/command runs: 2+ consecutive lines that look like shell commands.
  for (let i = 0; i < lines.length; i++) {
    if (inside.has(i)) continue;
    if (!looksLikeCommandLine(lines[i]!)) continue;
    let j = i;
    while (j < lines.length && !inside.has(j) && looksLikeCommandLine(lines[j]!)) j++;
    if (j - i >= 2) {
      for (let k = i; k < j; k++) inside.add(k);
    }
    i = j - 1;
  }

  return inside;
}

function countPipes(line: string): number {
  let n = 0;
  for (const ch of line) if (ch === "|") n++;
  return n;
}

const KNOWN_COMMAND_HEAD =
  /^(sudo|npm|npx|yarn|pnpm|node|deno|bun|python|pip|cargo|go|rustc|make|cmake|code|git|docker|podman|kubectl|helm|ssh|scp|rsync|curl|wget|http|cd|ls|rm|cp|mv|mkdir|touch|cat|tail|head|grep|awk|sed|find|xargs|brew|apt|dnf|yum|zypper|pacman|systemctl|journalctl|ps|kill|top|htop|tmux|screen|vim|nvim|emacs|nano|less|more|tar|unzip|zip|chmod|chown|export|source|echo|printf|ollama|claude|pytest|vitest|jest|Invoke-[A-Z]|Get-[A-Z]|Set-[A-Z]|Remove-[A-Z]|Install-[A-Z]|Uninstall-[A-Z]|New-[A-Z]|Start-[A-Z]|Stop-[A-Z])(\s|$)/;

function looksLikeCommandLine(line: string): boolean {
  const trimmed = line.replace(/^\s+/, "");
  if (!trimmed) return false;
  if (/^(\$|PS\s|#\s|> )/.test(trimmed)) return true;
  return KNOWN_COMMAND_HEAD.test(trimmed);
}

// ---- list-item body column tracking ----

const LIST_MARKER_RE = /^([ \t]*)(?:([-*+•])|(\d+[.)])|([A-Za-z][.)]))(\s+)(.*)$/;

function computeListBodyColumns(lines: string[]): (number | null)[] {
  const out: (number | null)[] = new Array(lines.length).fill(null);
  let activeBodyCol: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) {
      activeBodyCol = null;
      continue;
    }
    const marker = LIST_MARKER_RE.exec(line);
    if (marker) {
      const indent = marker[1]!.length;
      const markerTok = marker[2] ?? marker[3] ?? marker[4] ?? "";
      const ws = marker[5] ?? "";
      activeBodyCol = indent + markerTok.length + ws.length;
      out[i] = activeBodyCol;
    } else if (activeBodyCol !== null) {
      const indent = (line.match(/^[ \t]*/)?.[0] ?? "").length;
      if (indent >= activeBodyCol) {
        out[i] = activeBodyCol;
      } else {
        activeBodyCol = null;
        out[i] = null;
      }
    }
  }
  return out;
}

// ---- wrap-mode inference ----

interface WrapModes {
  modes: number[];
}

function computeWrapModes(
  lines: string[],
  hardLines: Set<number>,
  terminalColumns: number,
  appWrapColumn: number,
): WrapModes {
  const modes: number[] = [];
  if (terminalColumns > 0) modes.push(terminalColumns);
  if (appWrapColumn > 0 && !modes.includes(appWrapColumn)) modes.push(appWrapColumn);

  // Statistical inference: find the longest non-hard-block line with
  // 2+ peers within ±slack.
  const lengths: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (hardLines.has(i)) continue;
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    lengths.push(line.length);
  }
  if (lengths.length >= 2) {
    const max = Math.max(...lengths);
    if (max >= 30) {
      const near = lengths.filter((l) => Math.abs(l - max) <= WRAP_COLUMN_SLACK).length;
      if (near >= 2 && !modes.some((m) => Math.abs(m - max) <= WRAP_COLUMN_SLACK)) {
        modes.push(max);
      }
    }
  }
  return { modes };
}

function lineEndsAtWrapMode(lineLength: number, modes: WrapModes): boolean {
  for (const m of modes.modes) {
    if (Math.abs(lineLength - m) <= WRAP_COLUMN_SLACK) return true;
  }
  return false;
}

// ---- boundary scoring ----

function scoreBoundary(
  prev: string,
  next: string,
  prevIdx: number,
  nextIdx: number,
  hardLines: Set<number>,
  wrapModes: WrapModes,
  listBodyCols: (number | null)[],
): number {
  // Hard never-join conditions.
  if (prev.trim().length === 0 || next.trim().length === 0) return -Infinity;
  if (hardLines.has(prevIdx) || hardLines.has(nextIdx)) return -Infinity;

  let score = 0;

  // +3: previous line length lands on a known wrap mode.
  if (lineEndsAtWrapMode(prev.length, wrapModes)) score += 3;

  // +2: next line is indented close to an active list body column
  // (continuation). Allow ±2 slack because terminals don't always rewrap
  // continuations to the exact body column.
  const activeCol = listBodyCols[prevIdx];
  if (activeCol !== null && activeCol !== undefined) {
    const nextIndent = (next.match(/^[ \t]*/)?.[0] ?? "").length;
    if (Math.abs(nextIndent - activeCol) <= 2) score += 2;
  }

  // +1: next line starts with a lowercase letter, digit, or opening punct.
  const firstNon = next.replace(/^\s+/, "")[0];
  if (firstNon && /[a-z0-9(["'“‘]/.test(firstNon)) score += 1;

  // +2: boundary looks mid-token (next starts with continuation punctuation).
  if (firstNon && CONTINUATION_STARTERS.has(firstNon)) score += 2;

  // Strong terminator on prev: negative, but not absolute. A parenthetical
  // ending at the wrap boundary with a lowercase continuation can still beat
  // this penalty with enough positive signal.
  const lastChar = prev[prev.length - 1]!;
  if (STRONG_TERMINATORS.has(lastChar)) score -= 3;

  // Weak terminator on prev, WITHOUT a wrap-mode match: negative.
  if (WEAK_TERMINATORS.has(lastChar) && !lineEndsAtWrapMode(prev.length, wrapModes)) {
    score -= 2;
  }

  // When the prev line ends with structural punctuation BUT the next line
  // starts with a clear continuation (lowercase letter, conjunction-like
  // word), the punctuation was almost certainly a parenthetical closing at
  // the wrap column and the sentence continues. Boost so we actually join.
  if (
    STRONG_TERMINATORS.has(lastChar) &&
    firstNon &&
    /[a-z]/.test(firstNon) &&
    !looksCodeDense(prev) &&
    !looksCodeDense(next)
  ) {
    score += 3;
  }

  // -4: next line starts a new peer list item, command, or prompt.
  if (looksLikeNewStatement(next)) score -= 4;

  // -5: both sides look code/shell dense (heuristic: contains common code glyphs).
  if (looksCodeDense(prev) && looksCodeDense(next)) score -= 5;

  // Adaptive fallback: prev is long, no wrap-mode match, no terminator → slight +1.
  if (
    !lineEndsAtWrapMode(prev.length, wrapModes) &&
    prev.length >= MIN_ADAPTIVE_WRAP_LEN &&
    !STRONG_TERMINATORS.has(lastChar) &&
    !WEAK_TERMINATORS.has(lastChar)
  ) {
    score += 2;
  }

  return score;
}

function looksCodeDense(line: string): boolean {
  // Heuristic: contains multiple "code glyphs" per line.
  let n = 0;
  for (const ch of line) {
    if (ch === "{" || ch === "}" || ch === "=" || ch === "(" || ch === ")" || ch === ";") n++;
  }
  return n >= 3;
}

export function looksLikeNewStatement(line: string): boolean {
  const trimmed = line.replace(/^\s+/, "");
  if (!trimmed) return false;
  if (/^[-*+•]\s/.test(trimmed)) return true;
  if (/^\d+[.)]\s/.test(trimmed)) return true;
  if (/^[a-zA-Z][.)]\s/.test(trimmed)) return true;
  if (/^[A-Z][a-z]+-[A-Z]/.test(trimmed)) return true;
  if (KNOWN_COMMAND_HEAD.test(trimmed)) return true;
  if (/^(\$|PS |> )/.test(trimmed) && trimmed !== ">") return true;
  return false;
}

// ---- merge + dedent ----

function mergeCluster(cluster: string[]): string {
  const cleaned = cluster.map((line, idx) => {
    const t = line.replace(/[ \t]+$/, "");
    return idx === 0 ? t : t.replace(/^[ \t]+/, "");
  });
  let out = cleaned[0] ?? "";
  for (let i = 1; i < cleaned.length; i++) {
    const prev = cleaned[i - 1] ?? "";
    const next = cleaned[i] ?? "";
    out += joinSeparator(prev, next) + next;
  }
  return out.replace(/[ \t]+$/, "");
}

function joinSeparator(prev: string, next: string): string {
  if (prev.length === 0 || next.length === 0) return "";
  const lastChar = prev[prev.length - 1]!;
  const firstChar = next[0]!;
  if (/\s/.test(lastChar) || /\s/.test(firstChar)) return "";
  if (CONTINUATION_STARTERS.has(firstChar)) return "";
  return " ";
}

/**
 * Dedent per block: each contiguous run of non-hard lines gets its own
 * common-leading-whitespace strip. Hard-block lines are untouched.
 */
function dedentPerBlock(lines: string[], hardLines: Set<number>): string[] {
  const out = lines.slice();
  let i = 0;
  while (i < out.length) {
    if (hardLines.has(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && !hardLines.has(j)) j++;
    const block = out.slice(i, j);
    const minIndent = block.reduce((min, l) => {
      if (l.trim().length === 0) return min;
      const indent = (l.match(/^[ \t]*/)?.[0] ?? "").length;
      return Math.min(min, indent);
    }, Infinity);
    if (minIndent > 0 && minIndent !== Infinity) {
      for (let k = i; k < j; k++) {
        if (out[k]!.trim().length === 0) continue;
        const indent = (out[k]!.match(/^[ \t]*/)?.[0] ?? "").length;
        out[k] = out[k]!.slice(Math.min(minIndent, indent));
      }
    }
    i = j;
  }
  return out;
}
