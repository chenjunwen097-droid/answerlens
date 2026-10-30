import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function nextReportVersion(reports, brand, product = "") {
  const versions = reports
    .filter((item) => item.brand === brand && (item.product || "") === (product || ""))
    .map((item) => Number(item.version) || 1);
  return versions.length ? Math.max(...versions) + 1 : 1;
}

export function createReportStore(dataDir) {
  const directory = path.resolve(dataDir);
  const databaseFile = path.join(directory, "answerlens.db");
  const jsonFile = path.join(directory, "answerlens.json");
  let storage = "json";
  let sqlite = null;

  fs.mkdirSync(directory, { recursive: true });
  try {
    const { DatabaseSync } = require("node:sqlite");
    sqlite = new DatabaseSync(databaseFile);
    sqlite.exec(`CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    storage = "sqlite";
  } catch {
    if (!fs.existsSync(jsonFile)) fs.writeFileSync(jsonFile, JSON.stringify({ reports: [] }));
  }

  function readJson() {
    try {
      return JSON.parse(fs.readFileSync(jsonFile, "utf8"));
    } catch {
      return { reports: [] };
    }
  }

  return {
    get storage() {
      return storage;
    },

    save(report) {
      const createdAt = new Date().toISOString();
      if (sqlite) {
        sqlite
          .prepare("INSERT OR REPLACE INTO reports (id, payload, created_at) VALUES (?, ?, ?)")
          .run(report.id, JSON.stringify(report), createdAt);
        return;
      }
      const data = readJson();
      data.reports = [report, ...data.reports.filter((item) => item.id !== report.id)];
      fs.writeFileSync(jsonFile, JSON.stringify(data, null, 2));
    },

    list() {
      if (sqlite) {
        return sqlite
          .prepare("SELECT payload FROM reports ORDER BY created_at DESC LIMIT 100")
          .all()
          .map((row) => JSON.parse(row.payload));
      }
      return readJson().reports;
    },

    get(id) {
      if (sqlite) {
        const row = sqlite.prepare("SELECT payload FROM reports WHERE id = ?").get(id);
        return row ? JSON.parse(row.payload) : null;
      }
      return readJson().reports.find((report) => report.id === id) || null;
    },

    close() {
      if (sqlite) {
        sqlite.close();
        sqlite = null;
      }
    }
  };
}
