# Cachebro Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Overhaul cachebro with post-compaction recovery, per-response savings reporting, bug fixes, watcher activation, MCP resources, response optimization, and rich terminal output.

**Architecture:** The changes span the SDK (`packages/sdk/src/`) and CLI (`packages/cli/src/`). New hook scripts are added for SessionStart and Stop events. The MCP server gains 3 new tools, 3 resources, and in-memory delta tracking. Schema migrations become non-destructive.

**Tech Stack:** TypeScript, better-sqlite3, FTS5, Bun, @modelcontextprotocol/sdk, chokidar, ANSI escape codes

---

### Task 1: Dead Dependency Cleanup & Version Sync

**Files:**
- Modify: `package.json`
- Delete: `test/check_fts5.ts`
- Modify: `packages/cli/src/mcp.ts:141` (version string)

**Step 1: Remove dead dependency from package.json**

In `package.json`, remove `"@tursodatabase/database"` from `dependencies`. Also remove it from the `build` script's `--external` flags.

Before (`package.json` build script):
```
"build": "bun build packages/cli/src/index.ts --target node --external @tursodatabase/database --external @modelcontextprotocol/sdk --external zod --external better-sqlite3 --outfile dist/cli.mjs ...
```

After:
```
"build": "bun build packages/cli/src/index.ts --target node --external @modelcontextprotocol/sdk --external zod --external better-sqlite3 --outfile dist/cli.mjs ...
```

Remove from dependencies:
```json
// DELETE this line:
"@tursodatabase/database": "^0.4.4",
```

**Step 2: Delete test/check_fts5.ts**

This file imports `@tursodatabase/database` which we just removed. Delete it entirely.

**Step 3: Sync version numbers**

All three locations must say `"0.3.0"` (bump minor for new features):

1. `package.json` root: `"version": "0.3.0"`
2. `packages/cli/package.json`: confirm or set `"version": "0.3.0"` (read file first to check)
3. `packages/cli/src/mcp.ts` line ~141: change `version: "0.2.1"` to `version: "0.3.0"`

**Step 4: Run build to verify nothing breaks**

Run: `bun run build`
Expected: Build succeeds, produces `dist/cli.mjs`

**Step 5: Run tests**

Run: `bun test/smoke.ts`
Expected: "All tests passed!"

**Step 6: Commit**

```bash
git add package.json test/check_fts5.ts packages/cli/src/mcp.ts packages/cli/package.json
git commit -m "Remove dead @tursodatabase/database dep, sync versions to 0.3.0"
```

---

### Task 2: Non-Destructive Schema Migration

**Files:**
- Modify: `packages/sdk/src/cache.ts` (the `init()` method, lines ~130-155)

**Step 1: Write a test for schema migration survival**

Add to `test/smoke.ts` before the cleanup section — a test that creates a DB at version 6, inserts data, then re-inits with the new code and verifies data survived:

```typescript
// Test 10: Schema migration preserves data
console.log("\n--- Test 10: Non-destructive schema migration ---");
const MIGRATION_DIR = join(TEST_DIR, "migration_test");
mkdirSync(MIGRATION_DIR, { recursive: true });
const migrationDbPath = join(MIGRATION_DIR, "migrate.db");
const migrationFile = join(MIGRATION_DIR, "test.ts");
writeFileSync(migrationFile, "const x = 1;\n");

// Create a session, read a file (populates file_versions)
const { cache: mCache1 } = createCache({ dbPath: migrationDbPath, sessionId: "migrate-1" });
await mCache1.init();
await mCache1.readFile(migrationFile);
const statsBefore = await mCache1.getStats();
console.log(`  Files before migration: ${statsBefore.filesTracked}`);
console.assert(statsBefore.filesTracked >= 1, "Should have at least 1 file tracked");
await mCache1.close();

// Re-init same DB (simulates upgrade — init() should preserve data)
const { cache: mCache2 } = createCache({ dbPath: migrationDbPath, sessionId: "migrate-2" });
await mCache2.init();
const statsAfter = await mCache2.getStats();
console.log(`  Files after migration: ${statsAfter.filesTracked}`);
console.assert(statsAfter.filesTracked >= 1, "Files should survive migration");
await mCache2.close();
rmSync(MIGRATION_DIR, { recursive: true, force: true });
```

**Step 2: Run test to verify it fails**

Run: `bun test/smoke.ts`
Expected: Currently PASSES because version hasn't changed. That's OK — we're establishing baseline.

**Step 3: Replace destructive migration with incremental approach**

In `packages/sdk/src/cache.ts`, replace the `init()` method's migration logic. Find:

```typescript
const version = db.pragma("user_version", { simple: true }) as number;

if (version < CURRENT_SCHEMA_VERSION) {
  const tables = ["file_versions", "session_reads", "session_events", "session_metrics", "stats", "session_stats", "file_content_fts", "indexed_files"];
  for (const table of tables) db.exec(`DROP TABLE IF EXISTS ${table}`);
  db.exec(SCHEMA);
  db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
} else {
  db.exec(SCHEMA);
}
```

Replace with:

```typescript
const version = db.pragma("user_version", { simple: true }) as number;

if (version === 0) {
  // Fresh database — create all tables
  db.exec(SCHEMA);
  db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
} else if (version < CURRENT_SCHEMA_VERSION) {
  // Existing database — run incremental migrations
  // Ensure base tables exist (CREATE IF NOT EXISTS is safe)
  db.exec(SCHEMA);
  // Run any version-specific migrations
  for (let v = version + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
    const migrations = SCHEMA_MIGRATIONS[v];
    if (migrations) {
      for (const sql of migrations) {
        try { db.exec(sql); } catch (e: any) {
          // Ignore "duplicate column" errors from re-running migrations
          if (!e.message?.includes("duplicate column")) throw e;
        }
      }
    }
  }
  db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
} else {
  // Same version — just ensure tables exist
  db.exec(SCHEMA);
}
```

Add the migrations map above the `CacheStore` class:

```typescript
const SCHEMA_MIGRATIONS: Record<number, string[]> = {
  // Version 7+ migrations go here. Example:
  // 7: ["ALTER TABLE session_metrics ADD COLUMN last_reported_saved INTEGER DEFAULT 0"],
};
```

**Step 4: Run tests**

Run: `bun test/smoke.ts`
Expected: "All tests passed!" — including Test 10

**Step 5: Commit**

```bash
git add packages/sdk/src/cache.ts test/smoke.ts
git commit -m "Replace destructive schema migration with incremental approach"
```

---

### Task 3: Register Missing MCP Tools (revert_file, get_working_set, search_history)

**Files:**
- Modify: `packages/cli/src/mcp.ts` (add 3 `server.tool()` blocks after existing tools)

**Step 1: Add `revert_file` tool registration**

After the `cache_clear` tool block in `mcp.ts`, add:

```typescript
server.tool(
  "revert_file",
  "Revert a file to a previous version from the cache. Use when an edit introduces a regression.",
  {
    path: z.string().describe("Path to the file to revert"),
    steps_back: z.number().optional().default(1).describe("How many versions to go back (default: 1)"),
  },
  async ({ path, steps_back }) => {
    isBusy = true;
    try {
      const result = await cache.revertFile(path, steps_back);
      return { content: [{ type: "text" as const, text: result.message }], isError: !result.success };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    } finally {
      isBusy = false;
    }
  },
);
```

**Step 2: Add `get_working_set` tool registration**

```typescript
server.tool(
  "get_working_set",
  "List all files touched in this session with edit counts and status. Useful after context compaction to recover awareness of what you were working on.",
  {},
  async () => {
    isBusy = true;
    try {
      const files = await cache.getWorkingSet();
      if (files.length === 0) return { content: [{ type: "text" as const, text: "No files in working set yet." }] };
      let text = `Working set (${files.length} files):\n`;
      for (const f of files) {
        text += `  ${f.status === "modified" ? "M" : "R"}  ${f.path}${f.edits > 0 ? ` (${f.edits} edits)` : ""}\n`;
      }
      return { content: [{ type: "text" as const, text }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    } finally {
      isBusy = false;
    }
  },
);
```

**Step 3: Add `search_history` tool registration**

```typescript
server.tool(
  "search_history",
  "View chronological log of file reads and writes in this session. Optionally filter by path substring.",
  {
    limit: z.number().optional().default(50).describe("Max entries to return"),
    path_filter: z.string().optional().describe("Filter entries by path substring"),
  },
  async ({ limit, path_filter }) => {
    isBusy = true;
    try {
      const entries = await cache.getHistory(limit, path_filter);
      if (entries.length === 0) return { content: [{ type: "text" as const, text: "No history entries yet." }] };
      let text = `Session history (${entries.length} entries):\n`;
      for (const e of entries) {
        const time = new Date(e.timestamp).toISOString().slice(11, 19);
        text += `  [${time}] ${e.type.padEnd(5)} ${e.path}\n`;
      }
      return { content: [{ type: "text" as const, text }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    } finally {
      isBusy = false;
    }
  },
);
```

**Step 4: Build and verify**

Run: `bun run build`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add packages/cli/src/mcp.ts
git commit -m "Register revert_file, get_working_set, search_history MCP tools"
```

---

### Task 4: Fix grep/search Filter Params

**Files:**
- Modify: `packages/sdk/src/cache.ts` (`searchContent` method, around line ~380)
- Modify: `packages/cli/src/mcp.ts` (`handleSearch` function)

**Step 1: Update `searchContent` to accept filter options**

In `packages/sdk/src/cache.ts`, change the `searchContent` signature and add post-query filtering:

```typescript
async searchContent(query: string, options?: {
  limit?: number;
  path?: string;
  include?: string;
  exclude?: string;
  caseSensitive?: boolean;
}): Promise<any> {
  await this.init();
  if (!this.searchEnabled) throw new Error("Search is disabled (FTS5 not found).");
  const limit = options?.limit ?? 20;
  // Fetch more results than needed since we filter post-query
  const fetchLimit = limit * 3;
  return this.withDb((db) => {
    const rows = db.prepare(
      "SELECT path, snippet(file_content_fts, 2, '[MATCH]', '[/MATCH]', '...', 10) as context FROM file_content_fts WHERE file_content_fts MATCH ? ORDER BY rank LIMIT ?"
    ).all(query, fetchLimit) as any[];

    let filtered = rows;

    // Path prefix filter
    if (options?.path && options.path !== ".") {
      const { resolve } = require("path");
      const absPrefix = resolve(options.path);
      filtered = filtered.filter(r => r.path.startsWith(absPrefix));
    }

    // Include glob filter
    if (options?.include) {
      const ig = ignore().add(options.include);
      const { relative } = require("path");
      const cwd = process.cwd();
      filtered = filtered.filter(r => {
        const rel = relative(cwd, r.path);
        return ig.ignores(rel);
      });
    }

    // Exclude glob filter
    if (options?.exclude) {
      const ig = ignore().add(options.exclude);
      const { relative } = require("path");
      const cwd = process.cwd();
      filtered = filtered.filter(r => {
        const rel = relative(cwd, r.path);
        return !ig.ignores(rel);
      });
    }

    // Case-sensitive post-filter on match context
    if (options?.caseSensitive) {
      filtered = filtered.filter(r => r.context.includes(query));
    }

    return {
      matches: filtered.slice(0, limit).map(r => ({ path: r.path, context: r.context })),
      query,
    };
  });
}
```

**NOTE:** The `ignore` library is already imported at the top of `cache.ts`. The `require("path")` calls should be replaced with the already-imported `resolve`/`relative` via dynamic import or top-level import — match the existing pattern in the file (which uses `await import("path")`). Since `searchContent` runs inside `withDb` which is sync context, use `require("path")` or restructure slightly.

Actually, better approach: resolve the path BEFORE entering `withDb`:

```typescript
async searchContent(query: string, options?: {
  limit?: number;
  path?: string;
  include?: string;
  exclude?: string;
  caseSensitive?: boolean;
}): Promise<any> {
  await this.init();
  if (!this.searchEnabled) throw new Error("Search is disabled (FTS5 not found).");
  const limit = options?.limit ?? 20;
  const fetchLimit = limit * 3;

  const { resolve, relative } = await import("path");
  const absPrefix = options?.path && options.path !== "." ? resolve(options.path) : null;
  const cwd = process.cwd();

  const includeIg = options?.include ? ignore().add(options.include) : null;
  const excludeIg = options?.exclude ? ignore().add(options.exclude) : null;

  return this.withDb((db) => {
    const rows = db.prepare(
      "SELECT path, snippet(file_content_fts, 2, '[MATCH]', '[/MATCH]', '...', 10) as context FROM file_content_fts WHERE file_content_fts MATCH ? ORDER BY rank LIMIT ?"
    ).all(query, fetchLimit) as any[];

    let filtered = rows;

    if (absPrefix) {
      filtered = filtered.filter(r => r.path.startsWith(absPrefix));
    }
    if (includeIg) {
      filtered = filtered.filter(r => {
        const rel = relative(cwd, r.path);
        return includeIg.ignores(rel);
      });
    }
    if (excludeIg) {
      filtered = filtered.filter(r => {
        const rel = relative(cwd, r.path);
        return !excludeIg.ignores(rel);
      });
    }
    if (options?.caseSensitive) {
      filtered = filtered.filter(r => r.context.includes(query));
    }

    return {
      matches: filtered.slice(0, limit).map(r => ({ path: r.path, context: r.context })),
      query,
    };
  });
}
```

**Step 2: Update `handleSearch` in mcp.ts to pass filter options**

In `packages/cli/src/mcp.ts`, change `handleSearch`:

```typescript
const handleSearch = async ({ pattern, path, include, exclude, case_sensitive, limit }: {
  pattern: string;
  path?: string;
  include?: string;
  exclude?: string;
  case_sensitive?: boolean;
  limit?: number;
}) => {
  isBusy = true;
  try {
    const result = await cache.searchContent(pattern, {
      limit: limit ?? 20,
      path: path,
      include: include,
      exclude: exclude,
      caseSensitive: case_sensitive,
    });
    if (result.matches.length === 0) return { content: [{ type: "text" as const, text: "No matches found." }] };
    let text = `[cachebro search results for "${pattern}"]\n\n`;
    for (const m of result.matches) text += `--- ${m.path} ---\n${m.context}\n\n`;
    const tokensUsed = Math.ceil(text.length * 0.75);
    await cache.trackToolUsage("search/grep", tokensUsed);
    return { content: [{ type: "text" as const, text }] };
  } catch (e: any) {
    return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
  } finally {
    isBusy = false;
    await persistStats();
  }
};
```

**Step 3: Build and verify**

Run: `bun run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add packages/sdk/src/cache.ts packages/cli/src/mcp.ts
git commit -m "Fix grep/search to use path, include, exclude, case_sensitive params"
```

---

### Task 5: Activate File Watcher in MCP Server

**Files:**
- Modify: `packages/cli/src/mcp.ts` (the `createCache()` call, around line ~115)

**Step 1: Pass watchPaths and ignorePatterns to createCache**

Find the `createCache` call in `startMcpServer()`:

```typescript
const { cache, watcher } = createCache({
  dbPath,
  sessionId,
  ignorePatterns,
});
```

Replace with:

```typescript
const { cache, watcher } = createCache({
  dbPath,
  sessionId,
  ignorePatterns,
  watchPaths: [cwd],
});
```

This is a one-line change. `cwd` is already defined earlier in the function as `process.cwd()`. The `createCache` function already checks `config.watchPaths?.length > 0` and calls `watcher.watch()` — see `packages/sdk/src/index.ts:14-16`.

**Step 2: Build and verify**

Run: `bun run build`
Expected: Build succeeds

**Step 3: Run smoke tests**

Run: `bun test/smoke.ts`
Expected: "All tests passed!"

**Step 4: Commit**

```bash
git add packages/cli/src/mcp.ts
git commit -m "Activate file watcher in MCP server for real-time FTS updates"
```

---

### Task 6: Response Optimization (Shorter Labels, Diff Truncation)

**Files:**
- Modify: `packages/sdk/src/cache.ts` (readFile method's unchanged labels + diff handling)

**Step 1: Shorten unchanged labels**

In `packages/sdk/src/cache.ts`, find the two unchanged label constructions in `readFile()`:

Partial read label (find):
```typescript
const label = isPartial ? `[cachebro: unchanged on branch ${branch}, lines ${(options?.offset ?? 1)}-${(options?.limit ? (options.offset ?? 1) + options.limit - 1 : currentLines)} of ${currentLines}, ${originalTokens} tokens saved]` : `[cachebro: unchanged on branch ${branch}, ${currentLines} lines, ${originalTokens} tokens saved]`;
```

Replace with:
```typescript
const savedLabel = originalTokens >= 1000 ? `~${(originalTokens / 1000).toFixed(1)}k` : `~${originalTokens}`;
const label = isPartial
  ? `[unchanged · lines ${(options?.offset ?? 1)}-${(options?.limit ? (options.offset ?? 1) + options.limit - 1 : currentLines)} of ${currentLines} · ${savedLabel} saved]`
  : `[unchanged · ${currentLines} lines · ${savedLabel} saved]`;
```

**Step 2: Add diff truncation**

After computing the diff in `readFile()`, add truncation. Find:

```typescript
if (diffResult.hasChanges) {
  const actualContent = isPartial ? sliceLines(currentContent) : diffResult.diff;
  this.addMetrics(db, toolName, originalTokens, estimateTokens(actualContent), branch);
  return { cached: true, content: actualContent, diff: diffResult.diff, hash: currentHash, linesChanged: diffResult.linesChanged, totalLines: currentLines };
}
```

Replace with:
```typescript
if (diffResult.hasChanges) {
  let diffOutput = diffResult.diff;
  const diffLines = diffOutput.split("\n");
  const MAX_DIFF_LINES = 200;
  if (diffLines.length > MAX_DIFF_LINES) {
    diffOutput = diffLines.slice(0, MAX_DIFF_LINES).join("\n") + `\n[... diff truncated at ${MAX_DIFF_LINES} lines. File has ${diffResult.linesChanged} total changes.]`;
  }
  const actualContent = isPartial ? sliceLines(currentContent) : diffOutput;
  this.addMetrics(db, toolName, originalTokens, estimateTokens(actualContent), branch);
  return { cached: true, content: actualContent, diff: diffOutput, hash: currentHash, linesChanged: diffResult.linesChanged, totalLines: currentLines };
}
```

**Step 3: Shorten directory unchanged label too**

In `listDirectory()`, find:
```typescript
const label = `[cachebro: unchanged, ${files.length} items]`;
```

Replace with:
```typescript
const savedLabel = originalTokens >= 1000 ? `~${(originalTokens / 1000).toFixed(1)}k` : `~${originalTokens}`;
const label = `[unchanged · ${files.length} items · ${savedLabel} saved]`;
```

**Step 4: Run tests**

Run: `bun test/smoke.ts`
Expected: "All tests passed!" — Test 7 checks for "unchanged" in content, the new label still contains "unchanged"

**Step 5: Commit**

```bash
git add packages/sdk/src/cache.ts
git commit -m "Shorten unchanged labels and add 200-line diff truncation"
```

---

### Task 7: SessionStart Hook (Post-Compaction Recovery)

**Files:**
- Create: `scripts/cachebro-session-start.ts`
- Modify: `packages/cli/src/index.ts` (add `on-session-start` command + update `init` to register hook)

**Step 1: Create the SessionStart hook script**

Create `scripts/cachebro-session-start.ts`:

```typescript
#!/usr/bin/env bun
/**
 * SessionStart hook for Claude Code.
 * Reads stdin JSON with { session_id, cwd }, outputs additionalContext
 * with the working set and metrics from the last session.
 */
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

try {
  const input = JSON.parse(await new Promise<string>((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(data));
  }));

  const cwd = input.cwd || process.cwd();
  const cacheDir = resolve(cwd, process.env.CACHEBRO_DIR ?? ".cachebro");
  const statsFile = join(cacheDir, "last-session.json");

  if (!existsSync(statsFile)) {
    // No prior session — output nothing
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  const data = JSON.parse(readFileSync(statsFile, "utf-8"));
  const { metrics, branch } = data;

  if (!metrics?.tools?.length) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  let context = `## cachebro session state\nBranch: ${branch}\n\n`;

  // Try to read working set from DB
  try {
    const { createCache } = await import("@turso/cachebro");
    const dbPath = join(cacheDir, "cache.db");
    if (existsSync(dbPath)) {
      const { cache } = createCache({ dbPath, sessionId: data.sessionId || "recovery" });
      await cache.init();
      const workingSet = await cache.getWorkingSet();
      const modified = workingSet.filter(f => f.status === "modified");
      const readOnly = workingSet.filter(f => f.status === "read");

      if (modified.length > 0) {
        context += `### Working set (${modified.length} files modified)\n`;
        for (const f of modified) {
          context += `- ${f.path} (${f.edits} edits)\n`;
        }
        context += "\n";
      }
      if (readOnly.length > 0 && readOnly.length <= 10) {
        context += `### Recently read (${readOnly.length} files)\n`;
        for (const f of readOnly.slice(0, 10)) {
          context += `- ${f.path}\n`;
        }
        context += "\n";
      }
      await cache.close();
    }
  } catch {
    // DB access failed — just report metrics
  }

  context += `### Session metrics\n`;
  context += `~${metrics.totalSaved.toLocaleString()} tokens saved so far (${metrics.percentSaved.toFixed(1)}%)\n\n`;
  context += `All files are cached. Re-reads will return diffs or unchanged markers.`;

  console.log(JSON.stringify({ additionalContext: context }));
} catch {
  // On any error, output nothing — don't break session start
  console.log(JSON.stringify({}));
}
process.exit(0);
```

**Step 2: Add `on-session-start` CLI command**

In `packages/cli/src/index.ts`, add a new `else if` block for `on-session-start` after the `on-session-end` block. This command is the hook entry point:

```typescript
} else if (command === "on-session-start") {
  // Reads stdin, outputs additionalContext JSON for Claude Code SessionStart hook
  const { existsSync, readFileSync } = await import("fs");
  const { join, resolve } = await import("path");

  let input: any = {};
  try {
    const data = await new Promise<string>((res) => {
      let d = "";
      process.stdin.on("data", (c: Buffer) => d += c.toString());
      process.stdin.on("end", () => res(d));
      setTimeout(() => res(d), 3000); // timeout after 3s
    });
    input = JSON.parse(data);
  } catch {}

  const cwd = input.cwd || process.cwd();
  const cacheDir = resolve(cwd, process.env.CACHEBRO_DIR ?? ".cachebro");
  const statsFile = join(cacheDir, "last-session.json");

  if (!existsSync(statsFile)) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  try {
    const data = JSON.parse(readFileSync(statsFile, "utf-8"));
    const { metrics, branch, sessionId: prevSessionId } = data;

    if (!metrics?.tools?.length) {
      console.log(JSON.stringify({}));
      process.exit(0);
    }

    let context = `## cachebro session state\nBranch: ${branch}\n\n`;

    // Try working set from DB
    try {
      const { createCache } = await import("@turso/cachebro");
      const dbPath = join(cacheDir, "cache.db");
      if (existsSync(dbPath)) {
        const { cache } = createCache({ dbPath, sessionId: prevSessionId || "recovery" });
        await cache.init();
        const workingSet = await cache.getWorkingSet();
        const modified = workingSet.filter((f: any) => f.status === "modified");
        if (modified.length > 0) {
          context += `### Working set (${modified.length} files modified)\n`;
          for (const f of modified) context += `- ${f.path} (${f.edits} edits)\n`;
          context += "\n";
        }
        await cache.close();
      }
    } catch {}

    context += `### Session metrics\n`;
    context += `~${metrics.totalSaved.toLocaleString()} tokens saved (${metrics.percentSaved.toFixed(1)}%)\n\n`;
    context += `All files are cached. Re-reads will return diffs or unchanged markers.`;

    console.log(JSON.stringify({ additionalContext: context }));
  } catch {
    console.log(JSON.stringify({}));
  }
  process.exit(0);
```

**Step 3: Update `init` command to register SessionStart hook**

In the `init` command section of `packages/cli/src/index.ts`, find the hook registration block. After the `SessionEnd` hook registration, add SessionStart:

```typescript
settings.hooks.SessionStart = settings.hooks.SessionStart ?? [];
if (!hasHook("SessionStart", "cachebro on-session-start")) {
  settings.hooks.SessionStart.push({ hooks: [{ type: "command", command: `${cachebroBin} on-session-start`, timeout: 10 }] });
}
```

Also update the `uninit` command to remove SessionStart hooks — add `"SessionStart"` to the loop:
```typescript
for (const key of ["PreToolUse", "PostToolUse", "Stop", "SessionEnd", "SessionStart"]) {
```

**Step 4: Update help text**

In the `help` command, add:
```
  cachebro on-session-start  Inject session state into Claude Code context (hook)
```

**Step 5: Build and verify**

Run: `bun run build`
Expected: Build succeeds

**Step 6: Commit**

```bash
git add scripts/cachebro-session-start.ts packages/cli/src/index.ts
git commit -m "Add SessionStart hook for post-compaction recovery"
```

---

### Task 8: Per-Response Stop Hook with Delta Reporting

**Files:**
- Modify: `packages/cli/src/index.ts` (add `on-stop` command)
- Modify: `packages/cli/src/index.ts` (update `init` to use `on-stop` instead of `on-session-end` for Stop hook)

**Step 1: Add ANSI color helpers**

At the top of `packages/cli/src/index.ts`, after the imports, add:

```typescript
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
};
```

**Step 2: Add `on-stop` CLI command**

Add a new command handler for `on-stop`:

```typescript
} else if (command === "on-stop") {
  const { existsSync, readFileSync, writeFileSync } = await import("fs");
  const { resolve, join } = await import("path");

  const cacheDir = resolve(process.env.CACHEBRO_DIR ?? ".cachebro");
  const statsFile = join(cacheDir, "last-session.json");
  const lastReportedFile = join(cacheDir, "last-reported.json");

  if (!existsSync(statsFile)) process.exit(0);

  try {
    const data = JSON.parse(readFileSync(statsFile, "utf-8"));
    const { metrics, branch } = data;
    if (!metrics?.tools?.length) process.exit(0);

    // Read last reported totals
    let lastReported = { totalSaved: 0, totalCalls: 0 };
    if (existsSync(lastReportedFile)) {
      try { lastReported = JSON.parse(readFileSync(lastReportedFile, "utf-8")); } catch {}
    }

    const deltaSaved = metrics.totalSaved - (lastReported.totalSaved || 0);
    const totalCalls = metrics.tools.reduce((s: number, t: any) => s + t.calls, 0);
    const deltaCalls = totalCalls - (lastReported.totalCalls || 0);

    // Count cached reads and diffs from delta (approximate from tool breakdown)
    const savedStr = deltaSaved >= 1000 ? `~${(deltaSaved / 1000).toFixed(1)}k` : `~${deltaSaved}`;
    const colorSaved = deltaSaved > 0 ? C.green : C.gray;

    let line = ` ${C.cyan}${C.bold}cachebro${C.reset}  ${colorSaved}${savedStr} tokens saved${C.reset}`;
    if (deltaCalls > 0) line += ` ${C.dim}· ${deltaCalls} calls${C.reset}`;
    line += ` ${C.dim}· ${branch}${C.reset}`;

    try {
      const { openSync, writeSync, closeSync } = await import("fs");
      const fd = openSync("/dev/tty", "w");
      writeSync(fd, line + "\n");
      closeSync(fd);
    } catch {
      process.stderr.write(line + "\n");
    }

    // Update last reported
    writeFileSync(lastReportedFile, JSON.stringify({ totalSaved: metrics.totalSaved, totalCalls }));
  } catch {}
  process.exit(0);
```

**Step 3: Update `init` to use `on-stop` for Stop hook**

In the `init` command, change the Stop hook to use `on-stop` instead of `on-session-end`:

Find:
```typescript
settings.hooks.Stop = settings.hooks.Stop ?? [];
if (!hasHook("Stop", "cachebro on-session-end")) {
  settings.hooks.Stop.push({ hooks: [{ type: "command", command: `${cachebroBin} on-session-end`, timeout: 5 }] });
}
```

Replace with:
```typescript
settings.hooks.Stop = settings.hooks.Stop ?? [];
if (!hasHook("Stop", "cachebro on-stop") && !hasHook("Stop", "cachebro on-session-end")) {
  settings.hooks.Stop.push({ hooks: [{ type: "command", command: `${cachebroBin} on-stop`, timeout: 5 }] });
}
```

Keep SessionEnd using `on-session-end` (that's the full summary).

**Step 4: Update help text**

Add to the help command:
```
  cachebro on-stop           Show per-response savings (used by Stop hook)
```

**Step 5: Build and verify**

Run: `bun run build`
Expected: Build succeeds

**Step 6: Commit**

```bash
git add packages/cli/src/index.ts
git commit -m "Add per-response Stop hook with colored delta savings reporting"
```

---

### Task 9: Improved Session-End Report with Rich Terminal Output

**Files:**
- Modify: `packages/cli/src/index.ts` (`on-session-end` command)

**Step 1: Update the session-end output with ANSI colors**

Replace the `on-session-end` handler's output formatting. Find the section that builds the `out` string:

Replace the entire output formatting block with:

```typescript
const bar = `${C.dim}${"─".repeat(50)}${C.reset}`;
let out = `\n${bar}\n`;
out += ` ${C.cyan}${C.bold}cachebro${C.reset}  ${C.dim}·  session complete  ·  ${branch}${C.reset}\n`;
out += `${bar}\n`;
for (const t of (metrics?.tools ?? [])) {
  const label = t.tool.padEnd(20);
  const calls = `${t.calls}x`.padStart(4);
  const savedNum = t.tokensSaved >= 1000 ? `~${(t.tokensSaved / 1000).toFixed(1)}k` : `~${t.tokensSaved}`;
  const saved = `${savedNum} tokens saved`.padStart(24);
  out += `  ${label}${calls}  →  ${C.green}${saved}${C.reset}\n`;
}
out += `${bar}\n`;
if (hasMetrics) {
  const totalStr = metrics.totalSaved >= 1000 ? `~${(metrics.totalSaved / 1000).toFixed(1)}k` : `~${metrics.totalSaved}`;
  out += `  ${C.bold}${C.green}Total: ${totalStr} tokens saved  (${metrics.percentSaved.toFixed(1)}%)${C.reset}\n`;
  out += `${bar}\n`;
}
```

Note: The `C` color constants must be accessible here — they should be defined at the top of the file as described in Task 8 Step 1.

**Step 2: Build and verify**

Run: `bun run build`
Expected: Build succeeds

**Step 3: Test manually**

Run: `node dist/cli.mjs on-session-end`
Expected: Either exits silently (no last-session.json) or displays the colored report

**Step 4: Commit**

```bash
git add packages/cli/src/index.ts
git commit -m "Add ANSI colored output to session-end report"
```

---

### Task 10: MCP Resources

**Files:**
- Modify: `packages/cli/src/mcp.ts` (add resource registrations before `server.connect()`)

**Step 1: Add MCP resource registrations**

Before the `const transport = new StdioServerTransport();` line in `mcp.ts`, add:

```typescript
// MCP Resources
server.resource(
  "cachebro://status",
  "cachebro://status",
  "Session status: files tracked, tokens saved",
  "text/plain",
  async () => {
    const stats = await cache.getStats();
    const branch = getCurrentBranch();
    return {
      contents: [{
        uri: "cachebro://status",
        text: `cachebro status (${branch}):\n  Files tracked: ${stats.filesTracked}\n  Session tokens saved: ~${stats.sessionTokensSaved.toLocaleString()}\n  Total tokens saved: ~${stats.tokensSaved.toLocaleString()}`,
      }],
    };
  },
);

server.resource(
  "cachebro://working-set",
  "cachebro://working-set",
  "Current working set with edit counts",
  "text/plain",
  async () => {
    const files = await cache.getWorkingSet();
    let text = `Working set (${files.length} files):\n`;
    for (const f of files) {
      text += `  ${f.status === "modified" ? "M" : "R"}  ${f.path}${f.edits > 0 ? ` (${f.edits} edits)` : ""}\n`;
    }
    return { contents: [{ uri: "cachebro://working-set", text }] };
  },
);

server.resource(
  "cachebro://metrics",
  "cachebro://metrics",
  "Full per-tool metrics breakdown",
  "text/plain",
  async () => {
    const metrics = await cache.getSessionMetrics();
    return { contents: [{ uri: "cachebro://metrics", text: formatSessionMetrics(metrics) }] };
  },
);
```

**IMPORTANT:** Check the actual `server.resource()` API signature from `@modelcontextprotocol/sdk`. The McpServer class may use a different signature. Read the MCP SDK types or docs to confirm the exact parameters. The signature might be:

```typescript
server.resource(name: string, uriOrTemplate: string, handler: ResourceHandler)
```

or with metadata object. Adjust accordingly when implementing.

**Step 2: Build and verify**

Run: `bun run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add packages/cli/src/mcp.ts
git commit -m "Add MCP resources for status, working-set, and metrics"
```

---

### Task 11: Update CLAUDE.md and Help Text

**Files:**
- Modify: `CLAUDE.md`
- Modify: `GEMINI.md` (if it exists and mirrors CLAUDE.md)

**Step 1: Update CLAUDE.md tool descriptions**

Add the new tools to the tool documentation in CLAUDE.md:
- `revert_file` — Revert file to previous cached version
- `get_working_set` — List files touched in session
- `search_history` — View read/write history

Add note about resources:
- `cachebro://status` — Session stats
- `cachebro://working-set` — Current working set
- `cachebro://metrics` — Per-tool metrics

Update the compaction recovery section to mention SessionStart hook injects context automatically.

**Step 2: Update help command**

Verify the help text in `packages/cli/src/index.ts` includes all new commands:

```
cachebro - Agent file cache with diff tracking

Usage:
  cachebro init              Auto-configure cachebro for your editor
  cachebro uninit            Remove cachebro configuration
  cachebro index             Full repository indexing
  cachebro serve             Start the MCP server (default)
  cachebro status            Show cache statistics
  cachebro prune [N]         Prune old file versions (keep N, default 5)
  cachebro on-session-start  Inject session state into context (hook)
  cachebro on-stop           Show per-response savings (hook)
  cachebro on-session-end    Display session summary (hook)
  cachebro help              Show this help message
```

**Step 3: Commit**

```bash
git add CLAUDE.md GEMINI.md packages/cli/src/index.ts
git commit -m "Update docs and help text for new tools, resources, and hooks"
```

---

### Task 12: Final Build, Test, and Verification

**Files:** None new — verification only

**Step 1: Full build**

Run: `bun run build`
Expected: Build succeeds, `dist/cli.mjs` produced

**Step 2: Run all tests**

Run: `bun test/smoke.ts`
Expected: "All tests passed!"

**Step 3: Verify CLI commands work**

Run: `node dist/cli.mjs help`
Expected: Full help text with all new commands listed

Run: `node dist/cli.mjs status`
Expected: Shows cache stats or "No cachebro database found"

**Step 4: Verify MCP server starts**

Run: `echo '{}' | timeout 3 node dist/cli.mjs serve 2>&1 || true`
Expected: Server starts without crash (may hang waiting for MCP transport — that's normal)

**Step 5: Commit any final fixes**

If any fixes were needed, commit them with a descriptive message.
