import { diff } from "fast-myers-diff";

/**
 * Minimal unified diff implementation using fast-myers-diff.
 * Computes a line-based diff between two strings and returns a compact representation.
 */

export interface DiffResult {
  /** Unified diff string */
  diff: string;
  /** Number of lines changed (added + removed) */
  linesChanged: number;
  /** Whether there are any changes */
  hasChanges: boolean;
  /** Line numbers in the NEW file that were added or modified */
  changedNewLines: Set<number>;
}

export function computeDiff(oldContent: string, newContent: string, filePath: string): DiffResult {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  const changes = diff(oldLines, newLines);

  const rawLines: Array<{ type: "keep" | "add" | "remove"; line: string; oldLine: number; newLine: number }> = [];
  let oldPos = 0;
  let newPos = 0;
  let linesChanged = 0;
  const changedNewLines = new Set<number>();

  for (const [sx, ex, sy, ey] of changes) {
    // Unchanged lines before this change
    while (oldPos < sx) {
      rawLines.push({
        type: "keep",
        line: oldLines[oldPos],
        oldLine: oldPos + 1,
        newLine: newPos + 1,
      });
      oldPos++;
      newPos++;
    }

    // Removed lines
    for (let i = sx; i < ex; i++) {
      rawLines.push({
        type: "remove",
        line: oldLines[i],
        oldLine: i + 1,
        newLine: newPos + 1, // Points to next available line in new file
      });
      // For removals, mark the adjacent new line as potentially affecting context
      changedNewLines.add(newPos + 1);
      linesChanged++;
    }
    oldPos = ex;

    // Added lines
    for (let i = sy; i < ey; i++) {
      rawLines.push({
        type: "add",
        line: newLines[i],
        oldLine: oldPos + 1, // Points to next available line in old file
        newLine: i + 1,
      });
      changedNewLines.add(i + 1);
      linesChanged++;
    }
    newPos = ey;
  }

  // Remaining unchanged lines
  while (oldPos < oldLines.length) {
    rawLines.push({
      type: "keep",
      line: oldLines[oldPos],
      oldLine: oldPos + 1,
      newLine: newPos + 1,
    });
    oldPos++;
    newPos++;
  }

  if (linesChanged === 0) {
    return { diff: "", linesChanged: 0, hasChanges: false, changedNewLines };
  }

  // Group into hunks with 3 lines of context
  const CONTEXT = 3;
  const hunks: string[] = [];
  const hunkGroups: typeof rawLines[] = [];
  let currentHunk: typeof rawLines = [];
  let lastChangeIdx = -999;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.type !== "keep") {
      // If this change is far from the last, start a new hunk
      if (i - lastChangeIdx > CONTEXT * 2 + 1 && currentHunk.length > 0) {
        hunkGroups.push(currentHunk);
        currentHunk = [];
        // Add leading context
        for (let c = Math.max(0, i - CONTEXT); c < i; c++) {
          currentHunk.push(rawLines[c]);
        }
      } else if (currentHunk.length === 0) {
        // First hunk, add leading context
        for (let c = Math.max(0, i - CONTEXT); c < i; c++) {
          currentHunk.push(rawLines[c]);
        }
      }
      // Add all lines between last change context end and this change
      const contextEnd = lastChangeIdx + CONTEXT + 1;
      for (let c = Math.max(contextEnd, currentHunk.length > 0 ? i : 0); c < i; c++) {
        if (!currentHunk.includes(rawLines[c])) {
          currentHunk.push(rawLines[c]);
        }
      }
      currentHunk.push(line);
      lastChangeIdx = i;
    } else if (i - lastChangeIdx <= CONTEXT && currentHunk.length > 0) {
      currentHunk.push(line);
    }
  }
  if (currentHunk.length > 0) {
    hunkGroups.push(currentHunk);
  }

  // Format hunks
  for (const hunk of hunkGroups) {
    if (hunk.length === 0) continue;
    const firstLine = hunk[0];
    const lastLine = hunk[hunk.length - 1];
    
    // Calculate hunk header ranges
    // Old range: start line and count
    const oldStart = firstLine.oldLine;
    let oldCount = 0;
    let newCount = 0;
    
    for (const line of hunk) {
      if (line.type !== "add") oldCount++;
      if (line.type !== "remove") newCount++;
    }
    
    const newStart = firstLine.newLine;

    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const line of hunk) {
      const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
      hunks.push(`${prefix}${line.line}`);
    }
  }

  const header = `--- a/${filePath}\n+++ b/${filePath}`;
  return {
    diff: `${header}\n${hunks.join("\n")}`,
    linesChanged,
    hasChanges: true,
    changedNewLines,
  };
}

