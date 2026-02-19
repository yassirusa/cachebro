import { watch, type FSWatcher } from "chokidar";
import { resolve } from "path";
import type { CacheStore } from "./cache.js";

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private cache: CacheStore;
  private debounceMs: number;

  constructor(cache: CacheStore, debounceMs = 100) {
    this.cache = cache;
    this.debounceMs = debounceMs;
  }

  watch(paths: string[], ignorePatterns: string[] = []): void {
    if (this.watcher) {
      this.watcher.add(paths);
      // Note: chokidar doesn't support updating ignored patterns dynamically easily
      // so new ignore patterns won't apply to existing watcher instance
      return;
    }

    this.watcher = watch(paths, {
      ignored: [
        /(^|[\/\\])\../, // ignore dotfiles
        /node_modules/,
        ...ignorePatterns
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: this.debounceMs,
        pollInterval: 100
      }
    });

    this.watcher
      .on("add", (path) => this.handleChange("rename", path))
      .on("change", (path) => this.handleChange("change", path))
      .on("unlink", (path) => this.handleChange("rename", path))
      .on("unlinkDir", (path) => this.handleChange("rename", path));
  }

  async close(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private async handleChange(event: string, filePath: string): Promise<void> {
    try {
      const { existsSync } = await import("fs");
      if (existsSync(filePath)) {
        await this.cache.onFileChanged(filePath);
      } else {
        await this.cache.onFileDeleted(filePath);
      }
    } catch {
      // File may be in a transient state during writes
    }
  }
}
