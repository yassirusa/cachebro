import Database from "better-sqlite3";
import { computeDiff } from "./differ.js";
import type { CacheConfig, CacheStats, FileReadResult, DirectoryReadResult, RevertResult, WorkingSetFile, HistoryEntry, SessionMetrics, ToolMetric } from "./types.js";
import { createHash } from "crypto";
import ignore from "ignore";
import { execSync } from "child_process";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS file_versions (
  path        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  content     TEXT NOT NULL,
  lines       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (path, hash)
);

CREATE TABLE IF NOT EXISTS session_reads (
  session_id  TEXT NOT NULL,
  branch      TEXT NOT NULL,
  path        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  read_at     INTEGER NOT NULL,
  PRIMARY KEY (session_id, branch, path)
);

CREATE TABLE IF NOT EXISTS session_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  branch      TEXT NOT NULL,
  type        TEXT NOT NULL,
  path        TEXT NOT NULL,
  hash        TEXT,
  timestamp   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_metrics (
  session_id       TEXT NOT NULL,
  branch           TEXT NOT NULL,
  tool             TEXT NOT NULL,
  calls            INTEGER DEFAULT 0,
  tokens_original  INTEGER DEFAULT 0,
  tokens_actual    INTEGER DEFAULT 0,
  PRIMARY KEY (session_id, branch, tool)
);

CREATE TABLE IF NOT EXISTS session_stats (
  session_id  TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, key)
);

CREATE TABLE IF NOT EXISTS stats (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO stats (key, value) VALUES ('tokens_saved', 0);

CREATE TABLE IF NOT EXISTS file_mtimes (
  path      TEXT PRIMARY KEY,
  hash      TEXT NOT NULL,
  mtime_ms  REAL NOT NULL
);
`;

const SCHEMA_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS file_content_fts USING fts5(
  path UNINDEXED,
  symbols,
  content,
  tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS indexed_files (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL
);
`;

const CURRENT_SCHEMA_VERSION = 7;

const SCHEMA_MIGRATIONS: Record<number, string[]> = {
  7: [
    "CREATE TABLE IF NOT EXISTS file_mtimes (path TEXT PRIMARY KEY, hash TEXT NOT NULL, mtime_ms REAL NOT NULL)",
  ],
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.75);
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function extractSymbols(content: string): string {
  const symbols = new Set<string>();
  
  // Broad regex patterns for common languages
  const patterns = [
    /(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/g,
    /class\s+([a-zA-Z0-9_$]+)/g,
    /interface\s+([a-zA-Z0-9_$]+)/g,
    /type\s+([a-zA-Z0-9_$]+)\s*=/g,
    /const\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g, // Arrow functions
    /export\s+(?:const|let|var|class|function|type|interface)\s+([a-zA-Z0-9_$]+)/g,
    /def\s+([a-zA-Z0-9_$]+)\s*\(/g, // Python
    /pub\s+(?:fn|struct|enum|type|trait)\s+([a-zA-Z0-9_$]+)/g, // Rust
    /func\s+(?:\([^)]*\)\s+)?([a-zA-Z0-9_$]+)\s*\(/g, // Go
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1]) symbols.add(match[1]);
    }
  }

  return Array.from(symbols).join(" ");
}

export class CacheStore {
  private dbPath: string;
  private sessionId: string;
  private initialized = false;
  private searchEnabled = false;
  private ig: any;

  constructor(config: CacheConfig) {
    this.dbPath = config.dbPath;
    this.sessionId = config.sessionId;
    
    this.ig = ignore().add([
      ".git",
      "node_modules",
      ".DS_Store",
      ".cachebro",
      ...(config.ignorePatterns || [])
    ]);
  }

  private isIgnored(relPath: string, isDir: boolean): boolean {
    if (!relPath) return false;
    const pathToCheck = isDir && !relPath.endsWith("/") ? relPath + "/" : relPath;
    return this.ig.ignores(pathToCheck);
  }

  private getCurrentBranch(): string {
    try {
      return execSync("git branch --show-current", { encoding: "utf8", stdio: ['ignore', 'pipe', 'ignore'] }).trim() || "no-branch";
    } catch {
      return "no-git";
    }
  }

  private async withDb<T>(fn: (db: Database.Database) => T | Promise<T>): Promise<T> {
    const maxRetries = 10;
    const baseDelay = 50;
    for (let attempt = 0; ; attempt++) {
      try {
        const db = new Database(this.dbPath);
        db.pragma("busy_timeout = 5000");
        try {
          return await fn(db);
        } finally {
          db.close();
        }
      } catch (e: any) {
        if (attempt >= maxRetries || !e.message?.includes("locked")) throw e;
        const delay = baseDelay * (1 + Math.random()) * Math.min(attempt + 1, 5);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.withDb(async (db) => {
      try {
        db.pragma("journal_mode = WAL");
        db.pragma("synchronous = NORMAL");
      } catch (e) {}
      
      const version = db.pragma("user_version", { simple: true }) as number;

      if (version === 0) {
        // Fresh database — create all tables
        db.exec(SCHEMA);
        db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
      } else if (version < CURRENT_SCHEMA_VERSION) {
        // Existing database — ensure base tables exist (CREATE IF NOT EXISTS is safe)
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

      try {
        db.exec(SCHEMA_FTS);
        this.searchEnabled = true;
      } catch (e: any) {
        if (e.message?.includes("fts5")) {
          console.error("[cachebro] Warning: SQLite FTS5 extension not found. Search functionality will be disabled.");
          this.searchEnabled = false;
        } else {
          throw e;
        }
      }
    });
    this.initialized = true;
  }

  private logEvent(db: Database.Database, type: "read" | "write", path: string, hash: string, branch: string): void {
    db.prepare("INSERT INTO session_events (session_id, branch, type, path, hash, timestamp) VALUES (?, ?, ?, ?, ?, ?)").run(this.sessionId, branch, type, path, hash, Date.now());
  }

  private addMetrics(db: Database.Database, tool: string, original: number, actual: number, branch: string): void {
    db.prepare(`INSERT INTO session_metrics (session_id, branch, tool, calls, tokens_original, tokens_actual) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(session_id, branch, tool) DO UPDATE SET calls = calls + 1, tokens_original = tokens_original + ?, tokens_actual = tokens_actual + ?`).run(this.sessionId, branch, tool, original, actual, original, actual);
    const saved = Math.max(0, original - actual);
    if (saved > 0) this.addTokensSavedInternal(db, saved);
  }

  async getSessionMetrics(): Promise<SessionMetrics> {
    await this.init();
    return this.withDb((db) => {
      const rows = db.prepare("SELECT tool, SUM(calls) as calls, SUM(tokens_original) as tokens_original, SUM(tokens_actual) as tokens_actual FROM session_metrics WHERE session_id = ? GROUP BY tool").all(this.sessionId) as any[];
      const tools: ToolMetric[] = rows.map(r => ({ tool: r.tool, calls: r.calls, tokensOriginal: r.tokens_original, tokensActual: r.tokens_actual, tokensSaved: Math.max(0, r.tokens_original - r.tokens_actual) }));
      let totalOriginal = 0, totalActual = 0;
      for (const t of tools) { totalOriginal += t.tokensOriginal; totalActual += t.tokensActual; }
      const totalSaved = Math.max(0, totalOriginal - totalActual);
      return { tools, totalOriginal, totalActual, totalSaved, percentSaved: totalOriginal > 0 ? (totalSaved / totalOriginal) * 100 : 0 };
    });
  }

  async getWorkingSet(): Promise<WorkingSetFile[]> {
    await this.init();
    const branch = this.getCurrentBranch();
    return this.withDb((db) => {
      const rows = db.prepare("SELECT path, COUNT(*) as count, MAX(timestamp) as last_activity, SUM(CASE WHEN type = 'write' THEN 1 ELSE 0 END) as edits FROM session_events WHERE session_id = ? AND branch = ? GROUP BY path ORDER BY last_activity DESC").all(this.sessionId, branch) as any[];
      return rows.map(r => ({ path: r.path, status: r.edits > 0 ? "modified" : "read", edits: r.edits, lastActivity: r.last_activity }));
    });
  }

  async getHistory(limit: number = 50, pathFilter?: string): Promise<HistoryEntry[]> {
    await this.init();
    const branch = this.getCurrentBranch();
    return this.withDb((db) => {
      let query = "SELECT path, type, hash, timestamp FROM session_events WHERE session_id = ? AND branch = ?";
      const params: any[] = [this.sessionId, branch];
      if (pathFilter) { query += " AND path LIKE ?"; params.push(`%${pathFilter}%`); }
      query += " ORDER BY timestamp DESC LIMIT ?"; params.push(limit);
      const rows = db.prepare(query).all(...params) as any[];
      return rows.map(r => ({ path: r.path, type: r.type, hash: r.hash, timestamp: r.timestamp }));
    });
  }

  async listDirectory(dirPath: string, recursive: boolean = true, toolName: string = "list_directory"): Promise<DirectoryReadResult> {
    await this.init();
    const branch = this.getCurrentBranch();
    const { readdirSync, statSync } = await import("fs");
    const { resolve, relative, join } = await import("path");
    const absPath = resolve(dirPath);
    const cwd = process.cwd();
    const walk = (currentPath: string): string[] => {
      const relToCwd = relative(cwd, currentPath);
      if (relToCwd && this.isIgnored(relToCwd, true)) return [];
      let entries: string[] = [];
      try {
        const files = readdirSync(currentPath);
        for (const file of files) {
          const fullPath = join(currentPath, file);
          const relFile = relative(cwd, fullPath);
          try {
            const stats = statSync(fullPath);
            if (stats.isDirectory()) {
              if (this.isIgnored(relFile, true)) continue;
              if (recursive) entries.push(...walk(fullPath)); else entries.push(relFile + "/");
            } else {
              if (this.isIgnored(relFile, false)) continue;
              entries.push(relFile);
            }
          } catch {}
        }
      } catch {}
      return entries;
    };
    const files = walk(absPath).sort();
    const content = files.join("\n");
    const currentHash = contentHash(content);
    const dbKey = absPath.endsWith("/") ? absPath : absPath + "/";
    const originalTokens = estimateTokens(content);
    return this.withDb((db) => {
      const lastRead = db.prepare("SELECT hash FROM session_reads WHERE session_id = ? AND branch = ? AND path = ?").all(this.sessionId, branch, dbKey) as any[];
      if (lastRead.length > 0) {
        const lastHash = lastRead[0].hash as string;
        if (lastHash === currentHash) {
          const savedLabel = originalTokens >= 1000 ? `~${(originalTokens / 1000).toFixed(1)}k` : `~${originalTokens}`;
          const label = `[unchanged · ${files.length} items · ${savedLabel} saved]`;
          this.addMetrics(db, toolName, originalTokens, estimateTokens(label), branch);
          this.logEvent(db, "read", dbKey, currentHash, branch);
          db.prepare("UPDATE session_reads SET read_at = ? WHERE session_id = ? AND branch = ? AND path = ?").run(Date.now(), this.sessionId, branch, dbKey);
          return { cached: true, content: label, hash: currentHash, changes: 0 };
        }
        const oldVersion = db.prepare("SELECT content FROM file_versions WHERE path = ? AND hash = ?").all(dbKey, lastHash) as any[];
        db.prepare("INSERT OR IGNORE INTO file_versions (path, hash, content, lines, created_at) VALUES (?, ?, ?, ?, ?)").run(dbKey, currentHash, content, files.length, Date.now());
        db.prepare("UPDATE session_reads SET hash = ?, read_at = ? WHERE session_id = ? AND branch = ? AND path = ?").run(currentHash, Date.now(), this.sessionId, branch, dbKey);
        if (oldVersion.length > 0) {
          const oldContent = oldVersion[0].content as string;
          const diffResult = computeDiff(oldContent, content, dirPath);
          this.addMetrics(db, toolName, originalTokens, estimateTokens(diffResult.diff), branch);
          this.logEvent(db, "write", dbKey, currentHash, branch);
          return { cached: true, content: diffResult.diff, hash: currentHash, changes: diffResult.linesChanged };
        }
      }
      this.addMetrics(db, toolName, originalTokens, originalTokens, branch);
      this.logEvent(db, "read", dbKey, currentHash, branch);
      db.prepare("INSERT OR IGNORE INTO file_versions (path, hash, content, lines, created_at) VALUES (?, ?, ?, ?, ?)").run(dbKey, currentHash, content, files.length, Date.now());
      db.prepare("INSERT OR REPLACE INTO session_reads (session_id, branch, path, hash, read_at) VALUES (?, ?, ?, ?, ?)").run(this.sessionId, branch, dbKey, currentHash, Date.now());
      return { cached: false, content, hash: currentHash, changes: 0 };
    });
  }

  async revertFile(filePath: string, stepsBack: number = 1, toolName: string = "revert_file"): Promise<RevertResult> {
    await this.init();
    const branch = this.getCurrentBranch();
    const { resolve } = await import("path");
    const { writeFileSync } = await import("fs");
    const absPath = resolve(filePath);
    return this.withDb((db) => {
      this.addMetrics(db, toolName, 0, 0, branch);
      const versions = db.prepare("SELECT content, hash, created_at FROM file_versions WHERE path = ? ORDER BY created_at DESC LIMIT ?").all(absPath, stepsBack + 1) as any[];
      if (versions.length <= stepsBack) return { success: false, message: `Only found ${versions.length} versions.` };
      const targetVersion = versions[stepsBack];
      try {
        writeFileSync(absPath, targetVersion.content);
        this.logEvent(db, "write", absPath, targetVersion.hash, branch);
        db.prepare("INSERT OR REPLACE INTO session_reads (session_id, branch, path, hash, read_at) VALUES (?, ?, ?, ?, ?)").run(this.sessionId, branch, absPath, targetVersion.hash, Date.now());
        return { success: true, message: `Reverted ${filePath}.`, restoredHash: targetVersion.hash };
      } catch (e: any) { return { success: false, message: `Write failed: ${e.message}` }; }
    });
  }

  async readFile(filePath: string, options?: { offset?: number; limit?: number; toolName?: string }): Promise<FileReadResult> {
    await this.init();
    const branch = this.getCurrentBranch();
    const toolName = options?.toolName ?? "read_file";
    const { readFileSync, statSync } = await import("fs");
    const { resolve, relative } = await import("path");
    const absPath = resolve(filePath);

    const stat = statSync(absPath);
    const currentMtime = stat.mtimeMs;

    const isPartial = (options?.offset ?? 0) > 0 || (options?.limit ?? 0) > 0;
    const sliceLines = (text: string): string => {
      if (!isPartial) return text;
      const lines = text.split("\n");
      const start = (options?.offset ?? 1) - 1;
      const end = options?.limit ? start + options.limit : lines.length;
      return lines.slice(start, end).join("\n");
    };

    const relPath = relative(process.cwd(), absPath);
    if (this.isIgnored(relPath, false)) {
       const currentContent = readFileSync(absPath, "utf-8");
       const currentHash = contentHash(currentContent);
       const content = isPartial ? sliceLines(currentContent) : currentContent;
       return this.withDb((db) => { this.addMetrics(db, toolName, estimateTokens(content), estimateTokens(content), branch); return { cached: false, content, hash: currentHash, totalLines: currentContent.split("\n").length }; });
    }

    return this.withDb(async (db) => {
      // --- Mtime fast-path ---
      let currentContent: string;
      let currentHash: string;
      let currentLines: number;

      const mtimeRow = db.prepare(
        "SELECT hash FROM file_mtimes WHERE path = ? AND mtime_ms = ?"
      ).get(absPath, currentMtime) as { hash: string } | undefined;

      if (mtimeRow) {
        currentHash = mtimeRow.hash;
        const cachedVersion = db.prepare(
          "SELECT content, lines FROM file_versions WHERE path = ? AND hash = ?"
        ).get(absPath, currentHash) as { content: string; lines: number } | undefined;

        if (cachedVersion) {
          currentContent = cachedVersion.content;
          currentLines = cachedVersion.lines;
        } else {
          // Fallback: file_mtimes exists but file_versions doesn't
          currentContent = readFileSync(absPath, "utf-8");
          currentLines = currentContent.split("\n").length;
          currentHash = contentHash(currentContent);
          db.prepare("INSERT OR REPLACE INTO file_mtimes (path, hash, mtime_ms) VALUES (?, ?, ?)").run(absPath, currentHash, currentMtime);
        }
      } else {
        // Mtime miss — read from disk
        currentContent = readFileSync(absPath, "utf-8");
        currentLines = currentContent.split("\n").length;
        currentHash = contentHash(currentContent);
        db.prepare("INSERT OR REPLACE INTO file_mtimes (path, hash, mtime_ms) VALUES (?, ?, ?)").run(absPath, currentHash, currentMtime);
      }

      // --- Session reads logic (UNCHANGED from current) ---
      const lastRead = db.prepare("SELECT hash FROM session_reads WHERE session_id = ? AND branch = ? AND path = ?").all(this.sessionId, branch, absPath) as any[];
      const originalContent = isPartial ? sliceLines(currentContent) : currentContent;
      const originalTokens = estimateTokens(originalContent);
      if (lastRead.length > 0) {
        const lastHash = lastRead[0].hash as string;
        if (lastHash === currentHash) {
          this.logEvent(db, "read", absPath, currentHash, branch);
          const savedLabel = originalTokens >= 1000 ? `~${(originalTokens / 1000).toFixed(1)}k` : `~${originalTokens}`;
          const label = isPartial
            ? `[unchanged · lines ${(options?.offset ?? 1)}-${(options?.limit ? (options.offset ?? 1) + options.limit - 1 : currentLines)} of ${currentLines} · ${savedLabel} saved]`
            : `[unchanged · ${currentLines} lines · ${savedLabel} saved]`;
          this.addMetrics(db, toolName, originalTokens, estimateTokens(label), branch);
          db.prepare("UPDATE session_reads SET read_at = ? WHERE session_id = ? AND branch = ? AND path = ?").run(Date.now(), this.sessionId, branch, absPath);
          return { cached: true, content: label, hash: currentHash, totalLines: currentLines, linesChanged: 0 };
        }
        const oldVersion = db.prepare("SELECT content FROM file_versions WHERE path = ? AND hash = ?").all(absPath, lastHash) as any[];
        this.logEvent(db, "write", absPath, currentHash, branch);
        await this.updateIndexInternal(absPath, currentContent, currentHash, db);
        db.prepare("INSERT OR IGNORE INTO file_versions (path, hash, content, lines, created_at) VALUES (?, ?, ?, ?, ?)").run(absPath, currentHash, currentContent, currentLines, Date.now());
        db.prepare("UPDATE session_reads SET hash = ?, read_at = ? WHERE session_id = ? AND branch = ? AND path = ?").run(currentHash, Date.now(), this.sessionId, branch, absPath);
        if (oldVersion.length > 0) {
          const oldContent = oldVersion[0].content as string;
          const diffResult = computeDiff(oldContent, currentContent, filePath);
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
        }
      }
      this.logEvent(db, "read", absPath, currentHash, branch);
      this.addMetrics(db, toolName, originalTokens, originalTokens, branch);
      await this.updateIndexInternal(absPath, currentContent, currentHash, db);
      db.prepare("INSERT OR IGNORE INTO file_versions (path, hash, content, lines, created_at) VALUES (?, ?, ?, ?, ?)").run(absPath, currentHash, currentContent, currentLines, Date.now());
      db.prepare("INSERT OR REPLACE INTO session_reads (session_id, branch, path, hash, read_at) VALUES (?, ?, ?, ?, ?)").run(this.sessionId, branch, absPath, currentHash, Date.now());
      return { cached: false, content: isPartial ? sliceLines(currentContent) : currentContent, hash: currentHash, totalLines: currentLines };
    });
  }

  async readFileFull(filePath: string, toolName: string = "read_file"): Promise<FileReadResult> {
    await this.init();
    const branch = this.getCurrentBranch();
    const { readFileSync, statSync } = await import("fs");
    const { resolve, relative } = await import("path");
    const absPath = resolve(filePath);
    const stat = statSync(absPath);
    const currentMtime = stat.mtimeMs;
    const currentContent = readFileSync(absPath, "utf-8");
    const currentHash = contentHash(currentContent);
    const originalTokens = estimateTokens(currentContent);
    const relPath = relative(process.cwd(), absPath);
    if (this.isIgnored(relPath, false)) {
       return this.withDb((db) => { this.addMetrics(db, toolName, originalTokens, originalTokens, branch); return { cached: false, content: currentContent, hash: currentHash, totalLines: currentContent.split("\n").length }; });
    }
    return this.withDb(async (db) => {
      this.logEvent(db, "read", absPath, currentHash, branch);
      this.addMetrics(db, toolName, originalTokens, originalTokens, branch);
      await this.updateIndexInternal(absPath, currentContent, currentHash, db);
      db.prepare("INSERT OR IGNORE INTO file_versions (path, hash, content, lines, created_at) VALUES (?, ?, ?, ?, ?)").run(absPath, currentHash, currentContent, currentContent.split("\n").length, Date.now());
      db.prepare("INSERT OR REPLACE INTO file_mtimes (path, hash, mtime_ms) VALUES (?, ?, ?)").run(absPath, currentHash, currentMtime);
      db.prepare("INSERT OR REPLACE INTO session_reads (session_id, branch, path, hash, read_at) VALUES (?, ?, ?, ?, ?)").run(this.sessionId, branch, absPath, currentHash, Date.now());
      return { cached: false, content: currentContent, hash: currentHash, totalLines: currentContent.split("\n").length };
    });
  }

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

  async trackToolUsage(tool: string, tokensUsed: number): Promise<void> {
    await this.init();
    const branch = this.getCurrentBranch();
    return this.withDb((db) => {
      this.addMetrics(db, tool, tokensUsed, tokensUsed, branch);
    });
  }

  async updateIndex(path: string, content: string, hash: string): Promise<void> {
    await this.init();
    if (!this.searchEnabled) return;
    await this.withDb(async (db) => await this.updateIndexInternal(path, content, hash, db));
  }

  async updateIndexBatch(items: { path: string, content: string, hash: string }[], db?: Database.Database): Promise<void> {
    await this.init();
    if (!this.searchEnabled || items.length === 0) return;
    const exec = async (dbInstance: Database.Database) => {
      const checkStmt = dbInstance.prepare("SELECT hash FROM indexed_files WHERE path = ?");
      const delStmt = dbInstance.prepare("DELETE FROM file_content_fts WHERE path = ?");
      const insFtsStmt = dbInstance.prepare("INSERT INTO file_content_fts (path, symbols, content) VALUES (?, ?, ?)");
      const insIdxStmt = dbInstance.prepare("INSERT OR REPLACE INTO indexed_files (path, hash) VALUES (?, ?)");
      const { resolve } = await import("path");
      const transaction = dbInstance.transaction((batch) => {
        for (const item of batch) {
          const absPath = resolve(item.path);
          const existing = checkStmt.get(absPath) as { hash: string } | undefined;
          if (existing?.hash === item.hash) continue;
          const symbols = extractSymbols(item.content);
          delStmt.run(absPath);
          insFtsStmt.run(absPath, symbols, item.content);
          insIdxStmt.run(absPath, item.hash);
        }
      });
      transaction(items);
    };
    if (db) await exec(db); else await this.withDb(exec);
  }

  async warmupBatch(
    items: { path: string; content: string; hash: string; mtimeMs: number }[],
    db?: Database.Database
  ): Promise<void> {
    await this.init();
    if (items.length === 0) return;
    const exec = async (dbInstance: Database.Database) => {
      const checkVersionStmt = dbInstance.prepare(
        "SELECT hash FROM file_versions WHERE path = ? AND hash = ?"
      );
      const insVersionStmt = dbInstance.prepare(
        "INSERT OR IGNORE INTO file_versions (path, hash, content, lines, created_at) VALUES (?, ?, ?, ?, ?)"
      );
      const insMtimeStmt = dbInstance.prepare(
        "INSERT OR REPLACE INTO file_mtimes (path, hash, mtime_ms) VALUES (?, ?, ?)"
      );
      const { resolve } = await import("path");
      const now = Date.now();
      const transaction = dbInstance.transaction((batch) => {
        for (const item of batch) {
          const absPath = resolve(item.path);
          const existing = checkVersionStmt.get(absPath, item.hash);
          if (!existing) {
            const lines = item.content.split("\n").length;
            insVersionStmt.run(absPath, item.hash, item.content, lines, now);
          }
          insMtimeStmt.run(absPath, item.hash, item.mtimeMs);
        }
      });
      transaction(items);
    };
    if (db) await exec(db); else await this.withDb(exec);
  }

  async warmupFiles(
    dirPath: string,
    options?: {
      batchSize?: number;
      onProgress?: (processed: number, total: number) => void;
      db?: Database.Database;
    }
  ): Promise<{ filesProcessed: number; errors: number }> {
    await this.init();
    const { readFileSync, statSync } = await import("fs");
    const { resolve } = await import("path");
    const batchSize = options?.batchSize ?? 100;

    const files = await this.getAllFiles(dirPath);
    const total = files.length;
    let processed = 0;
    let errors = 0;

    for (let i = 0; i < files.length; i += batchSize) {
      const chunk = files.slice(i, i + batchSize);
      const batchItems: { path: string; content: string; hash: string; mtimeMs: number }[] = [];

      for (const file of chunk) {
        try {
          const absPath = resolve(file);
          const stat = statSync(absPath);
          const content = readFileSync(absPath, "utf-8");
          const hash = contentHash(content);
          batchItems.push({ path: file, content, hash, mtimeMs: stat.mtimeMs });
        } catch {
          errors++;
        }
      }

      if (batchItems.length > 0) {
        try {
          await this.warmupBatch(batchItems, options?.db);
          const ftsItems = batchItems.map(b => ({ path: b.path, content: b.content, hash: b.hash }));
          await this.updateIndexBatch(ftsItems, options?.db);
          processed += batchItems.length;
        } catch {
          errors += batchItems.length;
        }
      }

      options?.onProgress?.(processed + errors, total);
    }

    return { filesProcessed: processed, errors };
  }

  private async updateIndexInternal(path: string, content: string, hash: string, db: Database.Database): Promise<void> {
    if (!this.searchEnabled) return;
    const { resolve } = await import("path");
    const absPath = resolve(path);
    const existing = db.prepare("SELECT hash FROM indexed_files WHERE path = ?").get(absPath) as { hash: string } | undefined;
    if (existing?.hash === hash) return;
    const symbols = extractSymbols(content);
    db.prepare("DELETE FROM file_content_fts WHERE path = ?").run(absPath);
    db.prepare("INSERT INTO file_content_fts (path, symbols, content) VALUES (?, ?, ?)").run(absPath, symbols, content);
    db.prepare("INSERT OR REPLACE INTO indexed_files (path, hash) VALUES (?, ?)").run(absPath, hash);
  }

  async getAllFiles(dirPath: string): Promise<string[]> {
    const { readdirSync, statSync } = await import("fs");
    const { resolve, relative, join } = await import("path");
    const absPath = resolve(dirPath);
    const cwd = process.cwd();
    const walk = (currentPath: string): string[] => {
      const relToCwd = relative(cwd, currentPath);
      if (relToCwd && this.isIgnored(relToCwd, true)) return [];
      let entries: string[] = [];
      try {
        const files = readdirSync(currentPath);
        for (const file of files) {
          const fullPath = join(currentPath, file);
          const relFile = relative(cwd, fullPath);
          try {
            const stats = statSync(fullPath);
            if (stats.isDirectory()) {
              if (this.isIgnored(relFile, true)) continue;
              entries.push(...walk(fullPath));
            } else {
              if (this.isIgnored(relFile, false)) continue;
              entries.push(relFile);
            }
          } catch {}
        }
      } catch {}
      return entries;
    };
    return walk(absPath);
  }

  async getIndexedPaths(): Promise<string[]> {
    await this.init();
    return this.withDb((db) => {
      const rows = db.prepare("SELECT path FROM indexed_files").all() as { path: string }[];
      return rows.map(r => r.path);
    });
  }

  async deleteIndexEntries(paths: string[]): Promise<void> {
    await this.init();
    if (paths.length === 0) return;
    await this.withDb((db) => {
      const delFts = db.prepare("DELETE FROM file_content_fts WHERE path = ?");
      const delIdx = db.prepare("DELETE FROM indexed_files WHERE path = ?");
      const transaction = db.transaction((batch) => {
        for (const p of batch) {
          delFts.run(p);
          delIdx.run(p);
        }
      });
      transaction(paths);
    });
  }

  async onFileChanged(filePath: string): Promise<void> {
    await this.init();
    try {
      const { readFileSync } = await import("fs");
      const content = readFileSync(filePath, "utf-8");
      const hash = contentHash(content);
      await this.updateIndex(filePath, content, hash);
    } catch {}
  }

  async onFileDeleted(filePath: string): Promise<void> {
    await this.init();
    const { resolve } = await import("path");
    const absPath = resolve(filePath);
    const dirKey = absPath.endsWith("/") ? absPath : absPath + "/";
    await this.withDb((db) => {
      db.prepare("DELETE FROM file_versions WHERE path = ?").run(absPath);
      db.prepare("DELETE FROM session_reads WHERE path = ?").run(absPath);
      db.prepare("DELETE FROM file_content_fts WHERE path = ?").run(absPath);
      db.prepare("DELETE FROM indexed_files WHERE path = ?").run(absPath);
      db.prepare("DELETE FROM file_mtimes WHERE path = ?").run(absPath);
      db.prepare("DELETE FROM file_versions WHERE path = ?").run(dirKey);
      db.prepare("DELETE FROM session_reads WHERE path = ?").run(dirKey);
    });
  }

  async getStats(): Promise<CacheStats> {
    await this.init();
    return this.withDb((db) => {
      const versions = db.prepare("SELECT COUNT(DISTINCT path) as c FROM file_versions").all() as any[];
      const tokens = db.prepare("SELECT value FROM stats WHERE key = 'tokens_saved'").all() as any[];
      const sessionTokens = db.prepare("SELECT value FROM session_stats WHERE session_id = ? AND key = 'tokens_saved'").all(this.sessionId) as any[];
      return { filesTracked: versions[0].c, tokensSaved: tokens.length > 0 ? tokens[0].value : 0, sessionTokensSaved: sessionTokens.length > 0 ? sessionTokens[0].value : 0 };
    });
  }

  async clear(): Promise<void> {
    await this.init();
    await this.withDb((db) => { db.exec("DELETE FROM file_versions; DELETE FROM session_reads; DELETE FROM session_stats; DELETE FROM session_metrics; DELETE FROM session_events; DELETE FROM file_mtimes; UPDATE stats SET value = 0;"); });
  }

  async prune(keepVersions: number = 5): Promise<number> {
    await this.init();
    return this.withDb((db) => {
      const result = db.prepare(`DELETE FROM file_versions WHERE (path, hash) IN (SELECT path, hash FROM (SELECT path, hash, ROW_NUMBER() OVER (PARTITION BY path ORDER BY created_at DESC) as rn FROM file_versions) WHERE rn > ?)`).run(keepVersions);
      return result.changes;
    });
  }

  async close(): Promise<void> { this.initialized = false; }

  private async addTokensSavedInternal(db: Database.Database, tokens: number): Promise<void> {
    db.prepare("UPDATE stats SET value = value + ? WHERE key = 'tokens_saved'").run(tokens);
    db.prepare("INSERT INTO session_stats (session_id, key, value) VALUES (?, 'tokens_saved', ?) ON CONFLICT(session_id, key) DO UPDATE SET value = value + ?").run(this.sessionId, tokens, tokens);
  }
}
