# cachebro Improvement Analysis

This document outlines recommended improvements for the `cachebro` MCP server, ranging from critical performance fixes to feature enhancements.

## 1. Critical Performance & Scalability

### **Optimize Diff Algorithm** (`packages/sdk/src/differ.ts`)
*   **Current Issue:** The `longestCommonSubsequence` function uses a standard Dynamic Programming approach with an $O(M \times N)$ 2D array. For a file with 10,000 lines, this creates a $10^8$ integer array (~400MB RAM). For larger files, this will cause the server to crash (Out Of Memory).
*   **Improvement:** Replace the naive DP implementation with **Myers' Diff Algorithm** (which uses $O(N + D)$ space) or integrate a proven, high-performance library like `fast-myers-diff` or `diff`. This is essential for handling large files safely.

### **Database Pruning & Size Management** (`packages/sdk/src/cache.ts`)
*   **Current Issue:** The `file_versions` table stores the *full content* of every version of every file ever read. This database will grow indefinitely, consuming disk space until the disk is full.
*   **Improvement:**
    *   Implement a **Pruning Strategy** (e.g., "Keep only the last 5 versions per file" or "Delete versions older than 7 days").
    *   Add a `cachebro prune` command to the CLI.
    *   Auto-prune on startup or periodically.

## 2. Reliability & Robustness

### **Improved File Watching** (`packages/sdk/src/watcher.ts`)
*   **Current Issue:** The current implementation uses `fs.watch` recursively on the root directory. `fs.watch` is notoriously inconsistent across platforms (Linux vs. macOS vs. Windows) and can hit system file handle limits on large repositories.
*   **Improvement:**
    *   Switch to a robust library like **Chokidar** (or Parcel's watcher) which handles platform differences and efficiently manages resources.
    *   Make ignore patterns configurable (currently hardcoded to ignore `.git` and `node_modules`).

### **Error Handling & Edge Cases**
*   **Current Issue:** `readFile` in `cache.ts` assumes the file exists (via `statSync`) but race conditions could occur. `mcp.ts` catches generic errors but could provide more structured error codes.
*   **Improvement:**
    *   Handle "File not found" gracefully within `cache.ts` without throwing.
    *   Ensure atomic database transactions where appropriate (though SQLite handles single-statement atomicity well).

## 3. MCP Feature Completeness

### **Add "Resources" Support**
*   **Current Issue:** The server only exposes **Tools**.
*   **Improvement:** Implement MCP **Resources** to expose the cache state.
    *   `cachebro://stats`: Read-only resource showing current stats (JSON).
    *   `cachebro://history/{filepath}`: Resource listing all cached versions of a file.
    *   This allows the LLM to "inspect" the cache state passively without executing tools.

### **Version Synchronization**
*   **Current Issue:** The version "0.2.0" is hardcoded in `mcp.ts`, but `package.json` says "0.2.1".
*   **Improvement:** Import `version` from `package.json` dynamically so the reported server version is always accurate.

## 4. Developer Experience & Testing

### **Migrate to Proper Test Runner**
*   **Current Issue:** Testing relies on a single `test/smoke.ts` script.
*   **Improvement:**
    *   Adopt `bun test` fully.
    *   Split tests into unit tests (e.g., `differ.test.ts`, `cache.test.ts`) and integration tests.
    *   Add a "Large File" test case to verify the diff algorithm fix.

### **Linting & Formatting**
*   **Current Issue:** No configuration files for ESLint or Prettier were found.
*   **Improvement:** Add standard linting/formatting to ensure code consistency and catch potential bugs early.

## 5. Multi-Session & Concurrency Support

### **Database Locking Issue**
*   **Current Issue:** `cachebro` uses a local SQLite database (via `@tursodatabase/database`). By default, SQLite handles concurrency using file locks. When multiple agents (e.g., Claude, Cursor, OpenCode) run simultaneously, they each spawn their own `cachebro` process. If one process is writing to the DB, others are blocked, leading to "database is locked" errors. The current implementation does not enable Write-Ahead Logging (WAL) mode, which significantly improves concurrency.
*   **Findings:**
    *   **No WAL Mode:** The code in `packages/sdk/src/cache.ts` connects to the DB but does not execute `PRAGMA journal_mode=WAL;`. This is the primary cause of poor concurrency.
    *   **Process Isolation:** Each MCP client spawns a separate process. There is no central "server" daemon coordinating access.

### **Proposed Solutions**

#### **Option A: Enable WAL Mode (Quickest Fix)**
Executing `PRAGMA journal_mode = WAL;` and `PRAGMA synchronous = NORMAL;` upon connection will allow multiple readers to access the DB while a writer is active. This solves most contention issues for typical agent workloads.
*   **Action:** Update `CacheStore.init()` to run these pragmas immediately after connecting.

#### **Option B: Centralized Daemon (Robust Fix)**
Instead of each agent spawning a new process that touches the DB file, architect `cachebro` to have a background daemon.
*   **Architecture:**
    1.  `cachebro serve` checks if a daemon is running.
    2.  If yes, it proxies requests to the daemon (e.g., via HTTP or a Unix socket).
    3.  If no, it becomes the daemon.
*   **Benefit:** Only one process ever writes to the DB.
*   **Drawback:** Higher complexity to implement process management and IPC.

#### **Recommendation**
Start with **Option A (WAL Mode)**. It is a one-line code change that dramatically improves concurrency without changing the architecture. If locking persists under heavy load, evaluate Option B.
