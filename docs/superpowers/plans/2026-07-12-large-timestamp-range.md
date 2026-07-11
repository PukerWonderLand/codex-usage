# Large Timestamp Range Fix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复“全部”范围在大规模事件索引下因展开时间戳参数导致的栈溢出。

**Architecture:** 保留现有公开接口和日期范围解析流程，仅将极值计算替换为单次遍历。通过公开的 `summarizeUsageIndex` 构造大规模真实输入进行回归验证。

**Tech Stack:** Node.js 22+、ES Modules、`node:test`、`node:assert`

---

## Chunk 1: 回归测试与最小修复

### Task 1: 添加大规模事件回归测试

**Files:**
- Modify: `test/usage-core.test.js`

- [x] **Step 1: 编写失败测试**

构造超过 17 万条索引事件，调用 `summarizeUsageIndex(index, { preset: "all", bucket: "day" })`，断言汇总数量和范围边界正确。

- [x] **Step 2: 运行定向测试并确认失败**

Run: `node --test --test-name-pattern="大规模索引" test/usage-core.test.js`

Expected: FAIL，错误包含 `Maximum call stack size exceeded`。

### Task 2: 实现单次遍历极值计算

**Files:**
- Modify: `src/usage-core.js:945-984`

- [x] **Step 1: 编写最小实现**

在非空时间戳数组上初始化最小值与最大值，并通过一次循环同时更新两者，替换 `Math.min(...timestamps)` 与 `Math.max(...timestamps)`。

- [x] **Step 2: 运行定向测试并确认通过**

Run: `node --test --test-name-pattern="大规模索引" test/usage-core.test.js`

Expected: PASS。

- [x] **Step 3: 运行核心模块测试**

Run: `node --test test/usage-core.test.js`

Expected: 全部通过。

## Chunk 2: 完整验证

### Task 3: 验证项目和真实页面

**Files:**
- Verify: `src/usage-core.js`
- Verify: `test/usage-core.test.js`

- [x] **Step 1: 运行全量自动化测试**

Run: `npm test`

Expected: 全部通过且没有失败。

- [x] **Step 2: 验证真实 API**

重启或启动修复后的临时服务，请求 `/api/usage?preset=all&bucket=day`，确认返回 200。

- [x] **Step 3: 验证浏览器交互**

重新加载仪表盘，点击“全部”，确认总览、时间分布和渠道分布正常渲染，控制台无相关错误。

> 根据项目规则，本计划不执行未经用户授权的 `git add`、`git commit` 或分支操作。
