# Project Instructions (Claude Code)

## Memory & Context Management
This project uses `cachebro` to optimize token usage and persist state across context compactions.

### Before Context Compaction
When you feel your context window is getting full, or before you ask the user to clear the session:
1.  **Call `cachebro.summarize_session()`**: This generates a portable summary of your work, including modified files and key decisions.
2.  **Paste the output** into your summary to ensure the next session starts with full context.

### After Context Compaction / New Session
If you are starting fresh or after context was cleared:
1.  **Call `cachebro.session_summary()` immediately**: This is your "Ground Truth". It re-hydrates your "working memory" of what files you were editing and what has been achieved.
2.  **Call `cachebro.get_working_set()`**: To see a list of active files.

### Error Recovery
If an edit introduces a regression and you can't easily fix it:
1.  **DO NOT** manually undo changes line-by-line.
2.  **Call `cachebro.revert_file(path)`**: This instantly restores the file to its state before your last edit.
