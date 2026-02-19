export interface CacheConfig {
  /** Path to the database file */
  dbPath: string;
  /** Session identifier. Each session tracks its own read state independently. */
  sessionId: string;
  /** Directories to watch for file changes. Defaults to cwd. */
  watchPaths?: string[];
  /** Glob patterns to ignore (e.g. ["dist", "*.log"]). */
  ignorePatterns?: string[];
}

export interface FileReadResult {
  /** Whether this was served from cache */
  cached: boolean;
  /** The file content (full on first read, diff on subsequent) */
  content: string;
  /** If cached and changed, the unified diff */
  diff?: string;
  /** Lines changed since last read */
  linesChanged?: number;
  /** Total lines in the file */
  totalLines?: number;
  /** Content hash */
  hash: string;
}

export interface DirectoryReadResult {
  /** Whether this was served from cache */
  cached: boolean;
  /** The directory listing (full or diff) */
  content: string;
  /** Number of files added/removed since last read */
  changes?: number;
  /** Hash of the directory structure */
  hash: string;
}

export interface RevertResult {
  success: boolean;
  message: string;
  restoredHash?: string;
}

export interface WorkingSetFile {
  path: string;
  status: "modified" | "read";
  edits: number;
  lastActivity: number; // timestamp
}

export interface HistoryEntry {
  path: string;
  timestamp: number;
  type: "read" | "write";
  hash: string;
}

export interface SearchMatch {
  path: string;
  line: number;
  context: string; // snippet with highlights
}

export interface SearchResult {
  matches: SearchMatch[];
  totalMatches: number;
  query: string;
}

export interface ToolMetric {
  tool: string;
  calls: number;
  tokensOriginal: number;
  tokensActual: number;
  tokensSaved: number;
}

export interface SessionMetrics {
  tools: ToolMetric[];
  totalOriginal: number;
  totalActual: number;
  totalSaved: number;
  percentSaved: number;
}

export interface CacheStats {
  /** Total files cached */
  filesTracked: number;
  /** Approximate tokens saved across all sessions */
  tokensSaved: number;
  /** Approximate tokens saved in this session */
  sessionTokensSaved: number;
}
