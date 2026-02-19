#!/usr/bin/env bun
import { startMcpServer } from "./mcp.js";

const command = process.argv[2];

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
};

async function loadIgnorePatterns(cwd: string): Promise<string[]> {
  const { existsSync, readFileSync } = await import("fs");
  const { join } = await import("path");
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

if (!command || command === "serve") {
  await startMcpServer();
} else if (command === "status") {
  const { createCache } = await import("@turso/cachebro");
  const { resolve, join } = await import("path");
  const { existsSync } = await import("fs");

  const cacheDir = resolve(process.env.CACHEBRO_DIR ?? ".cachebro");
  const dbPath = join(cacheDir, "cache.db");

  if (!existsSync(dbPath)) {
    console.log("No cachebro database found. Run 'cachebro serve' to start caching.");
    process.exit(0);
  }

  const { cache } = createCache({ dbPath, sessionId: "cli-status" });
  await cache.init();
  const stats = await cache.getStats();

  console.log(`cachebro status:`);
  console.log(`  Files tracked:          ${stats.filesTracked}`);
  console.log(`  Tokens saved (total):   ~${stats.tokensSaved.toLocaleString()}`);

  await cache.close();
} else if (command === "on-session-end") {
  const { existsSync, readFileSync, openSync, writeSync, closeSync } = await import("fs");
  const { resolve, join } = await import("path");

  const cacheDir = resolve(process.env.CACHEBRO_DIR ?? ".cachebro");
  const statsFile = join(cacheDir, "last-session.json");

  if (!existsSync(statsFile)) process.exit(0);

  try {
    const data = JSON.parse(readFileSync(statsFile, "utf-8"));
    const { metrics, branch } = data;

    const hasMetrics = metrics?.tools?.length > 0;
    if (!hasMetrics) process.exit(0);

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
    try { const fd = openSync("/dev/tty", "w"); writeSync(fd, out); closeSync(fd); } catch { process.stderr.write(out); }
  } catch {}
  process.exit(0);
} else if (command === "on-session-start") {
  const { existsSync, readFileSync } = await import("fs");
  const { join, resolve } = await import("path");

  let input: any = {};
  try {
    const data = await new Promise<string>((res) => {
      let d = "";
      process.stdin.on("data", (c: Buffer) => d += c.toString());
      process.stdin.on("end", () => res(d));
      setTimeout(() => res(d), 3000);
    });
    if (data.trim()) input = JSON.parse(data);
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
        const readOnly = workingSet.filter((f: any) => f.status === "read");
        if (readOnly.length > 0 && readOnly.length <= 10) {
          context += `### Recently read (${readOnly.length} files)\n`;
          for (const f of readOnly.slice(0, 10)) context += `- ${f.path}\n`;
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

    let lastReported = { totalSaved: 0, totalCalls: 0 };
    if (existsSync(lastReportedFile)) {
      try { lastReported = JSON.parse(readFileSync(lastReportedFile, "utf-8")); } catch {}
    }

    const deltaSaved = metrics.totalSaved - (lastReported.totalSaved || 0);
    const totalCalls = metrics.tools.reduce((s: number, t: any) => s + t.calls, 0);
    const deltaCalls = totalCalls - (lastReported.totalCalls || 0);

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

    writeFileSync(lastReportedFile, JSON.stringify({ totalSaved: metrics.totalSaved, totalCalls }));
  } catch {}
  process.exit(0);
} else if (command === "prune") {
  const { createCache } = await import("@turso/cachebro");
  const { resolve, join } = await import("path");
  const { existsSync } = await import("fs");

  const cacheDir = resolve(process.env.CACHEBRO_DIR ?? ".cachebro");
  const dbPath = join(cacheDir, "cache.db");

  if (!existsSync(dbPath)) {
    console.log("No cachebro database found.");
    process.exit(0);
  }

  const keepStr = process.argv[3];
  const keep = keepStr ? parseInt(keepStr, 10) : 5;

  const { cache } = createCache({ dbPath, sessionId: "cli-prune" });
  await cache.init();
  const removed = await cache.prune(keep);
  console.log(`Done. Removed ${removed} old file versions.`);
  await cache.close();
} else if (command === "index") {
  const { createCache } = await import("@turso/cachebro");
  const { resolve, join } = await import("path");
  const { readFileSync, existsSync } = await import("fs");
  const { createHash } = await import("crypto");
  const os = await import("os");
  const Database = (await import("better-sqlite3")).default;

  const cwd = process.cwd();
  const cacheDir = resolve(process.env.CACHEBRO_DIR ?? ".cachebro");
  const dbPath = join(cacheDir, "cache.db");

  const ignorePatterns = await loadIgnorePatterns(cwd);
  const { cache } = createCache({ dbPath, sessionId: "cli-index", ignorePatterns });
  await cache.init();

  console.log("Scanning repository...");
  const files = await cache.getAllFiles(cwd);
  const total = files.length;
  console.log(`Found ${total} files. Starting indexing...`);

  let indexed = 0;
  let errors = 0;
  const CPU_CORES = os.cpus().length;
  const BATCH_SIZE = 100;

  const sharedDb = new Database(dbPath);
  sharedDb.pragma("busy_timeout = 5000");
  sharedDb.pragma("journal_mode = WAL");

  const reportProgress = (processed: number) => {
    const percent = total > 0 ? Math.floor((processed / total) * 100) : 100;
    const freeGB = (os.freemem() / (1024 * 1024 * 1024)).toFixed(1);
    const msg = `\rProgress: [${percent}%] ${processed}/${total} | Free Mem: ${freeGB}GB   `;
    process.stderr.write(msg);
  };

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const chunk = files.slice(i, i + BATCH_SIZE);
    const batchItems = await Promise.all(chunk.map(async (file) => {
      try {
        if (existsSync(file)) {
          const content = readFileSync(file, "utf-8");
          const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
          return { path: file, content, hash };
        }
      } catch (e) { errors++; }
      return null;
    }));

    const validItems = batchItems.filter((item): item is NonNullable<typeof item> => item !== null);
    if (validItems.length > 0) {
      try {
        await cache.updateIndexBatch(validItems, sharedDb);
        indexed += validItems.length;
      } catch (e) { errors += validItems.length; }
    }
    reportProgress(indexed + errors);
    if (i % (BATCH_SIZE * 5) === 0) await new Promise(r => setTimeout(r, 0));
  }

  sharedDb.close();
  process.stderr.write("\n");

  console.log("Cleaning up stale index entries...");
  const indexedPaths = await cache.getIndexedPaths();
  const currentFilesSet = new Set(files.map(f => resolve(f)));
  const stalePaths = indexedPaths.filter(p => !currentFilesSet.has(p));

  if (stalePaths.length > 0) {
    await cache.deleteIndexEntries(stalePaths);
    console.log(`Removed ${stalePaths.length} stale entries.`);
  }

  console.log("Indexing complete.");
  await cache.close();
} else if (command === "init") {
  const { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, chmodSync } =
    await import("fs");
  const { join, resolve } = await import("path");
  const { homedir } = await import("os");

  const cwd = process.cwd();
  const home = homedir();
  if (!home || typeof home !== "string") {
    console.error("Could not determine home directory.");
    process.exit(1);
  }

  const dataDir = join(cwd, ".cachebro");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    console.log("  Created .cachebro directory");
  }

  const cachebroignorePath = join(cwd, ".cachebroignore");
  const gitignorePath = join(cwd, ".gitignore");
  if (!existsSync(cachebroignorePath)) {
    if (existsSync(gitignorePath)) {
      writeFileSync(cachebroignorePath, readFileSync(gitignorePath));
      console.log("  Created .cachebroignore (cloned from .gitignore)");
    } else {
      writeFileSync(cachebroignorePath, "");
      console.log("  Created .cachebroignore (empty)");
    }
  }

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".cachebro/")) {
      appendFileSync(gitignorePath, "\n.cachebro/\n");
      console.log("  Added .cachebro/ to .gitignore");
    }
  }

  const mcpServersEntry = { command: "npx", args: ["cachebro", "serve"] };
  const claudeCodeEntry = { command: "cachebro", args: ["serve"] };
  const opencodeMcpEntry = { type: "local" as const, command: ["npx", "cachebro", "serve"] };
  let xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");

  const targets = [
    { name: "Claude Code", path: join(home, ".claude.json"), key: "mcpServers", entry: claudeCodeEntry, type: "json" },
    { name: "Cursor", path: join(home, ".cursor", "mcp.json"), key: "mcpServers", entry: mcpServersEntry, type: "json" },
    { name: "OpenCode", path: join(xdgConfig, "opencode", "opencode.json"), key: "mcp", entry: opencodeMcpEntry, type: "json" },
    { name: "Gemini", path: join(home, ".gemini", "settings.json"), key: "mcpServers", entry: mcpServersEntry, type: "json" },
  ];

  let configured = 0;
  for (const target of targets) {
    const dir = join(target.path, "..");
    if (!existsSync(dir)) continue;
    if (target.type === "json") {
      let config: any = {};
      if (existsSync(target.path)) { try { config = JSON.parse(readFileSync(target.path, "utf-8")); } catch { config = {}; } }
      if (config[target.key]?.cachebro) { console.log(`  ${target.name}: already configured`); configured++; continue; }
      config[target.key] = config[target.key] ?? {};
      config[target.key].cachebro = target.entry;
      writeFileSync(target.path, JSON.stringify(config, null, 2) + "\n");
      console.log(`  ${target.name}: configured (${target.path})`);
      configured++;
    }
  }

  const codexPath = join(home, ".codex", "config.toml");
  if (existsSync(codexPath)) {
    let content = readFileSync(codexPath, "utf-8");
    if (content.includes("[mcp_servers.cachebro]")) { console.log(`  Codex: already configured`); configured++; }
    else { writeFileSync(codexPath, content.trimEnd() + `\n\n[mcp_servers.cachebro]\ncommand = "npx"\nargs = ["cachebro", "serve"]\nenabled = true\n`); console.log(`  Codex: configured (${codexPath})`); configured++; }
  }

  // Claude Code hooks (only if ~/.claude exists)
  const claudeDir = join(home, ".claude");
  const claudeSettingsPath = join(claudeDir, "settings.json");
  if (existsSync(claudeDir)) {
    const hooksDir = join(claudeDir, "hooks");
    if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

    const guardPath = join(hooksDir, "cachebro-guard.py");
    const trackerPath = join(hooksDir, "cachebro-tracker.py");

    const guardScript = `#!/usr/bin/env python3
"""PreToolUse hook: blocks Read/Grep/Glob and redirects to cachebro equivalents.
Allows fallback if cachebro failed within the last 10 seconds."""
import sys, json, os, time
try:
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    session_id = data.get("session_id", "unknown")
    if tool_name not in ("Read", "Grep", "Glob"):
        sys.exit(0)
    state_file = f"/tmp/.cachebro-state-{session_id}"
    if os.path.exists(state_file):
        with open(state_file) as f:
            state = json.load(f)
        if state.get("last_status") == "error":
            if time.time() - state.get("last_time", 0) < 10:
                sys.exit(0)
    tool_map = {"Read": "mcp__cachebro__read_file", "Grep": "mcp__cachebro__grep or mcp__cachebro__search", "Glob": "mcp__cachebro__ls"}
    print(json.dumps({"decision": "block", "reason": f"Use {tool_map.get(tool_name, 'a cachebro equivalent')} instead of {tool_name}. cachebro is faster and token-efficient. If cachebro returns an error, retry immediately — the block lifts for 10s after a cachebro failure."}))
    sys.exit(0)
except Exception:
    sys.exit(0)
`;

    const trackerScript = `#!/usr/bin/env python3
"""PostToolUse hook: tracks cachebro tool call status for the guard hook."""
import sys, json, os, time
try:
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    session_id = data.get("session_id", "unknown")
    if not tool_name.startswith("mcp__cachebro__"):
        sys.exit(0)
    tool_response = data.get("tool_response", {})
    is_error = (isinstance(tool_response, dict) and bool(tool_response.get("isError", False))) or (isinstance(tool_response, str) and tool_response.startswith("Error:"))
    with open(f"/tmp/.cachebro-state-{session_id}", "w") as f:
        json.dump({"last_tool": tool_name, "last_status": "error" if is_error else "ok", "last_time": time.time()}, f)
except Exception:
    pass
sys.exit(0)
`;

    writeFileSync(guardPath, guardScript);
    writeFileSync(trackerPath, trackerScript);
    try { chmodSync(guardPath, 0o755); chmodSync(trackerPath, 0o755); } catch {}

    let settings: any = {};
    if (existsSync(claudeSettingsPath)) {
      try { settings = JSON.parse(readFileSync(claudeSettingsPath, "utf-8")); } catch {}
    }
    settings.hooks = settings.hooks ?? {};

    const hasHook = (key: string, marker: string) =>
      (settings.hooks[key] ?? []).some((e: any) => e.hooks?.some((h: any) => h.command?.includes(marker)));

    settings.hooks.PreToolUse = settings.hooks.PreToolUse ?? [];
    if (!hasHook("PreToolUse", "cachebro-guard")) {
      settings.hooks.PreToolUse.push({ matcher: "Read|Grep|Glob", hooks: [{ type: "command", command: `python3 ${guardPath}`, timeout: 5 }] });
    }
    settings.hooks.PostToolUse = settings.hooks.PostToolUse ?? [];
    if (!hasHook("PostToolUse", "cachebro-tracker")) {
      settings.hooks.PostToolUse.push({ matcher: "mcp__cachebro__.*", hooks: [{ type: "command", command: `python3 ${trackerPath}`, timeout: 5 }] });
    }
    // Detect full binary path so hooks work even when ~/.npm-global/bin isn't in PATH
    let cachebroBin = "cachebro";
    try {
      const { execSync: _exec } = await import("child_process");
      cachebroBin = _exec("which cachebro", { encoding: "utf8" }).trim();
    } catch {}
    settings.hooks.Stop = settings.hooks.Stop ?? [];
    if (!hasHook("Stop", "cachebro on-stop") && !hasHook("Stop", "cachebro on-session-end")) {
      settings.hooks.Stop.push({ hooks: [{ type: "command", command: `${cachebroBin} on-stop`, timeout: 5 }] });
    }
    settings.hooks.SessionEnd = settings.hooks.SessionEnd ?? [];
    if (!hasHook("SessionEnd", "cachebro on-session-end")) {
      settings.hooks.SessionEnd.push({ hooks: [{ type: "command", command: `sleep 0.5 && ${cachebroBin} on-session-end`, timeout: 10 }] });
    }
    settings.hooks.SessionStart = settings.hooks.SessionStart ?? [];
    if (!hasHook("SessionStart", "cachebro on-session-start")) {
      settings.hooks.SessionStart.push({ hooks: [{ type: "command", command: `${cachebroBin} on-session-start`, timeout: 10 }] });
    }

    writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log(`  Claude Code hooks: configured`);
    configured++;
  }

  if (configured === 0) {
    console.log("\nNo supported tools detected. You can manually add cachebro to your MCP config:");
    console.log(JSON.stringify({ mcpServers: { cachebro: mcpServersEntry } }, null, 2));
  } else {
    console.log(`\nDone! Restart your editor to pick up cachebro.`);
  }
} else if (command === "uninit") {
  const { existsSync, readFileSync, writeFileSync, unlinkSync } = await import("fs");
  const { join } = await import("path");
  const { homedir } = await import("os");
  const home = homedir();
  if (!home || typeof home !== "string") { console.error("Could not determine home directory."); process.exit(1); }
  let xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
  const targets = [
    { name: "Claude Code", path: join(home, ".claude.json"), key: "mcpServers", type: "json" },
    { name: "Cursor", path: join(home, ".cursor", "mcp.json"), key: "mcpServers", type: "json" },
    { name: "OpenCode", path: join(xdgConfig, "opencode", "opencode.json"), key: "mcp", type: "json" },
    { name: "Gemini", path: join(home, ".gemini", "settings.json"), key: "mcpServers", type: "json" },
  ];
  let unconfigured = 0;
  for (const target of targets) {
    if (!existsSync(target.path)) continue;
    if (target.type === "json") {
      let config: any = {};
      try { config = JSON.parse(readFileSync(target.path, "utf-8")); } catch { continue; }
      if (config[target.key]?.cachebro) { delete config[target.key].cachebro; writeFileSync(target.path, JSON.stringify(config, null, 2) + "\n"); console.log(`  ${target.name}: unconfigured (${target.path})`); unconfigured++; }
      else { console.log(`  ${target.name}: not configured`); }
    }
  }
  const codexPath = join(home, ".codex", "config.toml");
  if (existsSync(codexPath)) {
    let content = readFileSync(codexPath, "utf-8");
    if (content.includes("[mcp_servers.cachebro]")) {
      const lines = content.split("\n");
      const newLines = [];
      let skipping = false;
      for (const line of lines) {
        if (line.trim() === "[mcp_servers.cachebro]") { skipping = true; continue; }
        if (skipping && line.trim().startsWith("[")) { skipping = false; }
        if (!skipping) newLines.push(line);
      }
      writeFileSync(codexPath, newLines.join("\n"));
      console.log(`  Codex: unconfigured (${codexPath})`);
      unconfigured++;
    } else { console.log(`  Codex: not configured`); }
  }
  // Claude Code hooks
  const claudeDir = join(home, ".claude");
  const claudeSettingsPath = join(claudeDir, "settings.json");
  if (existsSync(claudeSettingsPath)) {
    let settings: any = {};
    try { settings = JSON.parse(readFileSync(claudeSettingsPath, "utf-8")); } catch {}
    let modified = false;
    for (const key of ["PreToolUse", "PostToolUse", "Stop", "SessionEnd", "SessionStart"]) {
      if (Array.isArray(settings.hooks?.[key])) {
        const before = settings.hooks[key].length;
        settings.hooks[key] = settings.hooks[key].filter((e: any) =>
          !e.hooks?.some((h: any) => h.command?.includes("cachebro"))
        );
        if (settings.hooks[key].length !== before) modified = true;
      }
    }
    if (modified) {
      writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + "\n");
      console.log(`  Claude Code hooks: removed`);
      unconfigured++;
    }
    const guardPath = join(claudeDir, "hooks", "cachebro-guard.py");
    const trackerPath = join(claudeDir, "hooks", "cachebro-tracker.py");
    for (const p of [guardPath, trackerPath]) {
      if (existsSync(p)) { try { unlinkSync(p); } catch {} }
    }
  }

  if (unconfigured > 0) console.log(`\nDone! Restart your editor to apply changes.`);
  else console.log(`No configurations found to remove.`);
} else if (command === "help" || command === "--help") {
  console.log(`cachebro - Agent file cache with diff tracking

Usage:
  cachebro init      Auto-configure cachebro for your editor
  cachebro uninit    Remove cachebro configuration from your editor
  cachebro index     Manually trigger full repository indexing
  cachebro serve     Start the MCP server (default)
  cachebro status          Show cache statistics
  cachebro prune [N]       Prune old file versions (keep N, default 5)
  cachebro on-session-end  Display last session stats (used by editor hooks)
  cachebro help            Show this help message

Environment:
  CACHEBRO_DIR       Cache directory (default: .cachebro)`);
} else {
  console.error(`Unknown command: ${command}. Run 'cachebro help' for usage.`);
  process.exit(1);
}
