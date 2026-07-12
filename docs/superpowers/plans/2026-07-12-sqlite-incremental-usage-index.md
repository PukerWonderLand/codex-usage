# SQLite Incremental Usage Index Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用磁盘 SQLite 增量索引替代仪表盘与 summary 的全量内存事件缓存，使常驻内存不随历史事件总数线性增长。

**Architecture:** `usage-core` 提供统一的流式事件扫描入口，`usage-store` 负责文件级增量同步与 SQL 聚合，server 和 CLI summary 通过 store 查询；完整导出路径保持不变。

**Tech Stack:** Node.js 22.13+、`node:sqlite`、ES Modules、`node:test`

---

## Chunk 1: 流式解析与 SQLite 存储

### Task 1: 建立流式事件契约

**Files:**
- Modify: `src/usage-core.js`
- Modify: `test/usage-core.test.js`

- [x] 编写测试，验证会话日志与项目日志通过回调逐条产生统一文本事件。
- [x] 运行定向测试并确认缺少流式入口而失败。
- [x] 提取流式扫描函数，并让现有 `buildUsageIndex` 复用它。
- [x] 运行核心测试并确认结果不变。

### Task 2: 建立 SQLite 文件同步

**Files:**
- Create: `src/usage-store.js`
- Create: `test/usage-store.test.js`

- [x] 编写首次同步失败测试，覆盖数据库创建、事件写入和 metadata。
- [x] 实现 schema、prepared statements 与单文件事务。
- [x] 编写未变化文件跳过和变化文件重建测试。
- [x] 实现文件状态比较、删除文件清理和 warnings。

## Chunk 2: 聚合查询兼容

### Task 3: 实现 SQLite 汇总

**Files:**
- Modify: `src/usage-store.js`
- Modify: `src/usage-core.js`
- Modify: `test/usage-store.test.js`

- [x] 编写 SQLite 与 `summarizeUsageIndex` 结果一致的失败测试。
- [x] 实现范围 totals、distinct sessions/homes 和维度分组。
- [x] 实现时间线渠道嵌套、小时补零与上一周期比较。
- [x] 运行 store 测试并修正响应结构差异。

## Chunk 3: Server 与 CLI 接入

### Task 4: 接入仪表盘 API

**Files:**
- Modify: `src/server.js`
- Modify: `test/server.test.js`

- [x] 修改 server 测试以使用隔离数据库并验证增量刷新。
- [x] 用 SQLite store 替换普通 `/api/usage` 与 `/api/summary` 的内存索引缓存。
- [x] 保持 `detail=full` 原路径不变。
- [x] 验证导入与移除目录会使 store 重新同步。

### Task 5: 接入 CLI summary 与版本约束

**Files:**
- Modify: `src/cli.js`
- Modify: `package.json`
- Modify: `test/cli.test.js`
- Modify: `README.md`

- [x] 让 `summary` 使用 SQLite store，`json` 保持完整报告。
- [x] 将 Node engines 调整为 `>=22.13` 并更新说明。
- [x] 验证 CLI JSON 输出契约不变。

## Chunk 4: 完整与低内存验证

### Task 6: 验证长期运行路径

**Files:**
- Verify: `src/usage-store.js`
- Verify: `src/server.js`
- Verify: `src/cli.js`

- [x] 运行 `npm test`。
- [x] 在 256MB 堆上首次加载并连续强制刷新真实数据。
- [x] 验证 RSS 不再因每次刷新保留新的全量事件数组。
- [x] 在浏览器验证“今日 → 全部”、自动刷新、总览与图表。
- [x] 检查数据库文件大小、服务存活和工作区差异。

> 根据项目规则，本计划不创建工作树、不使用子代理，也不执行未经用户授权的 git add、commit 或 push。
