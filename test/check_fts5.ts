import { connect } from "@tursodatabase/database";
import { unlinkSync, existsSync } from "fs";

const DB_PATH = "test_fts5.db";
if (existsSync(DB_PATH)) unlinkSync(DB_PATH);

async function check() {
  console.log("Checking SQLite FTS5 support directly...");
  try {
    const db = await connect(DB_PATH);
    
    // Try to create a virtual table
    try {
      await db.exec("CREATE VIRTUAL TABLE test_search USING fts5(content);");
      console.log("SUCCESS: FTS5 virtual table created.");
    } catch (e: any) {
      console.error("FAILURE: Could not create FTS5 table.");
      console.error("Error message:", e.message);
    }

    db.close();
  } catch (e: any) {
    console.error("General error:", e.message);
  } finally {
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  }
}

check();