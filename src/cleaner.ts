/**
 * Core cleanup logic. Given a chunk of text copied from a terminal plus
 * the terminal's current column width, decide which `\n` characters were
 * inserted by visual wrapping (either by the terminal at its own width
 * or by the application at a fixed column like 80) and rejoin them.
 *
 * Designed to be conservative: when in doubt, leave the line alone. The
 * user should never be surprised by a rewrite in the middle of actual
 * code or a list.
 */

export interface CleanOptions {
  /** The terminal's current column width. Lines that are exactly this long are prime suspects for a soft wrap. */
  terminalColumns?: number;
  /** Extra fixed column width to treat as an application-side hard wrap. Many CLIs emit 80-col output regardless of terminal size. Set to 0 to disable. */
  appWrapColumn?: number;
  /** Minimum consecutive candidate lines required to treat a block as wrapped. Avoids rewriting two-line lists or short dialogue. */
  minWrapLines?: number;
  /** Strip trailing whitespace from every non-empty line. */
  stripTrailingWhitespace?: boolean;
  /** Never rewrap inside ``` fenced blocks. */
  preserveCodeFences?: boolean;
}

export interface CleanResult {
  text: string;
  changed: boolean;
  /** Per-decision log, primarily for debug output. */
  notes: string[];
}

const SENTENCE_TERMINATORS = new Set<string>([
  ".",
  "!",
  "?",
  ":",
  ";",
  ",",
  ")",
  "]",
  "}",
  '"',
  "'",
  "`",
  "|", // markdown table rows
  ">", // closing tags / blockquote terminators
]);

/**
 * Minimum line length for the width-independent wrap detection.
 * Lines shorter than this are never considered wrap candidates based on
 * length alone — a natural short bullet point stays a bullet point.
 */
const MIN_ADAPTIVE_WRAP_LEN = 50;

export function cleanCopiedText(input: string, opts: CleanOptions = {}): CleanResult {
  const notes: string[] = [];
  const terminalColumns = opts.terminalColumns ?? 0;
  const appWrapColumn = opts.appWrapColumn ?? 80;
  const minWrapLines = Math.max(1, opts.minWrapLines ?? 2);
  const stripTrailing = opts.stripTrailingWhitespace ?? true;
  const preserveFences = opts.preserveCodeFences ?? true;

  // Preserve trailing newline exactly as received.
  const endedWithNewline = input.endsWith("\n");
  const body = endedWithNewline ? input.slice(0, -1) : input;

  const rawLines = body.split(/\r?\n/);
  const lines = stripTrailing ? rawLines.map((l) => l.replace(/[ \t]+$/, "")) : rawLines.slice();

  const inFence = preserveFences ? detectFenceRanges(lines) : new Set<number>();

  const out: string[] = [];
  let i = 0;

  // Walk lines, greedily merging wrap clusters.
  while (i < lines.length) {
    if (inFence.has(i)) {
      out.push(lines[i]!);
      i++;
      continue;
    }

    const line = lines[i]!;
    const isCandidate = isWrapCandidate(line, terminalColumns, appWrapColumn);

    if (!isCandidate) {
      out.push(line);
      i++;
      continue;
    }

    // Greedy lookahead: how many consecutive wrap candidates sit here?
    const clusterStart = i;
    const cluster: string[] = [line];
    let j = i + 1;
    while (j < lines.length && !inFence.has(j)) {
      const next = lines[j]!;
      if (!next.trim()) break; // blank line = paragraph break
      // If the next line looks like a new statement (shell command,
      // cmdlet, etc.), don't pull it into the cluster.
      if (looksLikeNewStatement(next)) break;
      const prev = cluster[cluster.length - 1]!;
      if (isWrapCandidate(prev, terminalColumns, appWrapColumn)) {
        cluster.push(next);
        j++;
        // If the line we just added is itself short, the wrap chain ends.
        if (!isWrapCandidate(next, terminalColumns, appWrapColumn)) {
          break;
        }
      } else {
        break;
      }
    }

    // Did we gather enough lines AND a meaningful tail? The tail line
    // should not itself be a wrap candidate (else we may have run off the
    // end of input mid-wrap, which is still joinable but less confident).
    if (cluster.length >= minWrapLines) {
      const joined = joinCluster(cluster);
      out.push(joined);
      notes.push(
        `joined ${cluster.length} lines starting at line ${clusterStart + 1} (terminal=${terminalColumns}, appWrap=${appWrapColumn})`,
      );
      i = j;
    } else {
      // Not enough lines to be confident. Leave the cluster untouched.
      out.push(...cluster);
      i = j;
    }
  }

  let text = out.join("\n");
  if (endedWithNewline) text += "\n";

  const changed = text !== input;
  return { text, changed, notes };
}

function isWrapCandidate(line: string, terminalColumns: number, appWrapColumn: number): boolean {
  if (line.length === 0) return false;
  // If the line ends with a sentence terminator or closing punctuation, it
  // almost certainly isn't a mid-word wrap. Leave alone.
  const last = line[line.length - 1]!;
  if (SENTENCE_TERMINATORS.has(last)) return false;

  // Terminal soft-wrap: line length exactly matches the terminal width.
  if (terminalColumns > 0 && line.length === terminalColumns) return true;

  // App-side fixed-width wrap (e.g. 80-col CLIs).
  if (appWrapColumn > 0 && line.length === appWrapColumn) return true;

  // Near-boundary tolerance: many terminals trim or pad whitespace at the
  // wrap edge. Allow a 1-character slack on BOTH known widths.
  if (terminalColumns > 0 && Math.abs(line.length - terminalColumns) <= 1) {
    // Require the line NOT to end with whitespace (trimmed soft wrap).
    return !/\s$/.test(line);
  }
  if (appWrapColumn > 0 && Math.abs(line.length - appWrapColumn) <= 1) {
    return !/\s$/.test(line);
  }

  // Width-independent fallback: long line that doesn't end with a
  // terminator. This is the catch-all when the terminal's reported
  // dimensions don't match the actual wrap column, which happens more
  // often than it should (late rendering, custom terminal profiles).
  if (line.length >= MIN_ADAPTIVE_WRAP_LEN) return true;

  return false;
}

function joinCluster(cluster: string[]): string {
  // Strip trailing whitespace from every segment. Strip leading whitespace
  // from continuation lines only (index > 0).
  const cleaned = cluster.map((line, idx) => {
    const t = line.replace(/[ \t]+$/, "");
    return idx === 0 ? t : t.replace(/^[ \t]+/, "");
  });
  // Join each boundary with either "" or " " depending on whether the
  // break looks mid-token (URL, decimal, contraction) or word-boundary.
  let out = cleaned[0] ?? "";
  for (let i = 1; i < cleaned.length; i++) {
    const prev = cleaned[i - 1] ?? "";
    const next = cleaned[i] ?? "";
    const sep = joinSeparator(prev, next);
    out += sep + next;
  }
  return out.replace(/[ \t]+$/, "");
}

const CONTINUATION_STARTERS = new Set<string>([
  ".",
  "/",
  ")",
  "]",
  "}",
  "'",
  '"',
  "`",
  ",",
  ";",
  ":",
  "?",
  "!",
  "-",
]);

/**
 * Pick the separator to use when joining a wrapped line to its follow-on.
 * Returns `""` for mid-token continuations (URLs, decimals, contractions)
 * and `" "` for natural word-boundary joins.
 */
function joinSeparator(prev: string, next: string): string {
  if (prev.length === 0 || next.length === 0) return "";
  const lastChar = prev[prev.length - 1]!;
  const firstChar = next[0]!;
  // If either side is already whitespace-adjacent, a space is implicit.
  if (/\s/.test(lastChar) || /\s/.test(firstChar)) return "";
  // If the next line starts with continuation-style punctuation, the
  // break was almost certainly mid-token.
  if (CONTINUATION_STARTERS.has(firstChar)) return "";
  return " ";
}

/**
 * Detect that `line` starts a new logical statement (a new sentence,
 * command, list item, etc.) and therefore should NOT be merged into the
 * preceding cluster.
 */
export function looksLikeNewStatement(line: string): boolean {
  const trimmed = line.replace(/^\s+/, "");
  if (!trimmed) return false;
  // PowerShell-style Verb-Noun cmdlet: "Invoke-WebRequest", "Get-ChildItem"
  if (/^[A-Z][a-z]+-[A-Z]/.test(trimmed)) return true;
  // Common shell commands at the start of a line.
  if (/^(sudo|npm|yarn|pnpm|node|deno|bun|python|pip|cargo|go|rustc|make|cmake|code|git|docker|podman|kubectl|helm|ssh|scp|rsync|curl|wget|http|cd|ls|rm|cp|mv|mkdir|touch|cat|tail|head|grep|awk|sed|find|xargs|brew|apt|dnf|yum|zypper|pacman|systemctl|journalctl|ps|kill|top|htop|tmux|screen|vim|nvim|emacs|nano|less|more|tar|unzip|zip|chmod|chown|export|source|echo|printf|ollama|claude|pytest|vitest|jest)\s/.test(trimmed)) return true;
  // REPL or prompt continuation markers.
  if (/^(\$|PS |> )/.test(trimmed) && trimmed !== ">") return true;
  return false;
}

/** Return the set of line indices that sit inside ``` fenced blocks. */
function detectFenceRanges(lines: string[]): Set<number> {
  const inside = new Set<number>();
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      // The fence lines themselves are counted as "inside" so we preserve them verbatim too.
      inside.add(i);
      open = !open;
      continue;
    }
    if (open) inside.add(i);
  }
  return inside;
}
