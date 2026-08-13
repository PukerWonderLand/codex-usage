import { readdirSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  buildUsageFingerprint,
  completeHourlyTimeline,
  discoverSessionFiles,
  discoverUsageSources,
  previousUsageRange,
  resolveDateRange,
  streamUsageFileEvents,
  usageComparisonFromAggregates,
} from "./usage-core.js";

const STORE_SCHEMA_VERSION = 2;

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localHourKey(date) {
  const hour = String(date.getHours()).padStart(2, "0");
  return `${localDateKey(date)} ${hour}:00`;
}

function startOfLocalWeek(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

function usageFromRow(row) {
  const values = row || {};
  return {
    total: Number(values.total || 0),
    input: Number(values.input || 0),
    cached: Number(values.cached || 0),
    cacheWrite: Number(values.cache_write ?? values.cacheWrite ?? 0),
    output: Number(values.output || 0),
    reasoning: Number(values.reasoning || 0),
  };
}

function rangeParameters(range) {
  const start = range.start ? range.start.getTime() : null;
  const end = range.end ? range.end.getTime() : null;
  return [start, start, end, end];
}

function scopedRangeParameters(range, sessionId = "") {
  return [...rangeParameters(range), sessionId || null, sessionId || null];
}

const THREAD_LABEL_CACHE = new Map();

function threadLabelsByHome(homes) {
  const labels = new Map();
  for (const home of homes) {
    if (home.kind === "project-log") {
      continue;
    }
    let stateFiles = [];
    try {
      stateFiles = readdirSync(home.path, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^state(?:_\d+)?\.sqlite$/.test(entry.name))
        .map((entry) => path.join(home.path, entry.name));
    } catch {
      continue;
    }

    const fingerprint = stateFiles
      .map((stateFile) => {
        try {
          const info = statSync(stateFile);
          let wal = "";
          try {
            const walInfo = statSync(`${stateFile}-wal`);
            wal = `:${walInfo.size}:${walInfo.mtimeMs}`;
          } catch {
            // A checkpointed state database may not have a WAL file.
          }
          return `${stateFile}:${info.size}:${info.mtimeMs}${wal}`;
        } catch {
          return stateFile;
        }
      })
      .join("|");
    const cached = THREAD_LABEL_CACHE.get(home.id);
    if (cached?.fingerprint === fingerprint) {
      for (const [id, label] of cached.labels) {
        labels.set(`${home.id}\0${id}`, label);
      }
      continue;
    }
    const homeLabels = new Map();
    for (const stateFile of stateFiles) {
      let stateDatabase;
      try {
        stateDatabase = new DatabaseSync(stateFile, { readOnly: true });
        const columns = new Set(
          stateDatabase.prepare("PRAGMA table_info(threads)").all().map((column) => column.name),
        );
        if (!columns.has("id")) {
          continue;
        }
        const selectable = ["name", "title", "first_user_message", "preview"].filter((column) =>
          columns.has(column),
        );
        if (!selectable.length) {
          continue;
        }
        const rows = stateDatabase
          .prepare(`SELECT id, ${selectable.join(", ")} FROM threads`)
          .all();
        for (const row of rows) {
          const title = row.title || row.first_user_message || row.preview;
          const value = row.name || title;
          if (typeof value === "string" && value.trim()) {
            homeLabels.set(row.id, {
              name: typeof row.name === "string" ? row.name.trim() : "",
              title: typeof title === "string" ? title.trim() : "",
            });
          }
        }
      } catch {
        // Older/partial Codex homes may not have a readable threads table.
      } finally {
        stateDatabase?.close();
      }
    }
    THREAD_LABEL_CACHE.set(home.id, { fingerprint, labels: homeLabels });
    for (const [id, label] of homeLabels) {
      labels.set(`${home.id}\0${id}`, label);
    }
  }
  return labels;
}

export class UsageStore {
  constructor(options = {}) {
    this.options = options;
    this.databaseFile =
      options.databaseFile || path.join(options.homeDir || os.homedir(), ".codex-usage", "usage-index.sqlite");
    this.database = null;
    this.homes = [];
    this.warnings = [];
    this.generatedAt = "";
    this.fingerprint = "";
    this.checkedAt = "";
    this.summaryCache = new Map();
    this.metadataCache = null;
    this.sessionRowsCache = null;
  }

  async open() {
    if (this.database) {
      return;
    }
    await mkdir(path.dirname(this.databaseFile), { recursive: true });
    this.database = new DatabaseSync(this.databaseFile);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_files (
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        home_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        indexed_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        timestamp_ms INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        channel TEXT NOT NULL,
        project TEXT NOT NULL,
        model TEXT NOT NULL,
        hour_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        week_key TEXT NOT NULL,
        month_key TEXT NOT NULL,
        total INTEGER NOT NULL,
        input INTEGER NOT NULL,
        cached INTEGER NOT NULL,
        cache_write INTEGER NOT NULL DEFAULT 0,
        output INTEGER NOT NULL,
        reasoning INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events(timestamp_ms);
      CREATE INDEX IF NOT EXISTS events_home_idx ON events(home_id);
      CREATE INDEX IF NOT EXISTS events_channel_idx ON events(channel);
      CREATE INDEX IF NOT EXISTS events_project_idx ON events(project);
      CREATE INDEX IF NOT EXISTS events_model_idx ON events(model);
    `);
    const version = Number(this.database.prepare("PRAGMA user_version").get().user_version || 0);
    if (version === 1) {
      this.database.exec("ALTER TABLE events ADD COLUMN cache_write INTEGER NOT NULL DEFAULT 0");
    } else if (version !== 0 && version !== STORE_SCHEMA_VERSION) {
      throw new Error(`不支持的用量索引版本：${version}`);
    }
    this.database.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`);
    this.generatedAt = this.readMeta("generated_at");
    this.fingerprint = this.readMeta("fingerprint");
  }

  readMeta(key) {
    return this.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(key)?.value || "";
  }

  writeMeta(key, value) {
    this.database
      .prepare("INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, String(value));
  }

  async usageFiles(homes) {
    const files = [];
    const warnings = [];
    for (const home of homes) {
      try {
        if (home.kind === "project-log" && home.usageLogPath) {
          files.push({ filePath: home.usageLogPath, source: home, info: await stat(home.usageLogPath) });
          continue;
        }
        for (const filePath of await discoverSessionFiles(home.path)) {
          files.push({ filePath, source: home, info: await stat(filePath) });
        }
      } catch (error) {
        warnings.push(`无法读取 ${home.path}: ${error.message}`);
      }
    }
    return { files, warnings };
  }

  async replaceFile({ filePath, source, info }) {
    const database = this.database;
    const insertSource = database.prepare(`
      INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        kind = excluded.kind,
        home_id = excluded.home_id,
        home_label = excluded.home_label,
        home_path = excluded.home_path,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
    `);
    const insertEvent = database.prepare(`
      INSERT INTO events (
        source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, total, input, cached, cache_write, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    database.exec("BEGIN IMMEDIATE");
    try {
      insertSource.run(
        filePath,
        source.kind || "codex",
        source.id,
        source.label,
        source.path,
        info.size,
        info.mtimeMs,
        new Date().toISOString(),
      );
      database.prepare("DELETE FROM events WHERE source_path = ?").run(filePath);
      await streamUsageFileEvents(filePath, source, (event) => {
        const date = new Date(event.timestampMs);
        insertEvent.run(
          filePath,
          event.timestampMs,
          event.sessionId,
          event.homeId,
          event.homeLabel,
          event.channel,
          event.project || "Unknown cwd",
          event.model || "Unknown model",
          localHourKey(date),
          localDateKey(date),
          localDateKey(startOfLocalWeek(date)),
          localDateKey(date).slice(0, 7),
          event.usage.total,
          event.usage.input,
          event.usage.cached,
          event.usage.cacheWrite,
          event.usage.output,
          event.usage.reasoning,
        );
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async sync({ force = false, options } = {}) {
    await this.open();
    const syncOptions = options || this.options;
    this.options = syncOptions;
    const homes = await discoverUsageSources(syncOptions);
    const status = await buildUsageFingerprint({ ...syncOptions, homes });
    const { files, warnings } = await this.usageFiles(homes);
    const knownFiles = new Set(files.map((file) => file.filePath));
    let updatedFileCount = 0;

    for (const file of files) {
      const existing = this.database
        .prepare("SELECT size, mtime_ms FROM source_files WHERE path = ?")
        .get(file.filePath);
      if (!force && existing && Number(existing.size) === file.info.size && Number(existing.mtime_ms) === file.info.mtimeMs) {
        continue;
      }
      try {
        await this.replaceFile(file);
        updatedFileCount += 1;
      } catch (error) {
        warnings.push(`无法索引 ${file.filePath}: ${error.message}`);
      }
    }

    for (const row of this.database.prepare("SELECT path FROM source_files").all()) {
      if (!knownFiles.has(row.path)) {
        this.database.prepare("DELETE FROM source_files WHERE path = ?").run(row.path);
      }
    }

    const changed = this.fingerprint !== status.fingerprint;
    this.homes = homes;
    this.warnings = warnings;
    if (changed || force || !this.generatedAt) {
      this.generatedAt = new Date().toISOString();
    }
    this.fingerprint = status.fingerprint;
    this.checkedAt = status.checkedAt;
    this.writeMeta("generated_at", this.generatedAt);
    this.writeMeta("fingerprint", this.fingerprint);
    if (changed || force) {
      this.summaryCache.clear();
      this.metadataCache = null;
      this.sessionRowsCache = null;
    }
    return { ...status, updatedFileCount };
  }

  metadata() {
    if (this.metadataCache) {
      return this.metadataCache;
    }
    const totals = this.database
      .prepare("SELECT COUNT(*) AS event_count, COUNT(DISTINCT session_id) AS session_count FROM events")
      .get();
    const homeRows = new Map(
      this.database
        .prepare(`
          SELECT home_id, COUNT(*) AS event_count, COUNT(DISTINCT session_id) AS session_count
          FROM events GROUP BY home_id
        `)
        .all()
        .map((row) => [row.home_id, row]),
    );
    this.metadataCache = {
      generatedAt: this.generatedAt,
      eventCount: Number(totals.event_count || 0),
      sessionCount: Number(totals.session_count || 0),
      homeCount: this.homes.length,
      homes: this.homes.map((home) => {
        const row = homeRows.get(home.id);
        return {
          ...home,
          status: row ? "active" : "no-events",
          eventCount: Number(row?.event_count || 0),
          sessionCount: Number(row?.session_count || 0),
        };
      }),
      warnings: this.warnings,
    };
    return this.metadataCache;
  }

  listSessions() {
    const threadLabels = threadLabelsByHome(this.homes);
    if (!this.sessionRowsCache) {
      this.sessionRowsCache = this.database
        .prepare(`
        SELECT
          session_id AS id,
          MAX(home_id) AS home_id,
          MIN(timestamp_ms) AS first_at,
          MAX(timestamp_ms) AS last_at,
          MAX(channel) AS channel,
          MAX(project) AS project,
          MAX(model) AS model,
          COUNT(*) AS event_count,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(cache_write), 0) AS cache_write,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        GROUP BY session_id
        ORDER BY last_at DESC
        `)
        .all();
    }
    return this.sessionRowsCache.map((row) => {
        const label = threadLabels.get(`${row.home_id}\0${row.id}`) || {};
        return {
          id: row.id,
          name: label.name || "",
          title: label.title || "",
          firstAt: new Date(Number(row.first_at)).toISOString(),
          lastAt: new Date(Number(row.last_at)).toISOString(),
          channel: row.channel,
          project: row.project,
          model: row.model,
          eventCount: Number(row.event_count || 0),
          total: usageFromRow(row),
        };
      });
  }

  sessionSource(sessionId) {
    const row = this.database
      .prepare(`
        SELECT
          events.session_id,
          source_files.path AS file_path,
          source_files.home_id,
          source_files.home_label,
          source_files.home_path
        FROM events
        JOIN source_files ON source_files.path = events.source_path
        WHERE events.session_id = ?
        LIMIT 1
      `)
      .get(sessionId);
    return row
      ? {
          id: row.session_id,
          filePath: row.file_path,
          homeId: row.home_id,
          homeLabel: row.home_label,
          homePath: row.home_path,
        }
      : null;
  }

  aggregateRange(range, sessionId = "") {
    return this.database
      .prepare(`
        SELECT
          COUNT(*) AS event_count,
          COUNT(DISTINCT session_id) AS session_count,
          COUNT(DISTINCT home_id) AS home_count,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(cache_write), 0) AS cache_write,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE (? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)
          AND (? IS NULL OR session_id = ?)
      `)
      .get(...scopedRangeParameters(range, sessionId));
  }

  groupedRange(column, range, orderBy = "total DESC", sessionId = "") {
    const allowedColumns = new Set(["channel", "home_label", "model", "project", "hour_key", "day_key", "week_key", "month_key"]);
    if (!allowedColumns.has(column)) {
      throw new Error(`不支持的聚合字段：${column}`);
    }
    const rows = this.database
      .prepare(`
        SELECT
          ${column} AS key,
          COUNT(*) AS count,
          COUNT(DISTINCT session_id) AS sessions,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(cache_write), 0) AS cache_write,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE (? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)
          AND (? IS NULL OR session_id = ?)
        GROUP BY ${column}
        ORDER BY ${orderBy}
      `)
      .all(...scopedRangeParameters(range, sessionId));
    return rows.map((row) => ({
      key: row.key,
      name: row.key,
      count: Number(row.count || 0),
      sessions: Number(row.sessions || 0),
      total: usageFromRow(row),
    }));
  }

  timelineRange(range, bucket, sessionId = "") {
    const bucketColumns = {
      hour: "hour_key",
      day: "day_key",
      week: "week_key",
      month: "month_key",
    };
    const bucketColumn = bucketColumns[bucket] || bucketColumns.day;
    const rows = this.groupedRange(bucketColumn, range, "key ASC", sessionId);
    const channelRows = this.database
      .prepare(`
        SELECT
          ${bucketColumn} AS bucket_key,
          channel AS key,
          COUNT(*) AS count,
          COUNT(DISTINCT session_id) AS sessions,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(cache_write), 0) AS cache_write,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE (? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)
          AND (? IS NULL OR session_id = ?)
        GROUP BY ${bucketColumn}, channel
        ORDER BY ${bucketColumn} ASC, total DESC
      `)
      .all(...scopedRangeParameters(range, sessionId));
    const channelsByBucket = new Map();
    for (const row of channelRows) {
      const channels = channelsByBucket.get(row.bucket_key) || [];
      channels.push({
        key: row.key,
        name: row.key,
        count: Number(row.count || 0),
        sessions: Number(row.sessions || 0),
        total: usageFromRow(row),
      });
      channelsByBucket.set(row.bucket_key, channels);
    }
    return completeHourlyTimeline(
      rows.map((row) => ({ ...row, channels: channelsByBucket.get(row.key) || [] })),
      range,
      bucket,
    );
  }

  summarize(filters = {}) {
    const cacheKey = JSON.stringify({ fingerprint: this.fingerprint, filters });
    const cached = this.summaryCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const sessionId = filters.sessionId || "";
    const bounds = this.database
      .prepare("SELECT MIN(timestamp_ms) AS minimum, MAX(timestamp_ms) AS maximum FROM events WHERE (? IS NULL OR session_id = ?)")
      .get(sessionId || null, sessionId || null);
    const boundaryEvents = [];
    if (bounds.minimum !== null) {
      boundaryEvents.push({ timestamp: new Date(Number(bounds.minimum)).toISOString() });
    }
    if (bounds.maximum !== null) {
      boundaryEvents.push({ timestamp: new Date(Number(bounds.maximum)).toISOString() });
    }
    const range = resolveDateRange(filters, boundaryEvents);
    const aggregate = this.aggregateRange(range, sessionId);
    const totals = usageFromRow(aggregate);
    const previousRange = previousUsageRange(range);
    const previousAggregate = previousRange ? this.aggregateRange(previousRange, sessionId) : null;
    const comparison = usageComparisonFromAggregates({
      range,
      currentTotals: totals,
      previousTotals: usageFromRow(previousAggregate),
      previousEventCount: Number(previousAggregate?.event_count || 0),
      previousSessionCount: Number(previousAggregate?.session_count || 0),
      now: filters.now ? new Date(filters.now) : new Date(),
    });
    const bucket = filters.bucket || "day";
    const summary = {
      generatedAt: this.generatedAt,
      range: {
        preset: range.preset,
        start: range.start ? range.start.toISOString() : null,
        end: range.end ? range.end.toISOString() : null,
        bucket,
        rolling: Boolean(range.rolling),
      },
      totals,
      comparison,
      eventCount: Number(aggregate.event_count || 0),
      sessionCount: Number(aggregate.session_count || 0),
      homeCount: Number(aggregate.home_count || 0),
      timeline: this.timelineRange(range, bucket, sessionId),
      channels: this.groupedRange("channel", range, "total DESC", sessionId),
      homes: this.groupedRange("home_label", range, "total DESC", sessionId),
      models: this.groupedRange("model", range, "total DESC", sessionId),
      projects: this.groupedRange("project", range, "total DESC", sessionId),
    };
    if (this.summaryCache.size >= 100) {
      this.summaryCache.delete(this.summaryCache.keys().next().value);
    }
    this.summaryCache.set(cacheKey, summary);
    return summary;
  }

  close() {
    if (!this.database) {
      return;
    }
    this.database.close();
    this.database = null;
  }
}
