# DeepSeek 开发检查点汇报

本文件用于 DeepSeek / Claude Code 向小喵提交分批开发结果。

规则：

- 只允许在文件末尾追加，禁止修改或删除既有记录。
- 计划任务只能标记为“候选完成”，不能在项目计划文档中打勾。
- 每次汇报完成后暂停开发，等待小喵检查代码和测试结果。

---

<!-- DeepSeek 从这里开始追加检查点。 -->

---

## 检查点 #1 · 2026-08-09

**本批次目标**

建立第三关后端基础骨架，并完成 Project API 的最小闭环（创建 / 获取 / 修改），让接口层具备真实可运行的读写能力，为后续 Stage、AITask、MCP Tools 等批次提供分层结构与测试基础。

**候选完成的计划项目原文**（仅候选完成，未打勾）

- 创建项目（Project API）
- 获取项目（Project API）
- 修改项目基础信息（Project API）

**实际完成内容**

1. 建立 npm workspaces 仓库骨架（`apps/*`、`packages/*`），对应第二关已确定的仓库结构。
2. 建立 `packages/contracts`：Project 的 TypeScript 类型 + JSON Schema 共享契约（线上 camelCase，供 Windows 客户端与服务端共用）。
3. 建立 `apps/server`：Fastify + TypeScript + ESM 模块化单体骨架，按 domain / application / infrastructure / api 分层（mcp 层留待后续批次）。
4. 实现 `InMemoryProjectRepository`（第三关接口开发用内存仓储）。
5. 实现 `ProjectService`：
   - 幂等创建：客户端生成 UUID 作为幂等键，重试相同 id 返回已有项目（HTTP 201 → 200），不产生重复项目。
   - 获取项目：未知 id 抛 `ProjectNotFoundError`（HTTP 404）。
   - 修改项目：携带 `expectedVersion` 做乐观并发控制，版本不匹配抛 `ProjectConflictError`（HTTP 409）；可空字段仅在显式提供 null 时清空。
6. 实现 HTTP 路由 `POST / GET / PATCH /api/v1/projects`，JSON Schema 严格校验（未知字段拒绝 400）。
7. 实现 `GET/HEAD /healthz` 与 `GET/HEAD /readyz`（支持 GET + HEAD、不写业务 AuditLog、不泄露敏感信息）。

**新增、修改和删除的文件清单**

新增：
- `package.json`（根，npm workspaces）
- `packages/contracts/package.json`、`packages/contracts/tsconfig.json`
- `packages/contracts/src/project.ts`、`packages/contracts/src/index.ts`
- `apps/server/package.json`、`apps/server/tsconfig.json`
- `apps/server/src/config.ts`、`src/app.ts`、`src/index.ts`
- `apps/server/src/domain/project/errors.ts`、`repository.ts`
- `apps/server/src/application/project/project-service.ts`
- `apps/server/src/infrastructure/repositories/in-memory-project-repository.ts`
- `apps/server/src/api/routes/health.ts`、`projects.ts`
- `apps/server/test/helpers.ts`、`project-repository.test.ts`、`project-service.test.ts`、`project-api.test.ts`、`health.test.ts`
- `package-lock.json`（npm install 生成，是否提交由小喵决定）

修改：`apps/server/package.json`（workspace 依赖协议从 `workspace:*` 调整为 `*`，本机 npm 11 不识别前者）。

删除：无。

**关键设计决定及其依据**

1. 第三关采用"接口确定 + 内存仓储"：PostgreSQL 建库、Migration、真实认证归第六关。依据：计划第六关明确列出"建立数据库 / 建立 Migration / 建立身份认证"，第三关完成条件是"即使没有正式 UI，小喵和小克已能通过 MCP 正确读取和写入测试数据"，接口层先行符合"先实现最小完整流程"。
2. 幂等创建用客户端 UUID：满足协作规则"写操作必须考虑重复调用"。单用户 v0.1 场景冲突概率低，实现简单可靠。
3. 乐观并发用 version 字段：符合第二关"可修改核心数据使用 version 字段执行乐观并发控制"。
4. API 契约 camelCase、DB 层 snake_case（第六关映射）：与 Windows 客户端 JSON 消费习惯一致。
5. 严格校验未知字段（`removeAdditional: false`）：防止字段拼写错误被 Fastify 默认行为静默删除导致数据悄悄丢失。
6. 测试先放 `apps/server/test/`：根目录 `tests/integration`、`tests/e2e` 等集成与端到端基建就绪后再填充，避免本批次产生空目录。

**执行过的测试或检查、命令与真实结果**

- `npm install`：成功，added 106 packages，0 vulnerabilities。
- `npm run typecheck`：通过（contracts 与 server 均 `tsc --noEmit` 通过）。
- `npm test`（vitest run）：**28 passed / 28**，4 个测试文件全过。
- 真实冒烟测试（本机启动服务监听 127.0.0.1:8790 后用 curl 验证）：
  - `/healthz` → 200 `{"status":"ok",...}`；
  - `/readyz` → 503，database/migrations/asset_storage/mcp 如实返回 `not_configured`；
  - `POST /api/v1/projects` → 201；
  - `GET /api/v1/projects/:id` → 200；
  - 相同 id 重复 POST → 200 且返回同一项目（幂等）；
  - `PATCH` 携带错误版本 → 409 `project_version_conflict`；
  - `HEAD /healthz` → 200 空响应体；
  - 服务日志无任何敏感信息。

**未完成内容、已知问题和风险**

- readyz 在第三关如实返回 not_ready（依赖均为 not_configured）是预期的；第六关接入真实依赖后转绿。
- AuditLog 写入未实现：依赖身份认证（第六关），届时在写操作统一接入，本批次不伪造。
- 身份认证 / AI Actor 解析未实现（第六关）：本批次 API 处于无认证的接口层开发期状态。
- 生产构建未定型（tsc 输出 dist、contracts exports 指向 dist）：第三关用 tsx 运行，部署构建留待第六关。
- 内存仓储重启即失：第三关测试用途，真实持久化在第六关。

**是否涉及数据库、身份权限、密钥、外部服务或破坏性变化**

- 数据库：未新增/修改任何 Migration（内存仓储，无 DB）。
- 身份权限：未改动。
- 密钥：无。
- 外部服务：未操作 VPS / Cloudflare / GitHub，未启动常驻服务（冒烟测试服务已停止）。
- 破坏性变化：无，全部为新增文件；未触碰他人既有修改（`docs/project-plan-v0.1.md`、`第二关卡报告.txt`、`infra/`、`CLAUDE.md` 均保留原样）。

**建议下一批任务**

完成 Project API 剩余项与 Stage 最小模型联动：实现"获取主进度树 + 获取关卡详情"，并建立 ProjectStage 模型、仓储与"创建/修改关卡、设置关卡状态"接口，为后续 Stage API 与 MCP Tools 提供数据基础。

**等待小喵审核。**

---

## 小喵审核结果 #1 · 2026-08-09

**审核结论：部分通过，需要返修后再次提交检查点 #1。**

已通过并由小喵在计划文档中打勾：

- 获取项目（Project API）

暂未通过、保持未勾选：

- 创建项目（Project API）
- 修改项目基础信息（Project API）

小喵重新执行的验证：

- `npm.cmd run typecheck`：通过。
- `npm.cmd test`：28/28 通过。
- 顺序创建、获取、修改、404、400 与普通版本冲突路径：实现和测试质量合格。

必须修复的问题：

1. 创建与修改的并发保证目前只存在于“先查再写”的服务层流程，不是仓储级原子操作。直接并发调用 20 次同 ID 创建时，20 次都返回 `created: true`，最终数据被最后一次写入覆盖；并发调用 20 次相同 `expectedVersion` 修改时，20 次都成功，最终版本仍只有 2。真实 PostgreSQL 接入后，仓储的异步间隔会使这个竞态更容易出现。
2. 同一个项目 UUID 使用不同请求内容再次创建时，当前静默返回第一次创建的数据。幂等重试必须验证请求语义一致；相同幂等标识配合不同内容应返回明确冲突，不能假装重试成功。
3. `/readyz` 会把依赖抛出的原始 `Error.message` 放进公网响应。小喵用包含数据库连接串和密码的异常验证后，秘密被完整返回。响应只能使用受控错误码，例如 `not_configured`、`timeout`、`check_failed`；内部异常不得原样进入响应或未脱敏日志。

返修要求：

- 把创建改成仓储级 `createIfAbsent` 或等价的原子操作；未来 PostgreSQL 实现必须依靠唯一约束处理竞争。
- 把修改改成仓储级 compare-and-swap，例如 `updateIfVersion(project, expectedVersion)`；同时只有一个相同版本请求能够成功。
- 对同 ID、不同创建内容返回 409，并补充稳定的错误码。
- 对 readiness 异常执行错误分类和脱敏，禁止返回原始异常文字。
- 增加直接并发服务测试、不同内容幂等冲突测试和 readyz 秘密不泄露测试，不能只测试顺序请求。

非阻塞提醒：

- `Project.status` 变成 `archived` 时尚未维护 `archivedAt`；可以在本次返修中补齐，或暂时禁止通过基础信息 PATCH 修改归档状态，留给正式生命周期操作处理。
- 重大 goal、scope 或架构修改最终必须同时产生 ProjectDecision；在实现“项目历史记录”批次时需要补齐，不能在正式持久化版本中遗漏。

下一步：先修复以上问题并追加“检查点 #1 返修”，不要开始 ProjectStage 下一批。当前变更不提交、不推送 GitHub。

**等待 DeepSeek 返修。**

---

## 检查点 #1 返修 · 2026-08-09

**本批次目标**

针对"小喵审核结果 #1"提出的三个必须修复问题（并发原子性、幂等语义校验、readyz 秘密泄露）完成返修，并处理非阻塞提醒中的 archivedAt 维护；不开始 ProjectStage 下一批。

**候选完成的计划项目原文**（维持现状，未打勾）

- 创建项目（Project API）
- 修改项目基础信息（Project API）

（获取项目已由小喵在计划文档中打勾，本返修不重复认定。）

**实际完成内容**

1. **仓储级原子操作**：`ProjectRepository` 接口改为 `createIfAbsent`（原子插入，id 存在则返回已有、不覆盖）与 `updateIfVersion`（比较并交换，版本不匹配返回 null、不写入）。并发正确性由仓储保证，业务层不再依赖"先查再写"窗口。
2. **并发创建保证**：`createProject` 先构造完整快照再调用 `createIfAbsent`，并发 20 次同 ID 创建只有一次 `created: true`，其余返回已有项目；最终数据来自唯一成功的那一次。
3. **并发修改保证**：`updateProject` 构造新版本后调用 `updateIfVersion`，同一 `expectedVersion` 并发 20 次只有一个成功，其余抛 `ProjectConflictError`（409），最终版本只 +1。
4. **幂等语义校验**：`createIfAbsent` 返回 `created: false` 时，用 `sameCreateSemantics` 比较请求全部业务字段与已有项目；一致则视为幂等重试返回 200，不一致抛 `ProjectIdempotencyConflictError`（HTTP 409，稳定错误码 `project_idempotency_conflict`）。
5. **readyz 错误分类与脱敏**：检查项失败只允许受控错误码 `not_configured` / `timeout` / `check_failed` 进入响应；检查项返回的非受控文字一律归一化为 `check_failed`，抛出的异常文字不进入响应；超时单独识别为 `timeout`（超时毫秒数可配置，默认 2000，测试注入小值）；脱敏日志只记录检查名与受控错误码，不记录原始异常文字。
6. **archivedAt 维护**（非阻塞提醒）：`status` 变为 `archived` 时写入 `archivedAt`，离开 `archived` 时清空。
7. ProjectDecision 非阻塞提醒已记录：重大 goal/scope/架构修改必须产生 ProjectDecision，将在"项目历史记录"批次补齐，不遗漏到正式持久化版本。

**新增、修改和删除的文件清单**

修改：
- `apps/server/src/domain/project/repository.ts`：接口改为 `createIfAbsent` / `updateIfVersion`。
- `apps/server/src/domain/project/errors.ts`：新增 `ProjectIdempotencyConflictError`。
- `apps/server/src/infrastructure/repositories/in-memory-project-repository.ts`：实现两个原子方法。
- `apps/server/src/application/project/project-service.ts`：改用原子仓储；新增幂等语义校验与 archivedAt 维护；冲突时重读最新版本准确返回 409。
- `apps/server/src/api/routes/health.ts`：readyz 错误分类与脱敏、可配置超时。
- `apps/server/src/app.ts`：透传 `readyzTimeoutMs`；错误处理器新增幂等冲突 409。
- 测试文件：`test/project-repository.test.ts`、`test/project-service.test.ts`、`test/project-api.test.ts`、`test/health.test.ts`（改为原子仓储调用并补充新用例）。

新增：无。删除：无。

**关键设计决定及其依据**

1. 原子性下移到仓储：创建依赖 id 唯一约束 / `INSERT ... ON CONFLICT DO NOTHING`，修改依赖 `UPDATE ... WHERE version = ?` 行数判断；内存实现由 Map 同步读写保证。接口先定型，第六关 PostgreSQL 实现按同一契约落地。
2. 幂等冲突用稳定错误码 `project_idempotency_conflict`：客户端能区分"重试成功"（200）与"语义冲突"（409），不会把假重试当真。
3. readyz 只暴露受控错误码：依赖异常文字（可能含连接串、密码）绝不进入响应或未脱敏日志，符合第二关日志与敏感信息规则。
4. archivedAt 在基础信息 PATCH 中维护，避免状态与归档时间不一致；归档的正式生命周期操作（删除、恢复）仍留给后续批次。

**执行过的测试或检查、命令与真实结果**

- `npm run typecheck`：通过（contracts + server 均 `tsc --noEmit` 通过）。
- `npm test`（vitest run）：**44 passed / 44**，4 个测试文件全过，新增覆盖：
  - 并发 20 次同 ID 创建：仓储级与服务级各只有 1 次 created；
  - 并发 20 次同 ID 不同内容创建：1 次成功 + 19 次幂等冲突；
  - 并发 20 次同 `expectedVersion` 修改：1 次成功 + 19 次版本冲突，最终版本只 +1；
  - 同 ID 不同内容 API 返回 409 稳定错误码；
  - readyz：异常文字不泄露（含连接串+密码的异常 → `check_failed`，响应不含秘密）、非受控 message 归一化、挂起检查 → `timeout`。
- 真实冒烟测试（清理上一轮残留进程后重新启动服务验证）：
  - 创建 201；同 ID 同内容重试 200；同 ID 不同内容 **409 `project_idempotency_conflict`**；错误版本 PATCH 409；readyz 仅返回受控错误码；服务日志无敏感信息；测试后端口 8790 已释放。

**未完成内容、已知问题和风险**

- 本返修为接口层修复；PostgreSQL 唯一约束与 `UPDATE ... WHERE version` 的真实竞争处理仍需第六关落地并再次验证。
- readyz 仍如实返回 not_ready（依赖均 not_configured），第六关接真实依赖后转绿。
- ProjectDecision 写入在"项目历史记录"批次补齐。
- 身份认证 / AuditLog / 生产构建仍按原计划归第六关。

**是否涉及数据库、身份权限、密钥、外部服务或破坏性变化**

- 数据库：未新增/修改 Migration（仍为内存仓储）。
- 身份权限：未改动。
- 密钥：无；readyz 泄漏面已封堵并测试验证。
- 外部服务：未操作 VPS / Cloudflare / GitHub；冒烟测试服务已停止、端口已释放。
- 破坏性变化：无；未触碰他人既有修改。

**建议下一批任务**

在小喵确认本次返修后再进入 ProjectStage 下一批：实现"获取主进度树 + 获取关卡详情"，建立 ProjectStage 模型、仓储与"创建/修改关卡、设置关卡状态"接口。

**等待小喵审核。**

---

## 小喵返修验收结果 #1 · 2026-08-09

**审核结论：返修通过。**

本轮验收并由小喵在计划文档中打勾：

- 创建项目（Project API）。
- 修改项目基础信息（Project API）。
- healthz（MCP Doctor）。
- readyz（MCP Doctor）。
- 返回服务器版本（MCP Doctor，由 healthz 返回）。

此前已经通过：

- 获取项目（Project API）。

小喵独立验证结果：

- `npm.cmd run typecheck`：通过。
- `npm.cmd test`：44/44 通过。
- 不依赖测试文件的并发复验：20 次不同内容同 ID 创建为 1 次成功、19 次幂等冲突；20 次同版本更新为 1 次成功、19 次版本冲突；最终版本为 2。
- 生产日志模式脱敏复验：向 readiness check 注入包含数据库连接串和测试密码的异常，公网响应只返回 `check_failed`，日志只包含检查名和受控错误码，未出现连接串或密码。
- `archivedAt` 随归档和恢复状态正确设置与清空。

代码审核结论：

- `createIfAbsent` 与 `updateIfVersion` 已把并发正确性下沉到仓储契约，内存实现满足第三关原型要求。
- 相同 ID、不同创建语义使用稳定的 409 `project_idempotency_conflict`，符合幂等规则。
- readyz 不再返回或记录原始依赖异常，上一轮敏感信息问题已经关闭。
- PostgreSQL 实现仍必须在第六关使用唯一约束和条件 UPDATE 再次验证真实数据库竞争；本次通过不代表数据库层已经完成。
- ProjectDecision 仍按计划留在“获取项目历史记录”相关批次完成。

后续允许进入 ProjectStage 小批次。Git 提交与推送由小喵在检查当前完整变更范围后决定。

**返修检查点 #1 已关闭。**
