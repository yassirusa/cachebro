# Project Instructions (Claude Code)

## Memory & Context Management
This project uses `cachebro` to optimize token usage and persist state across context compactions.

### Before Context Compaction
When you feel your context window is getting full, or before you ask the user to clear the session:
1.  **Call `cachebro.summarize_session()`**: This generates a portable summary of your work, including modified files and key decisions.
2.  **Paste the output** into your summary to ensure the next session starts with full context.

### After Context Compaction / New Session
The SessionStart hook automatically injects your working set and session metrics into the context.
You can also manually call `cachebro.get_working_set()` or `cachebro.session_summary()` for more detail.

### Error Recovery
If an edit introduces a regression and you can't easily fix it:
1.  **DO NOT** manually undo changes line-by-line.
2.  **Call `cachebro.revert_file(path)`**: This instantly restores the file to its state before your last edit.

## MCP Tools

### File Operations
- `read_file` — Read a file with caching (returns diff on re-read if changed, or unchanged marker)
- `read_files` — Batch read multiple files with caching
- `edit_file` — Edit a file with exact string replacement (replaces built-in Edit tool)
- `ls` — List directory contents (cached)

### Search
- `grep` / `search` — Fast FTS5-powered search across the repository

### Cache Management
- `cache_status` — Show cache statistics and session summary
- `cache_clear` — Clear all cached data
- `summarize_session` — Generate a comprehensive session summary with metrics

### Session Tools
- `revert_file` — Revert file to previous cached version
- `get_working_set` — List files touched in session with edit counts
- `search_history` — View chronological read/write history

## MCP Resources
- `cachebro://status` — Session stats (files tracked, tokens saved)
- `cachebro://working-set` — Current working set with edit counts
- `cachebro://metrics` — Full per-tool metrics breakdown
