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

const STORE_SCHEMA_VERSION = 4;

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
const MAX_THREAD_LABEL_LENGTH = 240;

function compactThreadLabel(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_THREAD_LABEL_LENGTH);
}

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
              name: compactThreadLabel(row.name),
              title: compactThreadLabel(title),
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
        indexed_offset INTEGER NOT NULL DEFAULT 0,
        parser_state TEXT NOT NULL DEFAULT '',
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
      CREATE TABLE IF NOT EXISTS event_rollups (
        source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        min_timestamp_ms INTEGER NOT NULL,
        max_timestamp_ms INTEGER NOT NULL,
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
        event_count INTEGER NOT NULL,
        total INTEGER NOT NULL,
        input INTEGER NOT NULL,
        cached INTEGER NOT NULL,
        cache_write INTEGER NOT NULL DEFAULT 0,
        output INTEGER NOT NULL,
        reasoning INTEGER NOT NULL,
        PRIMARY KEY (source_path, hour_key, session_id, home_id, home_label, channel, project, model)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events(timestamp_ms);
      CREATE INDEX IF NOT EXISTS events_source_path_idx ON events(source_path);
      CREATE INDEX IF NOT EXISTS events_home_idx ON events(home_id);
      CREATE INDEX IF NOT EXISTS events_channel_idx ON events(channel);
      CREATE INDEX IF NOT EXISTS events_project_idx ON events(project);
      CREATE INDEX IF NOT EXISTS events_model_idx ON events(model);
      CREATE INDEX IF NOT EXISTS event_rollups_time_idx ON event_rollups(min_timestamp_ms, max_timestamp_ms);
      CREATE INDEX IF NOT EXISTS event_rollups_session_idx ON event_rollups(session_id);
    `);
    const version = Number(this.database.prepare("PRAGMA user_version").get().user_version || 0);
    if (version === 1) {
      this.database.exec("ALTER TABLE events ADD COLUMN cache_write INTEGER NOT NULL DEFAULT 0");
    }
    if (version > STORE_SCHEMA_VERSION) {
      throw new Error(`不支持的用量索引版本：${version}`);
    }
    const sourceColumns = new Set(
      this.database.prepare("PRAGMA table_info(source_files)").all().map((column) => column.name),
    );
    if (!sourceColumns.has("indexed_offset")) {
      this.database.exec("ALTER TABLE source_files ADD COLUMN indexed_offset INTEGER NOT NULL DEFAULT 0");
      this.database.exec("UPDATE source_files SET indexed_offset = size");
    }
    if (!sourceColumns.has("parser_state")) {
      this.database.exec("ALTER TABLE source_files ADD COLUMN parser_state TEXT NOT NULL DEFAULT ''");
    }
    const rollupCount = Number(this.database.prepare("SELECT COUNT(*) AS count FROM event_rollups").get().count || 0);
    const eventCount = Number(this.database.prepare("SELECT COUNT(*) AS count FROM events").get().count || 0);
    if (rollupCount === 0 && eventCount > 0) {
      this.database.exec(`
        INSERT INTO event_rollups (
          source_path, min_timestamp_ms, max_timestamp_ms, session_id, home_id, home_label,
          channel, project, model, hour_key, day_key, week_key, month_key, event_count,
          total, input, cached, cache_write, output, reasoning
        )
        SELECT
          source_path, MIN(timestamp_ms), MAX(timestamp_ms), session_id, home_id, home_label,
          channel, project, model, hour_key, day_key, week_key, month_key, COUNT(*),
          SUM(total), SUM(input), SUM(cached), SUM(cache_write), SUM(output), SUM(reasoning)
        FROM events
        GROUP BY source_path, hour_key, session_id, home_id, home_label, channel, project, model
      `);
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

  baselineParserState(filePath) {
    const totals = this.database
      .prepare(`
        SELECT
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(cache_write), 0) AS cache_write,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events WHERE source_path = ?
      `)
      .get(filePath);
    const latest = this.database
      .prepare(`
        SELECT timestamp_ms, session_id, channel, project, model
        FROM events WHERE source_path = ?
        ORDER BY timestamp_ms DESC, id DESC LIMIT 1
      `)
      .get(filePath);
    if (!latest) {
      return null;
    }
    return {
      meta: {
        id: latest.session_id,
        source: "",
        originator: "",
        cwd: latest.project,
      },
      model: latest.model,
      firstAt: "",
      lastAt: new Date(Number(latest.timestamp_ms)).toISOString(),
      channel: latest.channel,
      previousCumulative: usageFromRow(totals),
    };
  }

  async updateFile({ filePath, source, info }, existing = null, { force = false } = {}) {
    const database = this.database;
    const insertSource = database.prepare(`
      INSERT INTO source_files (
        path, kind, home_id, home_label, home_path, size, mtime_ms,
        indexed_offset, parser_state, indexed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        kind = excluded.kind,
        home_id = excluded.home_id,
        home_label = excluded.home_label,
        home_path = excluded.home_path,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        indexed_offset = excluded.indexed_offset,
        parser_state = excluded.parser_state,
        indexed_at = excluded.indexed_at
    `);
    const insertEvent = database.prepare(`
      INSERT INTO events (
        source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, total, input, cached, cache_write, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const upsertRollup = database.prepare(`
      INSERT INTO event_rollups (
        source_path, min_timestamp_ms, max_timestamp_ms, session_id, home_id, home_label,
        channel, project, model, hour_key, day_key, week_key, month_key, event_count,
        total, input, cached, cache_write, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_path, hour_key, session_id, home_id, home_label, channel, project, model)
      DO UPDATE SET
        min_timestamp_ms = MIN(min_timestamp_ms, excluded.min_timestamp_ms),
        max_timestamp_ms = MAX(max_timestamp_ms, excluded.max_timestamp_ms),
        event_count = event_count + 1,
        total = total + excluded.total,
        input = input + excluded.input,
        cached = cached + excluded.cached,
        cache_write = cache_write + excluded.cache_write,
        output = output + excluded.output,
        reasoning = reasoning + excluded.reasoning
    `);
    const sourceKind = source.kind || "codex";
    let append = Boolean(
      !force
      && existing
      && sourceKind === existing.kind
      && source.id === existing.home_id
      && info.size > Number(existing.size)
      && Number(existing.indexed_offset) <= Number(existing.size),
    );
    let offset = append ? Number(existing.indexed_offset) : 0;
    let parserState = null;
    if (append && existing.parser_state) {
      try {
        parserState = JSON.parse(existing.parser_state);
      } catch {
        append = false;
      }
    } else if (append && sourceKind !== "project-log") {
      parserState = this.baselineParserState(filePath);
      offset = Number(existing.size);
      append = Boolean(parserState);
    } else if (append) {
      append = false;
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      insertSource.run(
        filePath,
        sourceKind,
        source.id,
        source.label,
        source.path,
        info.size,
        info.mtimeMs,
        offset,
        parserState ? JSON.stringify(parserState) : "",
        new Date().toISOString(),
      );
      if (!append) {
        database.prepare("DELETE FROM events WHERE source_path = ?").run(filePath);
        database.prepare("DELETE FROM event_rollups WHERE source_path = ?").run(filePath);
      }
      const result = await streamUsageFileEvents(filePath, source, (event) => {
        const date = new Date(event.timestampMs);
        const hourKey = localHourKey(date);
        const dayKey = localDateKey(date);
        const weekKey = localDateKey(startOfLocalWeek(date));
        const monthKey = dayKey.slice(0, 7);
        const project = event.project || "Unknown cwd";
        const model = event.model || "Unknown model";
        insertEvent.run(
          filePath,
          event.timestampMs,
          event.sessionId,
          event.homeId,
          event.homeLabel,
          event.channel,
          project,
          model,
          hourKey,
          dayKey,
          weekKey,
          monthKey,
          event.usage.total,
          event.usage.input,
          event.usage.cached,
          event.usage.cacheWrite,
          event.usage.output,
          event.usage.reasoning,
        );
        upsertRollup.run(
          filePath,
          event.timestampMs,
          event.timestampMs,
          event.sessionId,
          event.homeId,
          event.homeLabel,
          event.channel,
          project,
          model,
          hourKey,
          dayKey,
          weekKey,
          monthKey,
          event.usage.total,
          event.usage.input,
          event.usage.cached,
          event.usage.cacheWrite,
          event.usage.output,
          event.usage.reasoning,
        );
      }, { offset: append ? offset : 0, state: append ? parserState : null });
      database
        .prepare(`
          UPDATE source_files
          SET size = ?, mtime_ms = ?, indexed_offset = ?, parser_state = ?, indexed_at = ?
          WHERE path = ?
        `)
        .run(
          info.size,
          info.mtimeMs,
          result.offset,
          JSON.stringify(result.state || {}),
          new Date().toISOString(),
          filePath,
        );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async syncFile(filePath, source) {
    await this.open();
    const info = await stat(filePath);
    const existing = this.database
      .prepare(`
        SELECT kind, home_id, size, mtime_ms, indexed_offset, parser_state
        FROM source_files WHERE path = ?
      `)
      .get(filePath);
    if (existing && Number(existing.size) === info.size && Number(existing.mtime_ms) === info.mtimeMs) {
      return { updated: false, appended: false };
    }
    const appended = Boolean(existing && info.size > Number(existing.size));
    await this.updateFile({ filePath, source, info }, existing);
    this.generatedAt = new Date().toISOString();
    this.writeMeta("generated_at", this.generatedAt);
    this.summaryCache.clear();
    this.metadataCache = null;
    this.sessionRowsCache = null;
    return { updated: true, appended };
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
        .prepare(`
          SELECT kind, home_id, size, mtime_ms, indexed_offset, parser_state
          FROM source_files WHERE path = ?
        `)
        .get(file.filePath);
      if (!force && existing && Number(existing.size) === file.info.size && Number(existing.mtime_ms) === file.info.mtimeMs) {
        continue;
      }
      try {
        await this.updateFile(file, existing, { force });
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
      .prepare("SELECT COALESCE(SUM(event_count), 0) AS event_count, COUNT(DISTINCT session_id) AS session_count FROM event_rollups")
      .get();
    const homeRows = new Map(
      this.database
        .prepare(`
          SELECT home_id, COALESCE(SUM(event_count), 0) AS event_count, COUNT(DISTINCT session_id) AS session_count
          FROM event_rollups GROUP BY home_id
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
          MIN(min_timestamp_ms) AS first_at,
          MAX(max_timestamp_ms) AS last_at,
          MAX(channel) AS channel,
          MAX(project) AS project,
          MAX(model) AS model,
          COALESCE(SUM(event_count), 0) AS event_count,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(cache_write), 0) AS cache_write,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM event_rollups
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
          event_rollups.session_id,
          source_files.path AS file_path,
          source_files.home_id,
          source_files.home_label,
          source_files.home_path
        FROM event_rollups
        JOIN source_files ON source_files.path = event_rollups.source_path
        WHERE event_rollups.session_id = ?
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

  aggregateRange(range, sessionId = "", exact = false) {
    const table = exact ? "events" : "event_rollups";
    const eventCount = exact ? "COUNT(*)" : "SUM(event_count)";
    const timePredicate = exact
      ? "(? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)"
      : "(? IS NULL OR max_timestamp_ms >= ?) AND (? IS NULL OR min_timestamp_ms <= ?)";
    return this.database
      .prepare(`
        SELECT
          COALESCE(${eventCount}, 0) AS event_count,
          COUNT(DISTINCT session_id) AS session_count,
          COUNT(DISTINCT home_id) AS home_count,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(cache_write), 0) AS cache_write,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM ${table}
        WHERE ${timePredicate}
          AND (? IS NULL OR session_id = ?)
      `)
      .get(...scopedRangeParameters(range, sessionId));
  }

  groupedRange(column, range, orderBy = "total DESC", sessionId = "", exact = false) {
    const allowedColumns = new Set(["channel", "home_label", "model", "project", "hour_key", "day_key", "week_key", "month_key"]);
    if (!allowedColumns.has(column)) {
      throw new Error(`不支持的聚合字段：${column}`);
    }
    const table = exact ? "events" : "event_rollups";
    const eventCount = exact ? "COUNT(*)" : "SUM(event_count)";
    const timePredicate = exact
      ? "(? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)"
      : "(? IS NULL OR max_timestamp_ms >= ?) AND (? IS NULL OR min_timestamp_ms <= ?)";
    const rows = this.database
      .prepare(`
        SELECT
          ${column} AS key,
          COALESCE(${eventCount}, 0) AS count,
          COUNT(DISTINCT session_id) AS sessions,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(cache_write), 0) AS cache_write,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM ${table}
        WHERE ${timePredicate}
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

  timelineRange(range, bucket, sessionId = "", exact = false) {
    const bucketColumns = {
      hour: "hour_key",
      day: "day_key",
      week: "week_key",
      month: "month_key",
    };
    const bucketColumn = bucketColumns[bucket] || bucketColumns.day;
    const rows = this.groupedRange(bucketColumn, range, "key ASC", sessionId, exact);
    const table = exact ? "events" : "event_rollups";
    const eventCount = exact ? "COUNT(*)" : "SUM(event_count)";
    const timePredicate = exact
      ? "(? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)"
      : "(? IS NULL OR max_timestamp_ms >= ?) AND (? IS NULL OR min_timestamp_ms <= ?)";
    const channelRows = this.database
      .prepare(`
        SELECT
          ${bucketColumn} AS bucket_key,
          channel AS key,
          COALESCE(${eventCount}, 0) AS count,
          COUNT(DISTINCT session_id) AS sessions,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(cache_write), 0) AS cache_write,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM ${table}
        WHERE ${timePredicate}
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
      .prepare("SELECT MIN(min_timestamp_ms) AS minimum, MAX(max_timestamp_ms) AS maximum FROM event_rollups WHERE (? IS NULL OR session_id = ?)")
      .get(sessionId || null, sessionId || null);
    const boundaryEvents = [];
    if (bounds.minimum !== null) {
      boundaryEvents.push({ timestamp: new Date(Number(bounds.minimum)).toISOString() });
    }
    if (bounds.maximum !== null) {
      boundaryEvents.push({ timestamp: new Date(Number(bounds.maximum)).toISOString() });
    }
    const range = resolveDateRange(filters, boundaryEvents);
    // Hourly rollups are exact only when the requested range follows bucket
    // boundaries. A rolling 24-hour range can cut through both boundary hours.
    const exact = Boolean(range.rolling);
    const aggregate = this.aggregateRange(range, sessionId, exact);
    const totals = usageFromRow(aggregate);
    const previousRange = previousUsageRange(range);
    const previousAggregate = previousRange ? this.aggregateRange(previousRange, sessionId, exact) : null;
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
      timeline: this.timelineRange(range, bucket, sessionId, exact),
      channels: this.groupedRange("channel", range, "total DESC", sessionId, exact),
      homes: this.groupedRange("home_label", range, "total DESC", sessionId, exact),
      models: this.groupedRange("model", range, "total DESC", sessionId, exact),
      projects: this.groupedRange("project", range, "total DESC", sessionId, exact),
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
