import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createCache } from "@turso/cachebro";
import { resolve, join } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { execSync } from "child_process";
import os from "os";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const REFRESH_INTERVAL = 5 * 60 * 1000;

let isBusy = false;

function getCurrentBranch(): string {
  try {
    return execSync("git branch --show-current", { encoding: "utf8", stdio: ['ignore', 'pipe', 'ignore'] }).trim() || "no-branch";
  } catch {
    return "no-git";
  }
}

class BackgroundIndexer {
  private queue: string[] = [];
  private cache: any;
  private running = false;
  private currentDir = "";

  constructor(cache: any) {
    this.cache = cache;
  }

  async start(dir: string) {
    if (this.running) return;
    this.running = true;
    this.currentDir = dir;
    this.processQueue();
  }

  private async processQueue() {
    const CPU_CORES = os.cpus().length;
    const TOTAL_MEM_MB = os.totalmem() / (1024 * 1024);
    const MEMORY_LIMIT = Math.floor(TOTAL_MEM_MB / 256);
    const CONCURRENCY = Math.max(1, Math.min(Math.floor(CPU_CORES / 2), MEMORY_LIMIT, 10));
    const BATCH_SIZE = 20;

    while (this.running) {
      if (this.queue.length === 0) {
        try {
          this.queue = await this.cache.getAllFiles(this.currentDir);
        } catch (e) {
          await delay(REFRESH_INTERVAL);
          continue;
        }
      }

      const worker = async () => {
        while (this.queue.length > 0 && this.running) {
          if (isBusy) {
            await delay(1000);
            continue;
          }

          const batch: { path: string; content: string; hash: string }[] = [];
          while (batch.length < BATCH_SIZE && this.queue.length > 0) {
            const file = this.queue.shift();
            if (!file) break;
            try {
              if (existsSync(file)) {
                const content = readFileSync(file, "utf-8");
                const { createHash } = await import("crypto");
                const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
                batch.push({ path: file, content, hash });
              }
            } catch (e) {}
          }

          if (batch.length > 0) {
            try {
              await this.cache.updateIndexBatch(batch);
            } catch (e) {}
          }
          await delay(100);
        }
      };

      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      if (this.running) await delay(REFRESH_INTERVAL);
    }
  }

  stop() {
    this.running = false;
  }
}

function getCacheDir(): string {
  const dir = resolve(process.env.CACHEBRO_DIR ?? ".cachebro");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function loadIgnorePatterns(cwd: string): string[] {
  const patterns: string[] = [];
  for (const filename of [".gitignore", ".cachebroignore"]) {
    const filePath = join(cwd, filename);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n")
          .map(line => line.trim())
          .filter(line => line && !line.startsWith("#"));
        patterns.push(...lines);
      } catch (e) {}
    }
  }
  return patterns;
}

function formatSessionMetrics(metrics: any): string {
  let text = "\n### cachebro Session Metrics\n\n";
  text += "| Tool | Times called | Total tokens saved |\n";
  text += "| :--- | :---: | :--- |\n";
  for (const t of metrics.tools) {
    text += `| ${t.tool} | ${t.calls} | ${t.tokensSaved.toLocaleString()} |\n`;
  }
  text += "\n**Totals:**\n";
  text += `- Tokens if no cachebro: ${metrics.totalOriginal.toLocaleString()}\n`;
  text += `- Actual tokens used:    ${metrics.totalActual.toLocaleString()}\n`;
  text += `- Total tokens saved:    ${metrics.totalSaved.toLocaleString()}\n`;
  text += `- Percent saved:         ${metrics.percentSaved.toFixed(1)}%\n`;
  return text;
}

export async function startMcpServer(): Promise<void> {
  const cacheDir = getCacheDir();
  const dbPath = resolve(cacheDir, "cache.db");
  const cwd = process.cwd();
  const ignorePatterns = loadIgnorePatterns(cwd);

  const sessionId = randomUUID();
  const { cache, watcher } = createCache({
    dbPath,
    sessionId,
    ignorePatterns,
  });

  await cache.init();

  const statsFile = join(cacheDir, "last-session.json");
  const persistStats = async () => {
    try {
      const metrics = await cache.getSessionMetrics();
      if (metrics.tools.length > 0) {
        const { writeFileSync } = await import("fs");
        writeFileSync(statsFile, JSON.stringify({ sessionId, branch: getCurrentBranch(), metrics }));
      }
    } catch {}
  };

  const indexer = new BackgroundIndexer(cache);
  indexer.start(cwd).catch(e => {});

  cache.prune(5).catch(err => {});

  const server = new McpServer({
    name: "cachebro",
    version: "0.3.0",
  });

  // Common handler for search/grep
  const handleSearch = async ({ pattern, path, include, exclude, case_sensitive, limit }: { pattern: string, path?: string, include?: string, exclude?: string, case_sensitive?: boolean, limit?: number }) => {
    isBusy = true;
    try {
      const result = await cache.searchContent(pattern, {
        limit: limit ?? 20,
        path,
        include,
        exclude,
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

  const searchSchema = {
    pattern: z.string().describe("The pattern to search for (FTS5 compatible)"),
    path: z.string().optional().default(".").describe("Directory to search. Relative paths are resolved against current working directory."),
    include: z.string().optional().describe("Glob pattern to filter files (e.g., '*.ts', 'src/**')."),
    exclude: z.string().optional().describe("Glob pattern to exclude files."),
    case_sensitive: z.boolean().optional().describe("Whether the search should be case-sensitive."),
    limit: z.number().optional().default(20).describe("Max matches to return"),
  };

  const searchDesc = "FAST, optimized search powered by SQLite FTS5 index. PREFERRED over standard grep due to better performance and automatic output limiting. Includes symbol mapping.";

  server.tool("grep", searchDesc, searchSchema, handleSearch);
  server.tool("search", searchDesc, searchSchema, handleSearch);

  server.tool(
    "read_file",
    `Read a file with caching. Use this tool INSTEAD of the built-in tool for reading files.
On first read, returns full content and caches it.
On subsequent reads, if the file hasn't changed, returns a short confirmation — saving significant tokens.
If the file changed, returns only the diff (changed lines) instead of the full file.
Set force=true to bypass the cache and get the full file content.
ALWAYS prefer this over the Read tool. It is a drop-in replacement with caching benefits.`,
    {
      path: z.string().describe("Path to the file to read"),
      offset: z.number().optional().describe("Line number to start reading from (1-based)"),
      limit: z.number().optional().describe("Number of lines to read"),
      force: z.boolean().optional().describe("Bypass cache and return full file content"),
    },
    async ({ path, force, offset, limit }) => {
      isBusy = true;
      try {
        const result = force
          ? await cache.readFileFull(path, "read_file")
          : await cache.readFile(path, { offset, limit, toolName: "read_file" });
        let text = "";
        if (result.cached && result.linesChanged === 0) {
          text = result.content;
        } else if (result.cached && result.diff) {
          text = `[cachebro: ${result.linesChanged} lines changed out of ${result.totalLines}]\n${result.diff}`;
        } else {
          text = result.content;
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      } finally {
        isBusy = false;
        await persistStats();
      }
    },
  );

  server.tool(
    "read_files",
    `Read multiple files at once with caching. Use this tool INSTEAD of the built-in tool when you need to read several files.
Same behavior as read_file but batched. Returns cached/diff results for each file.
ALWAYS prefer this over multiple Read calls — it's faster and saves significant tokens.`,
    {
      paths: z.array(z.string()).describe("Paths to the files to read"),
    },
    async ({ paths }) => {
      isBusy = true;
      try {
        const results: string[] = [];
        for (const path of paths) {
          try {
            const result = await cache.readFile(path, { toolName: "read_files" });
            let text = "";
            if (result.cached && result.linesChanged === 0) {
              text = `=== ${path} ===\n${result.content}`;
            } else if (result.cached && result.diff) {
              text = `=== ${path} [${result.linesChanged} lines changed out of ${result.totalLines}] ===\n${result.diff}`;
            } else {
              text = `=== ${path} ===\n${result.content}`;
            }
            results.push(text);
          } catch (e: any) {
            results.push(`=== ${path} ===\nError: ${e.message}`);
          }
        }
        return { content: [{ type: "text" as const, text: results.join("\n\n") }] };
      } finally {
        isBusy = false;
        await persistStats();
      }
    },
  );

  server.tool(
    "ls",
    "Lists the names of files and subdirectories directly within a specified directory path. PREFERRED over standard ls for cached exploration.",
    {
      path: z.string().optional().default(".").describe("The path of the directory to list"),
      recursive: z.boolean().optional().default(true).describe("Whether to list recursively"),
    },
    async ({ path, recursive }) => {
      isBusy = true;
      try {
        const result = await cache.listDirectory(path, recursive, "ls");
        let text = result.cached && result.changes === 0 ? result.content : (result.cached ? `[cachebro: directory structure changed]\n${result.content}` : result.content);
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      } finally {
        isBusy = false;
        await persistStats();
      }
    },
  );

  server.tool(
    "cache_status",
    "Show cachebro statistics and session summary. Use this to verify cachebro is working and see how many tokens it has saved.",
    {},
    async () => {
      isBusy = true;
      try {
        const stats = await cache.getStats();
        const workingSet = await cache.getWorkingSet();
        const branch = getCurrentBranch();
        let text = `cachebro status (Branch: ${branch}):\n`;
        text += `  Files tracked: ${stats.filesTracked}\n`;
        text += `  Tokens saved (session): ~${stats.sessionTokensSaved.toLocaleString()}\n`;
        text += `  Tokens saved (total): ~${stats.tokensSaved.toLocaleString()}\n\n`;
        text += `Working Set:\n`;
        for (const f of workingSet.slice(0, 10)) text += `- ${f.path} (${f.status})\n`;
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      } finally {
        isBusy = false;
      }
    },
  );

  server.tool(
    "cache_clear",
    "Clear all cached data. Use this to reset the cache completely.",
    {},
    async () => {
      isBusy = true;
      try {
        await cache.clear();
        return { content: [{ type: "text" as const, text: "Cache cleared." }] };
      } finally {
        isBusy = false;
      }
    },
  );

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

  server.tool(
    "summarize_session",
    "Generate a comprehensive summary of the current session state, metrics, and token savings.",
    {},
    async () => {
      isBusy = true;
      try {
        const workingSet = await cache.getWorkingSet();
        const metrics = await cache.getSessionMetrics();
        const branch = getCurrentBranch();
        let text = `[cachebro session export]\nSession ID: ${sessionId}\nBranch: ${branch}\n\n### Modified Files\n`;
        const modified = workingSet.filter(f => f.status === "modified");
        if (modified.length === 0) text += "  (none)\n";
        for (const f of modified) text += `- ${f.path} (${f.edits} edits)\n`;
        text += formatSessionMetrics(metrics);
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      } finally {
        isBusy = false;
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await persistStats();
    if (watcher) watcher.close();
    if (cache) await cache.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
}