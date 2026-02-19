# Cachebro Improvements Design

**Date:** 2026-02-19
**Status:** Approved
**Scope:** Full improvement pass — compaction recovery, per-response reporting, bug fixes, watcher activation, MCP resources, response optimization, rich terminal output

---

## 1. Post-Compaction Recovery System

### Problem
After Claude Code compacts context, the agent loses awareness of what files it was working on. Cachebro has the session data in its database but the agent doesn't know to ask for it.

### Solution: SessionStart Hook with `additionalContext` Injection

A `SessionStart` hook script runs at every session start (including after compaction). It reads cachebro's database and injects context via stdout JSON.

**Hook script:** `cachebro-session-start.ts` (installed by `cachebro init`)

**Output format:**
```json
{
  "additionalContext": "## cachebro session state\nBranch: main\n\n### Working set (3 files modified)\n- src/cache.ts (5 edits)\n- src/mcp.ts (2 edits)\n- src/types.ts (read-only)\n\n### Session metrics\n~45,230 tokens saved so far (42.8%)\n\nAll files are cached. Re-reads will return diffs or unchanged markers."
}
```

**Flow:**
1. Hook receives `{ session_id, cwd }` from stdin
2. Reads `last-session.json` from `.cachebro/` directory
3. Calls `getWorkingSet()` and `getSessionMetrics()` on CacheStore
4. Formats a concise context block and outputs as `additionalContext`
5. If no prior session data exists (fresh start), outputs empty JSON `{}`

**Registration:** Added to `~/.claude/settings.json` hooks by `cachebro init`:
```json
{
  "hooks": {
    "SessionStart": [{
      "type": "command",
      "command": "bun run /path/to/cachebro-session-start.ts",
      "timeout": 10000
    }]
  }
}
```

---

## 2. Per-Response Savings Reporting

### Problem
Cachebro only reports at session end. Users want feedback after every Claude response.

### Solution: Stop Hook with Delta Metrics

**Per-response line (Stop hook):**
```
 cachebro  ~4,230 tokens saved · 3 cached · 1 diff · main
```

When no savings:
```
 cachebro  0 tokens saved · main
```

**How it works:**
1. MCP server keeps an in-memory counter of tokens saved since last delta query
2. New MCP tool `get_delta_metrics` returns the delta and resets the counter
3. Stop hook script calls `get_delta_metrics` via the MCP connection
4. Formats and writes the line to `/dev/tty` (falls back to stderr)

**Alternative approach (simpler):** Stop hook reads `last-session.json`, compares against `last-reported.json`, computes delta, writes to `/dev/tty`, updates `last-reported.json`. No new MCP tool needed. This is the fallback if direct MCP communication from hooks isn't practical.

**Session-end report (improved formatting):**
```
──────────────────────────────────────────────────
 cachebro  ·  session complete  ·  main
──────────────────────────────────────────────────
  read_file          12x  →   ~45,230 tokens saved
  read_files          3x  →   ~12,100 tokens saved
  ls                  4x  →    ~8,120 tokens saved
  search              6x  →        0 tokens saved
──────────────────────────────────────────────────
  Total: ~65,450 tokens saved  (42.8%)
──────────────────────────────────────────────────
```

---

## 3. Bug Fixes & Missing Tool Registration

### 3a. Register Missing MCP Tools

| Tool | CacheStore Method | Description |
|------|-------------------|-------------|
| `revert_file` | `revertFile(path)` | Restore file to pre-edit state from `file_versions` |
| `get_working_set` | `getWorkingSet()` | List files touched this session with edit counts |
| `search_history` | `getHistory()` | Chronological log of reads/writes this session |

These methods already exist. Just need `server.tool()` registrations in `mcp.ts` with Zod schemas.

### 3b. Fix grep/search Filter Params

Currently `handleSearch` ignores `path`, `include`, `exclude`, `case_sensitive`. Fix:

- **`path`**: Filter FTS5 results to only include files under this directory prefix
- **`include`**: Apply glob filter (e.g., `*.ts`) using the `ignore` library (already a dependency)
- **`exclude`**: Remove matches from files matching this glob
- **`case_sensitive`**: Not natively supported by FTS5 with unicode61 tokenizer. Apply post-query case-sensitive filtering on the matched content.

Implementation: Post-query filtering on FTS5 results. FTS5 handles the full-text matching, then results are filtered by path/glob/case before returning.

### 3c. Dead Dependency Cleanup

- Remove `@tursodatabase/database` from root `package.json` dependencies
- Remove from build externals list in build command
- Remove `test/check_fts5.ts` (uses the dead dep)
- Sync version numbers across: root `package.json`, `packages/cli/package.json`, `mcp.ts` hardcoded version string

### 3d. Non-Destructive Schema Migration

Replace the current destructive migration (drop all tables on version bump) with incremental migrations:

```typescript
const MIGRATIONS: Record<number, string[]> = {
  7: [
    "ALTER TABLE session_metrics ADD COLUMN last_reported_saved INTEGER DEFAULT 0"
  ],
  // Future migrations added here as new version numbers
};

function migrateSchema(db: Database): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  const targetVersion = Math.max(...Object.keys(MIGRATIONS).map(Number));

  for (let v = currentVersion + 1; v <= targetVersion; v++) {
    if (MIGRATIONS[v]) {
      for (const sql of MIGRATIONS[v]) {
        db.exec(sql);
      }
    }
    db.pragma(`user_version = ${v}`);
  }
}
```

Existing data survives upgrades. Only new columns/tables are added incrementally.

---

## 4. File Watcher Activation

### Problem
`FileWatcher` class exists but `mcp.ts` never passes `watchPaths`, so it never starts.

### Fix
Pass project root as `watchPaths` when calling `createCache()`:

```typescript
const { cache, watcher } = await createCache({
  cacheDir,
  sessionId,
  watchPaths: [projectRoot],
  ignorePatterns: loadIgnorePatterns()
});
```

**Benefits:**
- FTS index updates within ~100ms of file saves
- `onFileDeleted` properly cleans up FTS entries
- Search results are always current

**Guards:**
- Chokidar already ignores `node_modules` and dotfiles
- `.cachebroignore` patterns loaded and passed as `ignorePatterns`
- `awaitWriteFinish` debounce prevents rapid-fire re-indexing
- Background indexer still runs as safety net

---

## 5. MCP Resources

### Design: 3 Read-Only Resources

| URI | Description | Source Method |
|-----|-------------|---------------|
| `cachebro://status` | Session stats: files tracked, tokens saved, percent | `getStats()` |
| `cachebro://working-set` | Working set with edit counts and timestamps | `getWorkingSet()` |
| `cachebro://metrics` | Full per-tool metrics breakdown | `getSessionMetrics()` |

**Implementation:**
```typescript
server.resource("cachebro://status", "Session status", async () => ({
  contents: [{ uri: "cachebro://status", text: formatStatus(cache.getStats()) }]
}));
```

Lightweight, read-only. Agents can check cachebro state without consuming tool call turns.

---

## 6. Response Optimization

### Shorter Unchanged Labels
Before: `[cachebro: unchanged on branch main, 245 lines, 1837 tokens saved]`
After: `[unchanged · 245 lines · ~1.8k saved]`

### Compressed Diff Headers
Minimize diff metadata overhead.

### Diff Truncation
Cap diff output at 200 lines. If exceeded, append:
```
[... diff truncated at 200 lines. Full file has N total changes.]
```

### In-Memory Delta Tracking
MCP server tracks per-response token deltas in memory instead of reading/writing JSON files on every tool call. `persistStats()` still writes to disk periodically for crash recovery, but the hot path is in-memory.

---

## 7. Rich Terminal Output

### ANSI Color Scheme
No external dependencies — raw `\x1b[...m` escape codes.

| Element | Color |
|---------|-------|
| "cachebro" label | Cyan bold |
| Token counts (> 0) | Green |
| Token counts (= 0) | Dim gray |
| Branch name | Dim |
| Total line | Bold green |
| Percentage | Bold |
| Horizontal rules | Dim |

### Per-Response Output (Stop hook)
```
 cachebro  ~4,230 tokens saved · 3 cached · 1 diff · main
```

### Session-End Output
```
──────────────────────────────────────────────────
 cachebro  ·  session complete  ·  main
──────────────────────────────────────────────────
  read_file          12x  →   ~45,230 tokens saved
  read_files          3x  →   ~12,100 tokens saved
  ls                  4x  →    ~8,120 tokens saved
  search              6x  →        0 tokens saved
──────────────────────────────────────────────────
  Total: ~65,450 tokens saved  (42.8%)
──────────────────────────────────────────────────
```

No progress bars or live panels — clean colored text only.

---

## Files Affected

### New Files
- `scripts/cachebro-session-start.ts` — SessionStart hook script
- `scripts/cachebro-on-stop.ts` — Stop hook for per-response reporting
- `.cachebro/last-reported.json` — Delta tracking state (auto-created at runtime)

### Modified Files
- `packages/cli/src/mcp.ts` — Register missing tools, add MCP resources, pass watchPaths, delta tracking
- `packages/sdk/src/cache.ts` — Non-destructive migrations, search filtering, response optimization
- `packages/sdk/src/index.ts` — Export new types if needed
- `packages/sdk/src/types.ts` — Add types for delta metrics, resources
- `packages/cli/src/index.ts` — Update `init` to register SessionStart + Stop hooks, update `on-session-end` formatting
- `package.json` — Remove dead `@tursodatabase/database` dep, sync versions
- `packages/sdk/package.json` — Version sync
- `README.md` — Document new features (if needed, deferred)
- `CLAUDE.md` / `GEMINI.md` — Update tool descriptions

### Deleted Files
- `test/check_fts5.ts` — Uses dead dependency

---

## Implementation Order

1. Bug fixes first (dead deps, version sync, schema migration) — foundation
2. Register missing MCP tools — unblocks working set and history access
3. Fix grep/search filtering — correctness
4. Activate file watcher — FTS freshness
5. Response optimization (shorter labels, diff truncation) — token savings
6. SessionStart hook (compaction recovery) — biggest user-facing improvement
7. Stop hook (per-response reporting) — feedback loop
8. Session-end report formatting — polish
9. MCP resources — bonus
10. Rich terminal output — final polish
