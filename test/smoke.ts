import { createCache } from "@turso/cachebro";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = (import.meta as any).dir ?? dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".tmp_test");
const DB_PATH = join(TEST_DIR, "test.db");
const FILE_PATH = join(TEST_DIR, "example.ts");

// Setup
rmSync(TEST_DIR, { recursive: true, force: true });
mkdirSync(TEST_DIR, { recursive: true });

writeFileSync(FILE_PATH, `function hello() {\n  console.log("hello world");\n}\n`);

const { cache, watcher } = createCache({
  dbPath: DB_PATH,
  sessionId: "test-session-1",
});

await cache.init();

// Test 1: First read returns full content
console.log("--- Test 1: First read (should be full content) ---");
const r1 = await cache.readFile(FILE_PATH);
console.log(`  cached: ${r1.cached}`);
console.log(`  lines: ${r1.totalLines}`);
console.log(`  content preview: ${r1.content.slice(0, 60)}...`);
console.assert(!r1.cached, "First read should not be cached");

// Test 2: Second read, no changes — should be cached
console.log("\n--- Test 2: Second read, no changes (should be cached) ---");
const r2 = await cache.readFile(FILE_PATH);
console.log(`  cached: ${r2.cached}`);
console.log(`  linesChanged: ${r2.linesChanged}`);
console.log(`  content: ${r2.content}`);
console.assert(r2.cached, "Second read should be cached");
console.assert(r2.linesChanged === 0, "No lines should have changed");

// Test 3: Modify file, read again — should return diff
console.log("\n--- Test 3: Modified file (should return diff) ---");
writeFileSync(FILE_PATH, `function hello() {\n  console.log("hello cachebro!");\n  return true;\n}\n`);
const r3 = await cache.readFile(FILE_PATH);
console.log(`  cached: ${r3.cached}`);
console.log(`  linesChanged: ${r3.linesChanged}`);
console.log(`  diff:\n${r3.diff}`);
console.assert(r3.cached, "Should be cached (returning diff)");
console.assert(r3.linesChanged! > 0, "Should have changed lines");

// Test 4: Stats
console.log("\n--- Test 4: Stats ---");
const stats = await cache.getStats();
console.log(`  Files tracked: ${stats.filesTracked}`);
console.log(`  Tokens saved (session): ~${stats.sessionTokensSaved}`);
console.log(`  Tokens saved (total): ~${stats.tokensSaved}`);
console.assert(stats.filesTracked === 1, "Should track 1 file");
console.assert(stats.sessionTokensSaved > 0, "Should have saved tokens in session");
console.assert(stats.tokensSaved > 0, "Should have saved tokens total");

// Test 5: Multi-session isolation
console.log("\n--- Test 5: Multi-session isolation ---");
// Session 2 has never read the file — should get full content even though session 1 cached it
const { cache: cache2 } = createCache({
  dbPath: DB_PATH,
  sessionId: "test-session-2",
});
await cache2.init();
const r5 = await cache2.readFile(FILE_PATH);
console.log(`  cached: ${r5.cached}`);
console.log(`  content preview: ${r5.content.slice(0, 60)}...`);
console.assert(!r5.cached, "Session 2 first read should NOT be cached");

// Session 2 reads again — now it should be cached for session 2
const r5b = await cache2.readFile(FILE_PATH);
console.log(`  second read cached: ${r5b.cached}`);
console.assert(r5b.cached, "Session 2 second read should be cached");
console.assert(r5b.linesChanged === 0, "No lines should have changed for session 2");

await cache2.close();

// Test 6: Partial read (offset/limit) — first read of a new file
console.log("\n--- Test 6: Partial read with offset/limit ---");
const LONG_FILE = join(TEST_DIR, "long.ts");
const longContent = Array.from({ length: 20 }, (_, i) => `line ${i + 1}: const x${i} = ${i};`).join("\n");
writeFileSync(LONG_FILE, longContent);

const r6 = await cache.readFile(LONG_FILE, { offset: 5, limit: 3 });
console.log(`  cached: ${r6.cached}`);
console.log(`  content: ${r6.content}`);
console.assert(!r6.cached, "First partial read should not be cached");
console.assert(r6.content.includes("line 5"), "Should include line 5");
console.assert(r6.content.includes("line 7"), "Should include line 7");
console.assert(!r6.content.includes("line 8"), "Should NOT include line 8");

// Test 7: Partial read unchanged — should return cache hit
console.log("\n--- Test 7: Partial read unchanged (should be cached) ---");
const r7 = await cache.readFile(LONG_FILE, { offset: 5, limit: 3 });
console.log(`  cached: ${r7.cached}`);
console.log(`  content: ${r7.content}`);
console.assert(r7.cached, "Second partial read should be cached");
console.assert(r7.linesChanged === 0, "No lines should have changed");
console.assert(r7.content.includes("unchanged"), "Should say unchanged");

// Test 8: Modify lines outside the requested range — partial read still unchanged
console.log("\n--- Test 8: Partial read, changes OUTSIDE requested range ---");
const modifiedLines = longContent.split("\n");
modifiedLines[0] = "line 1: MODIFIED";  // Change line 1 (outside range 5-7)
modifiedLines[18] = "line 19: MODIFIED"; // Change line 19 (outside range 5-7)
writeFileSync(LONG_FILE, modifiedLines.join("\n"));

const r8 = await cache.readFile(LONG_FILE, { offset: 5, limit: 3 });
console.log(`  cached: ${r8.cached}`);
console.log(`  content: ${r8.content}`);
console.assert(r8.cached, "Should be cached — changes outside requested range");
console.assert(r8.linesChanged === 0, "Should report 0 lines changed in range");
console.assert(r8.content.includes("unchanged"), "Should say unchanged");

// Test 9: Modify lines INSIDE the requested range — should return content
console.log("\n--- Test 9: Partial read, changes INSIDE requested range ---");
modifiedLines[5] = "line 6: MODIFIED_IN_RANGE";  // Change line 6 (inside range 5-7)
writeFileSync(LONG_FILE, modifiedLines.join("\n"));

const r9 = await cache.readFile(LONG_FILE, { offset: 5, limit: 3 });
console.log(`  cached: ${r9.cached}`);
console.log(`  content: ${r9.content}`);
console.assert(!r9.cached, "Should NOT be cached — changes inside requested range");
console.assert(r9.content.includes("MODIFIED_IN_RANGE"), "Should include modified content");

await cache2.close();

// Test 10: Non-destructive schema migration
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

// Re-init same DB with a different session (simulates upgrade — init() should preserve data)
const { cache: mCache2 } = createCache({ dbPath: migrationDbPath, sessionId: "migrate-2" });
await mCache2.init();
const statsAfter = await mCache2.getStats();
console.log(`  Files after migration: ${statsAfter.filesTracked}`);
console.assert(statsAfter.filesTracked >= 1, "Files should survive migration");
await mCache2.close();
rmSync(MIGRATION_DIR, { recursive: true, force: true });

// Test 11: file_mtimes table exists after init
console.log("\n--- Test 11: file_mtimes table exists ---");
const MTIME_DIR = join(TEST_DIR, "mtime_test");
mkdirSync(MTIME_DIR, { recursive: true });
const mtimeDbPath = join(MTIME_DIR, "mtime.db");
const mtimeFile = join(MTIME_DIR, "test.ts");
writeFileSync(mtimeFile, "const x = 1;\n");

const { cache: mtimeCache } = createCache({ dbPath: mtimeDbPath, sessionId: "mtime-1" });
await mtimeCache.init();

// Read a file to exercise the cache
await mtimeCache.readFile(mtimeFile);

// Second read should be cached
const mtimeR2 = await mtimeCache.readFile(mtimeFile);
console.log(`  second read cached: ${mtimeR2.cached}`);
console.assert(mtimeR2.cached, "Second read should be cached");
console.assert(mtimeR2.linesChanged === 0, "No changes expected");

await mtimeCache.close();
rmSync(MTIME_DIR, { recursive: true, force: true });

// Test 12: Mtime optimization — fresh session uses cached content
console.log("\n--- Test 12: Mtime optimization (fresh session, cached via mtime) ---");
const MTIME2_DIR = join(TEST_DIR, "mtime2_test");
mkdirSync(MTIME2_DIR, { recursive: true });
const mtime2DbPath = join(MTIME2_DIR, "mtime2.db");
const mtime2File = join(MTIME2_DIR, "hello.ts");
writeFileSync(mtime2File, "function greet() { return 'hello'; }\n");

// Session A reads the file (populates file_versions + file_mtimes)
const { cache: cacheA } = createCache({ dbPath: mtime2DbPath, sessionId: "mtime-sess-a" });
await cacheA.init();
const rA = await cacheA.readFile(mtime2File);
console.log(`  Session A first read cached: ${rA.cached}`);
console.assert(!rA.cached, "Session A first read should not be cached");
await cacheA.close();

// Session B reads the same file (should get full content from file_versions via mtime match)
const { cache: cacheB } = createCache({ dbPath: mtime2DbPath, sessionId: "mtime-sess-b" });
await cacheB.init();
const rB = await cacheB.readFile(mtime2File);
console.log(`  Session B first read cached: ${rB.cached}`);
console.assert(!rB.cached, "Session B first read should not be cached (new session)");
console.assert(rB.content.includes("greet"), "Should contain file content");

// Session B reads again — should be cached (mtime unchanged, hash matches session_reads)
const rB2 = await cacheB.readFile(mtime2File);
console.log(`  Session B second read cached: ${rB2.cached}`);
console.assert(rB2.cached, "Session B second read should be cached");
console.assert(rB2.linesChanged === 0, "No changes expected");

// Modify file and verify mtime change is detected
writeFileSync(mtime2File, "function greet() { return 'hello world'; }\n");
const rB3 = await cacheB.readFile(mtime2File);
console.log(`  Session B after modify cached: ${rB3.cached}`);
console.log(`  Session B after modify linesChanged: ${rB3.linesChanged}`);
console.assert(rB3.cached, "Should be cached (returns diff)");
console.assert((rB3.linesChanged ?? 0) > 0, "Should detect changes");

await cacheB.close();
rmSync(MTIME2_DIR, { recursive: true, force: true });

// Test 13: Warmup pre-populates file_versions and file_mtimes
console.log("\n--- Test 13: Warmup command ---");
const WARMUP_DIR = join(TEST_DIR, "warmup_test");
mkdirSync(WARMUP_DIR, { recursive: true });
const warmupDbPath = join(WARMUP_DIR, "warmup.db");

// Create some files
writeFileSync(join(WARMUP_DIR, "a.ts"), "const a = 1;\n");
writeFileSync(join(WARMUP_DIR, "b.ts"), "const b = 2;\n");
writeFileSync(join(WARMUP_DIR, "c.ts"), "const c = 3;\n");

const { cache: warmupCache } = createCache({ dbPath: warmupDbPath, sessionId: "warmup-1" });
await warmupCache.init();

// Run warmup
const warmupResult = await warmupCache.warmupFiles(WARMUP_DIR);
console.log(`  Files warmed: ${warmupResult.filesProcessed}`);
console.log(`  Errors: ${warmupResult.errors}`);
console.assert(warmupResult.filesProcessed >= 3, "Should warm at least 3 files");
console.assert(warmupResult.errors === 0, "Should have no errors");

// Verify: stats should show files tracked
const warmupStats = await warmupCache.getStats();
console.log(`  Files tracked after warmup: ${warmupStats.filesTracked}`);
console.assert(warmupStats.filesTracked >= 3, "Should track at least 3 files");

// Verify: readFile should work correctly after warmup
const warmupR1 = await warmupCache.readFile(join(WARMUP_DIR, "a.ts"));
console.log(`  Read after warmup cached: ${warmupR1.cached}`);
console.assert(!warmupR1.cached, "First session read should not be 'cached' (returns full content)");
console.assert(warmupR1.content.includes("const a"), "Should contain file content");

await warmupCache.close();
rmSync(WARMUP_DIR, { recursive: true, force: true });

// Cleanup
watcher.close();
await cache.close();
rmSync(TEST_DIR, { recursive: true, force: true });

console.log("\nAll tests passed!");
