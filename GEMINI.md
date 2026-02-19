# GEMINI.md - cachebro

## Project Overview
`cachebro` is a specialized file cache with diff tracking designed for AI coding agents. It optimizes token usage by caching file contents and returning either a confirmation of no changes or a compact unified diff for subsequent reads. This approach can save approximately 24-26% of tokens in typical agentic coding workflows.

### Main Technologies
- **Runtime & Tooling:** [Bun](https://bun.sh) (for building, testing, and execution)
- **Language:** TypeScript
- **Database:** [Turso](https://turso.tech) / SQLite (embedded for local persistence)
- **Protocol:** [Model Context Protocol (MCP)](https://modelcontextprotocol.io)
- **Validation:** [Zod](https://zod.dev)

## Architecture
The project is structured as a TypeScript monorepo:
- `packages/sdk/`: The core library containing:
  - `CacheStore`: Manages content-addressed file caching in SQLite.
  - `FileWatcher`: Handles filesystem change notifications.
  - `computeDiff`: Logic for generating line-based unified diffs.
- `packages/cli/`: Batteries-included CLI and MCP server implementation.
  - `mcp.ts`: Implementation of the MCP server and its tools (`read_file`, `read_files`, `cache_status`, `cache_clear`).
- `test/`: Contains smoke tests to verify core functionality.

## Building and Running
The project uses Bun for its lifecycle scripts.

- **Build:**
  ```bash
  bun run build
  ```
  This command bundles the CLI into `dist/cli.mjs` using Bun's bundler and ensures the shebang is compatible with Node.js.

- **Test:**
  ```bash
  bun run test
  ```
  Runs the smoke tests defined in `test/smoke.ts`.

- **Run CLI/MCP Server:**
  ```bash
  # Start the MCP server
  npx cachebro serve

  # Show cache statistics
  npx cachebro status

  # Initialize editor configurations (Claude Code, Cursor, etc.)
  npx cachebro init
  ```

## Development Conventions
- **ES Modules:** The project uses ESM (`"type": "module"` in `package.json`).
- **TypeScript:** Strict typing is used throughout the SDK and CLI.
- **Monorepo Structure:** Shared logic belongs in `packages/sdk`, while user-facing interfaces belong in `packages/cli`.
- **Token Estimation:** Tokens are estimated using a simple `ceil(characters * 0.75)` heuristic.
- **Session Isolation:** Each session (e.g., a specific chat or task) tracks its own read history independently via `sessionId`.
- **Content Hashing:** SHA-256 hashes are used as the source of truth for change detection.

## Memory & Context Management

`cachebro` provides powerful tools to manage your context window and recover from errors.

### Task Completion (IMPORTANT)
When you finish a task, or when the user is about to exit:
1.  **Call `cachebro.summarize_session()`**: This displays a summary of your work and the **total tokens saved** during the session. Report these savings to the user.

### When your context is full (Compaction)
Before clearing context or when you notice the conversation getting too long:
1.  **Call `cachebro.summarize_session()`**: This generates a portable summary of your work, including modified files and key decisions.
2.  **Paste the output** into your new session or compaction summary.
3.  **In the new session**: Call `cachebro.session_summary()` immediately to re-hydrate your "working memory" of what files you were editing.

### When you get lost or confused
If you forget which files you modified or what the last error was:
1.  **Call `cachebro.session_summary()`**: This is your "Ground Truth". It tells you exactly what files you touched in this session.
2.  **Call `cachebro.get_working_set()`**: To see a list of active files.

### When you break something
If an edit introduces a regression and you can't easily fix it:
1.  **DO NOT** manually undo changes line-by-line (error-prone).
2.  **Call `cachebro.revert_file(path)`**: This instantly restores the file to its state before your last edit.
