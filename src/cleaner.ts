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
]);

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
      const prev = cluster[cluster.length - 1]!;
      // If the previous line in the cluster is a wrap candidate, the NEXT
      // line continues the logical line. We also include that next line
      // in the cluster even if it's short, because it's the terminating
      // (un-wrapped) tail of the paragraph.
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

  return false;
}

function joinCluster(cluster: string[]): string {
  // Join wrapped lines with a single space. If a wrapped line broke
  // mid-word (no trailing space before the break) and the next line starts
  // without a leading space, we still insert a space — it's almost never
  // wrong, and detecting true mid-word breaks vs a word-boundary wrap
  // from the copied buffer is unreliable.
  const cleaned = cluster.map((line, idx) => {
    // Strip trailing whitespace we may have re-introduced accidentally.
    const t = line.replace(/[ \t]+$/, "");
    // Strip a single leading space from continuation lines only.
    return idx === 0 ? t : t.replace(/^[ \t]+/, "");
  });
  return cleaned.join(" ").replace(/ +/g, " ").replace(/[ \t]+$/, "");
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
