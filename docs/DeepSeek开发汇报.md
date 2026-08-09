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

---

## 检查点 #2 · 2026-08-09

**本批次目标**

在已验收的 Project API 基础上，建立 ProjectStage 数据契约、仓储、服务与路由，完成 Stage 最小闭环（创建关卡、获取关卡详情、获取主进度树），为后续 Stage API 与 MCP Tools 提供数据基础。按猫猫要求，本批暂不实现"修改关卡"和"设置关卡状态"。

**候选完成的计划项目原文**（仅候选完成，未打勾）

- `- [ ] 获取主进度树`
- `- [ ] 获取关卡详情`
- `- [ ] 创建关卡`

**实际完成内容**

1. 建立 `packages/contracts/src/stage.ts`：`ProjectStage` 类型（id / projectId / name / description / position / completionCriteria / status / startedAt / completedAt / version / createdAt / updatedAt）、`CreateStageInput`、`ProgressTree`（项目 + 关卡列表）、`PROJECT_STAGE_STATUSES` 七个状态，以及 projectId / stage 参数、创建体、关卡 JSON、进度树 JSON 的严格 Schema；`index.ts` 追加导出。
2. 建立 Stage 领域层：`StageRepository`（findById / listByProject / createIfAbsent）、错误类型（`StageNotFoundError`、`StagePositionConflictError`、`StageIdempotencyConflictError`）。
3. 实现 `InMemoryStageRepository`：id 唯一性 + 同项目内 `(projectId, position)` 唯一性均由仓储级原子检查保证（同步块内完成，无 await 间隙）。
4. 实现 `StageService`：
   - 创建关卡：校验项目存在（不存在 → 404）；`position` 未提供时按同项目最大 position + 1 自动分配；默认 `status = 'not_started'`、`version = 1`；幂等语义比较（position 仅在客户端显式提供时参与比较）。
   - 获取关卡详情：未知 id → 404 `stage_not_found`。
   - 获取主进度树：校验项目存在，返回项目基础信息 + 按 position 升序的关卡列表。
5. 实现 HTTP 路由：`POST /api/v1/projects/:projectId/stages`（201/200）、`GET /api/v1/stages/:id`、`GET /api/v1/projects/:projectId/progress-tree`，JSON Schema 严格校验（未知字段 400）。
6. `app.ts` 注册 stageRoutes 并新增错误映射（404 `stage_not_found`、409 `stage_position_conflict`、409 `stage_idempotency_conflict`）；`index.ts` 改为共享同一个 `InMemoryProjectRepository` 装配两个服务。

**新增、修改和删除的文件清单**

新增：
- `packages/contracts/src/stage.ts`
- `apps/server/src/domain/stage/errors.ts`、`repository.ts`
- `apps/server/src/infrastructure/repositories/in-memory-stage-repository.ts`
- `apps/server/src/application/stage/stage-service.ts`
- `apps/server/src/api/routes/stages.ts`
- `apps/server/test/stage-repository.test.ts`、`stage-service.test.ts`、`stage-api.test.ts`

修改：
- `packages/contracts/src/index.ts`（追加 `export * from './stage.js'`）
- `apps/server/src/app.ts`（`AppDeps` 新增必填 `stageService`、注册 stageRoutes、Stage 错误映射）
- `apps/server/src/index.ts`（共享项目仓储装配两个服务）
- `apps/server/test/helpers.ts`（新增 `makeStage` 与 `makeServices` 共享装配）
- `apps/server/test/health.test.ts`、`project-api.test.ts`（setup 改为提供 `stageService`）

删除：无。

**关键设计决定及其依据**

1. `StageService` 依赖 `ProjectRepository`：创建关卡与主进度树都必须先确认项目存在，避免为不存在的项目产生孤立关卡；两个仓储在 `index.ts` 与测试中共享同一 `InMemoryProjectRepository` 实例。
2. position 唯一性下移到仓储级原子检查（而非服务层先查再写）：避免并发创建时两个请求同时通过 position 检查后重复占用；第六关由 PostgreSQL `UNIQUE (project_id, position)` 承担同一职责。
3. 幂等语义比较中 position 只在显式提供时参与：自动分配 position 的幂等重试会重算出不同位置，若一律比较 position 会把合法的重试误判为冲突；显式指定了 position 则必须一致。
4. 同一 stage id 被用于不同项目时按幂等冲突处理（409）：幂等键（id）全局唯一，跨项目复用同一 id 视为语义不一致，防止数据串项目。
5. `stageService` 设为 `AppDeps` 必填并显式注入：避免 `buildApp` 内部偷偷构造一套独立存储的服务，隐藏组合错误；既有 health / project 测试只补一行注入，不产生隐藏状态。
6. 自动分配 position 的并发竞态（两个无 position 的并发创建可能算出相同位置，后到者 409）如实保留并记录为已知风险，不做静默覆盖。

**执行过的测试或检查、命令与真实结果**

- `npm run typecheck`：通过（contracts 与 server 均 `tsc --noEmit` 通过）。
- `npm test`（vitest run）：**79 passed / 79**，7 个测试文件全过。新增 35 个用例：仓储 8（含并发同 id 1 次创建 + 19 次返回已有、并发同 position 1 次创建 + 19 次 position 冲突）、服务 13（含自动 position 递增、幂等重试、自动 position 重试幂等、同 id 不同内容/不同项目/不同显式 position 冲突、进度树排序）、API 14（含 201/200/400/404/409 各错误码、并发同 id、并发同 position、未知字段与畸形 UUID 400）。
- 真实冒烟测试（本机启动服务监听 127.0.0.1:8790，Node fetch 脚本直连 HTTP 验证）：
  - 创建项目 201；创建关卡（自动 position=1）201，status=`not_started`、version=1；
  - 显式 position=5 的关卡 201；第三个关卡自动 position=max+1=6；
  - 获取关卡详情 200；未知关卡 404 `stage_not_found`；
  - 主进度树 200，关卡按 position 升序 `[1,5,6]`，project 正确；
  - 未知项目进度树 404 `project_not_found`；
  - 同 id 同内容重试 200；同 id 不同内容 409 `stage_idempotency_conflict`；同项目同 position 409 `stage_position_conflict`；
  - 服务日志无任何敏感信息；测试后服务已停止，端口 8790 已释放。

**未完成内容、已知问题和风险**

- "修改关卡"与"设置关卡状态"按猫猫要求本批未实现，留待后续批次。
- 自动分配 position 的并发竞态：两个未提供 position 的并发创建可能算出相同位置，后到者会收到 409 `stage_position_conflict`（不会静默覆盖）。第三关内存原型如实暴露该语义；第六关 PostgreSQL 的唯一约束同样会拒绝，届时可评估是否需要重试分配。
- 关卡排序依赖 position 升序，本批无"移动/重排"操作；将来支持重排时需要处理批量位置变更的原子性。
- `startedAt` / `completedAt` 字段已在契约与模型中定义但创建时固定为 null，由"设置关卡状态"批次维护。
- PostgreSQL、身份认证、AuditLog、生产构建仍按计划归第六关；内存仓储重启即失。

**是否涉及数据库、身份权限、密钥、外部服务或破坏性变化**

- 数据库：未新增/修改任何 Migration（仍为内存仓储，无 DB）。
- 身份权限：未改动。
- 密钥：无。
- 外部服务：未操作 VPS / Cloudflare / GitHub；冒烟测试服务已停止、端口已释放。
- 破坏性变化：无；全部为新增文件与既有测试 setup 的少量注入补充；未触碰他人既有修改（`docs/project-plan-v0.1.md`、`第一关卡完成报告.txt`、`第二关卡报告.txt`、`infra/`、`CLAUDE.md` 均保留原样）。

**建议下一批任务**

在小喵确认本批后：实现"修改关卡"与"设置关卡状态"，前者补乐观并发修改（复用 `updateIfVersion` 模式并处理 position 变更的原子性），后者维护 `status` / `startedAt` / `completedAt` 与状态流转校验。

**等待小喵审核。**

---

## 小喵审核结果 #2 · 2026-08-09

**审核结论：部分通过，检查点 #2 需要一次小返修。**

已通过并由小喵在计划文档中打勾：

- 获取关卡详情（Stage 基础资源详情）。

暂未通过、保持未勾选：

- 创建关卡。
- 获取主进度树。

小喵独立验证：

- `npm.cmd run typecheck`：通过。
- `npm.cmd test`：79/79 通过。
- 契约严格校验、项目存在性、stage id 幂等冲突、显式 position 唯一冲突、跨项目隔离、详情 404 和关卡排序均符合预期。
- 额外并发复验：同时创建 20 个不同 id 且都不指定 position 的关卡，只有 1 个成功，19 个返回 `StagePositionConflictError`；最终项目只有 position=1 的一个关卡。

必须修复的问题：

1. 当客户端没有显式提供 position 时，position 是服务端内部自动分配的；有效请求不应因为内部 `max + 1` 竞争而向客户端返回“你指定的位置冲突”。请在仓储中原子分配下一个 position，或在服务层捕获自动分配产生的 position 冲突后重新读取并进行有界重试。客户端显式提供 position 时仍应保持 409 冲突语义。
2. 增加测试：20 个不同 id、均不提供 position 的并发创建必须全部成功，最终 position 唯一且为连续的 1～20；同时保留同 id 幂等和显式 position 冲突测试。

“获取主进度树”暂缓验收的原因：

- 当前 `ProgressTree` 只有 `project + ProjectStage[]`，实际是项目关卡地图。
- 第一关需求与第二关数据模型已经确定：正式主进度还包含关卡下的 ProjectTask，以及通过 parent_task_id 组成的主任务／分任务树。
- 因此当前接口可以保留作为基础，但在加入 ProjectTask 前不能把“获取主进度树”正式打勾。
- 这是小喵此前安排批次时没有先排 ProjectTask 支撑模型造成的边界疏漏，不算 DeepSeek 擅自偏离要求。

返修范围：只修复自动 position 的并发分配并追加“检查点 #2 返修”；不要开始修改关卡、状态流转或 ProjectTask。返修通过后，小喵将验收“创建关卡”，再单独安排 ProjectTask 与完整主进度树批次。

当前变更不提交、不推送 GitHub。

**等待 DeepSeek 返修。**

---

## 检查点 #2 返修 · 2026-08-09

**本批次目标**

针对"小喵审核结果 #2"提出的唯一必须修复问题（自动 position 的并发分配）完成返修并补测试；不开始关卡修改、状态流转或 ProjectTask。

**候选完成的计划项目原文**（维持现状，未打勾）

- `- [ ] 创建关卡`
- `- [ ] 获取主进度树`

（"获取关卡详情"已由小喵在计划文档中打勾，本返修不重复认定；"获取主进度树"小喵已说明暂缓验收原因——缺少 ProjectTask 支撑模型，等待小喵单独排期。）

**实际完成内容**

1. **服务层有界重试**（`StageService.createStage` 重构，选择小喵提示的第二种方案）：
   - 显式提供 position：保持原语义，一次尝试，`StagePositionConflictError`（409 `stage_position_conflict`）直接返回客户端。
   - 自动分配 position：position 属于服务端内部分配，不再把内部 `max+1` 竞争当作客户端冲突。撞车时捕获 `StagePositionConflictError`，重新读取项目最新关卡、重算 `max+1` 后重试，上限 `AUTO_POSITION_RETRY_LIMIT = 50`；重试必然收敛（每次重算的位置单调递增），只要并发创建数低于上限即全部成功。
   - 重试耗尽（并发度超过上限的极端情况）时如实返回与显式 position 冲突同语义的 409，不静默覆盖。
2. **抽取私有方法** `buildStage`（构造关卡快照）与 `insertStage`（`createIfAbsent` + 幂等语义校验），显式 / 自动两条路径共用，避免重复。
3. **新增并发测试**：
   - 服务层：20 个不同 id、均不提供 position 的并发创建全部 `created: true`，position 去重后唯一且连续 1～20。
   - API 层：20 个不同 id、均不提供 position 的并发 POST 全部 201，随后 GET 主进度树 position 为 1～20。
   - 既有同 id 幂等、显式 position 冲突、自动 position 幂等重试测试全部保留并通过。

**新增、修改和删除的文件清单**

修改：
- `apps/server/src/application/stage/stage-service.ts`：自动 position 有界重试；抽取 `buildStage` / `insertStage`。
- `apps/server/test/stage-service.test.ts`：新增 20 并发自动 position 用例。
- `apps/server/test/stage-api.test.ts`：新增 20 并发自动 position HTTP 用例。

新增：无。删除：无。

**关键设计决定及其依据**

1. 选择"服务层有界重试"而非"仓储原子分配"：不改动 `StageRepository` 契约（`createIfAbsent` 仍以 id 唯一 + `(projectId, position)` 唯一做原子检测），第六关 PostgreSQL 落地时同一逻辑天然同构——`SELECT max(position)+1` 后 INSERT 撞 `UNIQUE (project_id, position)` 约束即重试，无需在数据库层引入序列或 `INSERT ... SELECT` 的复杂分配。
2. 重试上限取 50：每次重试重算的位置单调递增、必然收敛，上限只需覆盖预期并发度；第三关内存原型与单人真实使用场景并发度远低于 50，20 并发验收有充分余量。达到上限只是理论兜底，不为正常路径引入额外失败面。
3. 自动分配的撞车不再向客户端报"你指定的位置冲突"：区分"客户端显式指定的位置"与"服务端内部分配的位置"，只有前者才把冲突当成客户端语义错误。

**执行过的测试或检查、命令与真实结果**

- `npm run typecheck`：通过（contracts 与 server 均 `tsc --noEmit` 通过）。
- `npm test`（vitest run）：**81 passed / 81**，7 个测试文件全过；新增 2 个并发自动分配用例（服务层 + API 层），既有 79 个用例无回归。
- 真实冒烟测试（本机启动服务监听 127.0.0.1:8790，Node fetch 脚本直连 HTTP）：
  - 20 个不同 id、均不提供 position 的并发 POST 创建：**全部 201、零 409**；
  - 随后 GET 主进度树：20 个关卡，position 唯一且连续 `1..20`；
  - 显式 position 冲突仍返回 409 `stage_position_conflict`（语义保留）；
  - 服务日志无任何敏感信息；测试后服务已停止，端口 8790 已释放。

**未完成内容、已知问题和风险**

- "修改关卡"与"设置关卡状态"按猫猫与小喵安排仍未实现，留待后续批次。
- "获取主进度树"在小喵排入 ProjectTask 支撑模型前保持未打勾；当前接口作为基础保留。
- 自动 position 有界重试的上限 50 在极端并发（>50 个无 position 创建同时到达）下可能耗尽并返回 409；第三关原型与单人场景不会触达，第六关 PostgreSQL 落地时可评估是否需要更高上限或改为数据库序列。
- PostgreSQL、身份认证、AuditLog、生产构建仍按计划归第六关。

**是否涉及数据库、身份权限、密钥、外部服务或破坏性变化**

- 数据库：未新增/修改任何 Migration（仍为内存仓储，无 DB）。
- 身份权限：未改动。
- 密钥：无。
- 外部服务：未操作 VPS / Cloudflare / GitHub；冒烟测试服务已停止、端口已释放。
- 破坏性变化：无；仅修改本批次自己的服务与测试文件，未触碰他人既有修改（`docs/project-plan-v0.1.md`、两份关卡报告、`infra/`、`CLAUDE.md` 均保留原样）。

**建议下一批任务**

在小喵确认返修并验收"创建关卡"后：由小喵单独安排 ProjectTask 支撑模型批次，再完成完整"获取主进度树"；之后实现"修改关卡"与"设置关卡状态"。

**等待小喵审核。**

---

## 小喵返修验收结果 #2 · 2026-08-09

**审核结论：自动 position 返修通过，检查点 #2 关闭。**

本轮通过并由小喵在计划文档中打勾：

- 创建关卡。

本检查点此前已经通过：

- 获取关卡详情。

继续保持未勾选：

- 获取主进度树；当前 project + stages 结构作为关卡地图基础保留，待 ProjectTask 主任务／分任务树接入后再验收。

小喵独立验证：

- `npm.cmd run typecheck`：通过。
- `npm.cmd test`：81/81 通过。
- 独立并发复验：20 个不同 id 且不提供 position 的创建全部成功，position 唯一且连续为 1～20。
- 显式指定相同 position 的第二次创建仍发生明确冲突，没有被自动重试逻辑吞掉。
- 同 id 幂等、跨项目隔离、详情读取、严格 Schema 和错误映射没有回归。

审核结论：自动 position 的重试范围与上限对第三关单用户内存原型合理；第六关 PostgreSQL 实现时仍需重新验证唯一约束竞争，并评估是否改成数据库级分配。

下一批由小喵单独安排 ProjectTask 支撑模型与完整主进度树，不开始关卡修改和状态流转。

**检查点 #2 已关闭。**

---

## 检查点 #3 · 2026-08-09

**本批次目标**

按小喵在"返修验收结果 #2"中的安排，建立第二关报告已确定的 ProjectTask 支撑模型，完成完整"获取主进度树"：实现 ProjectTask 契约、内存仓储与服务层；支持在指定关卡下创建正式任务、通过 parentTaskId 创建分任务；验证 projectId / stageId / parentTaskId 归属一致、禁止跨项目或跨关卡挂载；同一父级下按 position 排序并处理唯一性、幂等与并发创建；把 ProgressTree 扩展为"project + stages[]，每个 stage 携带自身资料与 ProjectTaskNode 任务/分任务树"；补充分层测试。按猫猫要求，本批不实现任务完成、审核流程、AI Task、修改关卡或状态流转。

**候选完成的计划项目原文**（仅候选完成，未打勾）

- `- [ ] 获取主进度树`

**实际完成内容**

1. 建立 `packages/contracts/src/project-task.ts`：`ProjectTask` 类型（id / projectId / stageId / parentTaskId / title / description / completionCriteria / status / position / assignedActorId / version / createdAt / updatedAt / completedAt / archivedAt）、`CreateProjectTaskInput`、`ProjectTaskNode`（带 children 的递归节点）、`ProgressTreeStage`（stage 全字段 + tasks 树）、`ProgressTree`（project + stages）、`PROJECT_TASK_STATUSES` 六个状态，以及任务参数 / 创建体 / 任务 JSON / 递归节点 / 进度树 JSON 的严格 Schema；`index.ts` 追加导出；`stage.ts` 中原 `ProgressTree` / `progressTreeJsonSchema` 移出并在头注释指向 `project-task.ts`。
2. 建立 ProjectTask 领域层：`ProjectTaskRepository`（findById / listByStage / createIfAbsent）、错误类型（`ProjectTaskNotFoundError`、`ProjectTaskParentNotFoundError`、`ProjectTaskScopeConflictError`、`ProjectTaskPositionConflictError`、`ProjectTaskIdempotencyConflictError`）。
3. 实现 `InMemoryProjectTaskRepository`：id 唯一性 + 同父级 `(stage_id, parent_task_id, position)` 唯一性均在仓储级同步块内原子检查（`parentTaskId` 为 null 时归一化为 `'__root__'`，主任务与分任务各自独立计位）。
4. 实现 `ProjectTaskService`：
   - 创建任务：校验关卡存在（不存在 → 404 `stage_not_found`）且属于该项目（否则 → 409 `project_task_scope_conflict`）；`parentTaskId` 存在时校验父任务存在（否则 → 404 `parent_task_not_found`）且父任务与子任务同项目、同关卡（否则 → 409 `project_task_scope_conflict`，禁止跨项目/跨关卡挂载）。
   - position：显式提供 → 一次性冲突检测（同父级占用 → 409 `project_task_position_conflict`）；未提供 → 服务层有界重试（`AUTO_POSITION_RETRY_LIMIT = 50`，按同父级最大 position + 1 分配），复用第二关返修确立的并发安全模式。
   - 幂等：`createIfAbsent` 命中既有 id 时比较 projectId / stageId / parentTaskId 归属与语义字段（title / description / completionCriteria / assignedActorId / 显式 position），一致 → 返回既有任务（200），不一致 → 409 `project_task_idempotency_conflict`；自动分配的 position 不参与语义比较。
   - 获取任务：未知 id → 404 `project_task_not_found`。
   - 获取主进度树：校验项目存在（否则 → 404 `project_not_found`），按 position 升序返回关卡，每个关卡用 `buildTaskTree` 把该关卡任务构造成递归节点树，并在每一层按 position 稳定排序。
5. 实现 HTTP 路由 `apps/server/src/api/routes/tasks.ts`：`POST /api/v1/projects/:projectId/stages/:stageId/tasks`（201/200）、`GET /api/v1/tasks/:id`、`GET /api/v1/projects/:projectId/progress-tree`，JSON Schema 严格校验（未知字段、非法 UUID 400）。
6. `app.ts`：`AppDeps` 新增必填 `taskService`，注册 taskRoutes，新增任务错误映射（404 `project_task_not_found` / `parent_task_not_found`，409 `project_task_scope_conflict` / `project_task_position_conflict` / `project_task_idempotency_conflict`）；`index.ts` 装配 `InMemoryProjectTaskRepository` 并共享 stage / project 仓储。

**新增、修改和删除的文件清单**

新增：
- `packages/contracts/src/project-task.ts`
- `apps/server/src/domain/project-task/errors.ts`、`repository.ts`
- `apps/server/src/infrastructure/repositories/in-memory-project-task-repository.ts`
- `apps/server/src/application/project-task/project-task-service.ts`
- `apps/server/src/api/routes/tasks.ts`
- `apps/server/test/project-task-repository.test.ts`、`project-task-service.test.ts`、`project-task-api.test.ts`

修改：
- `packages/contracts/src/index.ts`（追加 `export * from './project-task.js'`）
- `packages/contracts/src/stage.ts`（移除 `ProgressTree` / `progressTreeJsonSchema`，收窄导入）
- `apps/server/src/application/stage/stage-service.ts`（移除 `getProgressTree`，进度树职责移交 ProjectTaskService）
- `apps/server/src/api/routes/stages.ts`（移除 progress-tree 路由）
- `apps/server/src/app.ts`（`AppDeps` 新增 `taskService`、注册 taskRoutes、任务错误映射）
- `apps/server/src/index.ts`（装配 ProjectTask 仓储与服务）
- `apps/server/test/helpers.ts`（`makeServices` 共享三个仓储；新增 `makeTask`）
- `apps/server/test/health.test.ts`、`project-api.test.ts`、`stage-api.test.ts`、`stage-service.test.ts`（setup 注入 taskService；progress-tree 用例移入 task 测试）

删除：无。

**关键设计决定及其依据**

1. 主进度树构造职责由 `StageService` 移交 `ProjectTaskService`：进度树现在必须包含任务树，只有同时持有 Stage 仓储与 Project 仓储的 ProjectTaskService 才能完成归属校验与树构造；Stage 层不再依赖任务概念。
2. 父任务归属校验严于第二关报告原文（"parent 必须指向同项目 ProjectTask"）：按猫猫要求升级为"同项目 + 同关卡"，禁止跨项目或跨关卡挂载，`ProjectTaskScopeConflictError` 覆盖父任务与关卡归属两类冲突，向客户端返回稳定错误码。
3. 任务 position 唯一域 = 同一 stage + 同一父级：主任务（`parentTaskId` null）与各分任务子树各自独立计位，与"同一父级下按 position 排序"的数据模型一致；第六关对应 PostgreSQL `UNIQUE (stage_id, parent_task_id, position)`。
4. 递归任务节点 Schema 采用 `$id: 'projectTaskNode'` + `$ref: 'projectTaskNode#'` 自引用，而非 `$defs` 锚点引用：Fastify 会把路由响应 Schema 交给 fast-json-stringify 统一编译，嵌套子 Schema 内的 `#/$defs/...` 会相对根文档解析而找不到锚点（实测报 `Cannot find reference`）；`$id` 自锚定使递归 Schema 独立自洽，既可在进度树中内嵌使用，也可在未来任务详情端点中单独复用。
5. 任务自动 position 复用"服务层有界重试"：与第二关返修验收的关卡模式同构，显式 position 仍一次性 409；20 并发验收覆盖。
6. 幂等语义比较含归属校验：同 id 复用于不同项目/关卡/父级一律视为语义不一致（409），防止幂等键串数据。
7. `buildTaskTree` 以"父任务不在集合内则视为根"兜底孤儿节点，避免脏数据导致树构造崩溃；每层按 position 稳定排序，children 在树查询时构造。

**执行过的测试或检查、命令与真实结果**

- `npm run typecheck`：通过（contracts 与 server 均 `tsc --noEmit` 通过，0 错误）。
- `npm test`（vitest run）：**125 passed / 125**，10 个测试文件全过；其中新增 49 个用例（仓储 9、服务 21、API 19），既有 76 个用例无回归。
- 真实冒烟测试（单进程内启动服务监听 127.0.0.1:8790，Node fetch 直连 HTTP）：
  - 项目 → 关卡（乱序 position）→ 主任务 + 分任务 + 孙任务（乱序创建）：全部 201；
  - `GET progress-tree`：关卡按 position 排序（关卡A、关卡B）；主任务排序（主A、主B）；B 的 children 排序（子1、子2）；子2 的 children（孙）——递归排序正确；
  - 幂等重试同 id 同内容：200；
  - 跨关卡挂载父任务：409 `project_task_scope_conflict`；
  - 同父级显式 position 冲突：409 `project_task_position_conflict`；
  - 同 id 不同内容：409 `project_task_idempotency_conflict`；
  - 空关卡：tasks 为 `[]`；`GET /api/v1/tasks/:id`：200；未知项目进度树：404 `project_not_found`；
  - 冒烟后 `app.close()`，端口 8790 已释放（`netstat` 确认无监听）。

**未完成内容、已知问题和风险**

- 任务完成、审核流程、AI Task、修改关卡、设置关卡状态按猫猫安排仍未实现，留待后续批次。
- "获取主进度树"仍保持未打勾，仅为候选完成项，待小喵验收后由小喵在计划文档中打勾。
- 自动 position 有界重试上限 50 在极端并发（>50 个无 position 创建同时到达）下可能耗尽并返回 409；第三关原型与单人场景不会触达，第六关 PostgreSQL 落地时由唯一约束竞争兜底并评估是否改为数据库级分配。
- 递归 Schema 使用 `$id` 自引用：若未来多个路由同时内嵌同一 `projectTaskNodeJsonSchema`，需确认各 fast-json-stringify 编译上下文互不冲突（当前仅进度树一处使用，已实测可正常编译与序列化）。
- 工作区新增未跟踪目录 `ui素材mingwu/`：非本批次产物、非本人创建，按协作规则未读取、未修改、未清理，交由小喵判断归属。
- PostgreSQL、身份认证、AuditLog、生产构建仍按计划归第六关。

**是否涉及数据库、身份权限、密钥、外部服务或破坏性变化**

- 数据库：未新增/修改任何 Migration（仍为内存仓储，无 DB）。
- 身份权限：未改动；`assignedActorId` 仅为可选字段，真实 AI 身份仍由服务端 AuthContext 解析（第六关）。
- 密钥：无。
- 外部服务：未操作 VPS / Cloudflare / GitHub；冒烟测试服务已停止、端口已释放。
- 破坏性变化：无；`docs/project-plan-v0.1.md`、两份关卡报告、`CLAUDE.md`、`infra/` 均保留原样；`ui素材mingwu/` 未触碰。

**建议下一批任务**

在小喵验收"获取主进度树"后，可选：实现"修改关卡"与"设置关卡状态"；或先做 ProjectTask 的任务完成/审核流转；再排"获取项目当前状态"与"获取项目历史记录"。由小喵确定顺序。

**等待小喵审核。**

---

## 小喵审核结果 #3 · 2026-08-09

**结论：需要一次小范围返修，暂不勾选“获取主进度树”。**

小喵已独立复核本批契约、仓储、服务、路由与测试，并真实执行：

- `npm.cmd run typecheck`：通过；
- `npm.cmd test`：10 个测试文件、**125/125** 通过；
- 正常数据下的多层任务树、逐层 position 排序、项目/关卡/父任务归属校验、幂等冲突、显式 position 冲突及 20 并发自动分配，整体实现正确。

### 必须返修：主进度树不能静默改写或丢失异常层级

当前 `buildTaskTree` 有两种静默错误：

1. 任务声明了非空 `parentTaskId`，但该父任务不在同一关卡集合内时，当前代码会把这个孤儿任务直接放进 `roots`，把分任务伪装成主任务；
2. 数据若形成父子循环，循环中的节点不会成为 root，最终会从返回的进度树中全部消失，接口仍返回 200，调用方无法知道数据不完整。

创建服务目前能够阻止正常请求制造这些数据，但第六关接入数据库、迁移、导入或后续增加“修改父任务”后，脏数据仍可能出现。“完整主进度树”不能在这种情况下悄悄改变数据含义或漏掉任务。

返修要求：

- 组树前校验每个非空父引用都存在于同一关卡的任务集合；
- 检测自引用与任意长度的父子循环，并确认最终访问到的节点数等于输入任务数；
- 发现孤儿或循环时抛出专用、可控的数据完整性错误，由 HTTP 层返回稳定且不泄露内部数据的错误码（500 合理），不要提升为 root、不要静默丢弃；
- 增加服务层测试覆盖孤儿父引用、自引用/两节点循环，至少证明异常会被明确报告且不会返回伪造的不完整树；
- 修正 PostgreSQL 约束说明：普通 `UNIQUE (stage_id, parent_task_id, position)` 对 `parent_task_id IS NULL` 的根任务不能保证唯一；第六关应使用 PostgreSQL 15+ 的 `NULLS NOT DISTINCT`，或根任务/子任务的部分唯一索引（也可使用可靠的表达式唯一索引）。本批只需改正注释和汇报，不需要提前做数据库迁移。

返修范围仅限上述数据完整性与说明修正。`assignedActorId` 的真实 Actor 存在性和身份绑定仍按计划留到身份模型/持久化批次，不阻塞本次。

计划文档保持 `- [ ] 获取主进度树`；不提交、不推送。返修完成后请追加“检查点 #3 返修”并再次暂停，交由小喵复验。

---

## 检查点 #3 返修 · 2026-08-09

**本批次目标**

按"小喵审核结果 #3"完成小范围返修，仅限两项数据完整性修正与一项说明修正：组树前校验孤儿父引用、自引用与任意长度父子循环，发现即抛专用、可控的数据完整性错误，HTTP 层返回稳定且不泄露内部数据的 500 错误码，不把分任务提升为 root、不静默丢弃循环节点；补充服务层与 API 层测试；改正第六关 PostgreSQL 约束说明（`parent_task_id IS NULL` 的根任务需 `NULLS NOT DISTINCT` 或部分/表达式唯一索引）。

**候选完成的计划项目原文**（维持现状，未打勾）

- `- [ ] 获取主进度树`

**实际完成内容**

1. 新增 `ProjectTaskTreeCorruptionError`（`reason: 'orphan_parent' | 'self_reference' | 'cycle'`，携带 stageId / taskId 供服务端日志诊断）：
   - 孤儿父引用：`parentTaskId` 非空但不在同一关卡任务集合内 → `orphan_parent`；
   - 自引用：`parentTaskId === id` → `self_reference`；
   - 任意长度父子循环：沿 parent 链上溯，路径上再次出现已访问节点 → `cycle`（自引用在第 1 步排除，此处覆盖两节点/多节点环）；
   - 不变量兜底：组树后确认最终访问到的节点数等于输入任务数，防止未来改动让节点静默丢失而返回不完整树。
2. 重写 `buildTaskTree(stageId, tasks)`：先做第 1～2 步完整性检测，再组装父子关系，最后递归按 position 稳定排序；任何异常立即抛出，不把孤儿提升为 root、不丢弃循环节点。
3. `app.ts` 错误映射：`ProjectTaskTreeCorruptionError` → **500** `project_task_tree_corrupt`，响应仅含受控错误码与通用文案 `project task tree is inconsistent`，不返回内部任务/关卡 id；完整错误对象只进服务端日志。
4. 修正 PostgreSQL 约束说明（三处源码注释，`domain/project-task/errors.ts`、`domain/project-task/repository.ts`、`infrastructure/repositories/in-memory-project-task-repository.ts`）：普通 `UNIQUE (stage_id, parent_task_id, position)` 把 NULL 视为互不相等，无法约束根任务（`parent_task_id IS NULL`）的 position 去重；第六关应使用 PostgreSQL 15+ `UNIQUE NULLS NOT DISTINCT`，或对根任务/子任务分别建立部分唯一索引（或可靠的表达式唯一索引）。本批只改正注释，不做数据库迁移。
5. 测试：`helpers.ts` 的 `makeServices()` 额外返回 `taskRepository`（同一实例），供测试直接向仓储注入脏数据、绕过创建服务的归属校验；新增服务层 3 个用例 + API 层 1 个用例。

**新增、修改和删除的文件清单**

新增：无。

修改：
- `apps/server/src/domain/project-task/errors.ts`（新增 `ProjectTaskTreeCorruptionError`；修正 position 唯一约束的 PostgreSQL 说明）
- `apps/server/src/application/project-task/project-task-service.ts`（`buildTaskTree` 重写为带完整性校验并接收 stageId）
- `apps/server/src/app.ts`（新增 500 错误映射 `project_task_tree_corrupt`）
- `apps/server/src/domain/project-task/repository.ts`、`apps/server/src/infrastructure/repositories/in-memory-project-task-repository.ts`（修正约束说明）
- `apps/server/test/helpers.ts`（`makeServices` 返回 `taskRepository`）
- `apps/server/test/project-task-service.test.ts`（新增孤儿、自引用、两节点循环 3 个用例）
- `apps/server/test/project-task-api.test.ts`（新增 500 稳定错误码 + 不泄露内部 id 的用例）

删除：无。

**关键设计决定及其依据**

1. 完整性校验放在组树函数最前，且错误类型专门化：校验不依赖"创建服务是否拦截"——第六关接入数据库、迁移、导入或未来增加"修改父任务"后脏数据仍可能出现，"完整主进度树"不能悄悄改写数据含义或漏掉任务。
2. 孤儿与循环分开报告原因（`orphan_parent` / `self_reference` / `cycle`）：便于小喵或客户端定位脏数据来源；HTTP 层统一映射为 500 `project_task_tree_corrupt`，对外只暴露稳定错误码与通用文案，符合"不泄露内部数据"要求，内部细节只进服务日志。
3. 环检测沿 parent 链上溯而非"从 root 出发 DFS 判可达"：任意循环必然不与任何 root 相连（单父模型下每个节点只有一个 parentTaskId），从 root 出发的 DFS 会漏掉孤立环；parent 链上溯能精确报告环中节点，配合"访问节点数 == 输入任务数"的不变量兜底双保险。
4. 400/404/409 语义保持不动：数据完整性是服务端数据问题，不是客户端请求错误，故用 500 而非 4xx；与 readyz 的"受控错误码、不泄露内部异常"原则一致。
5. 测试通过 `taskRepository` 直接注入脏数据：创建服务本会拦截这些数据，只有绕过服务层才能复现第六关可能出现的脏数据场景，证明"读路径也能发现并报告"。

**执行过的测试或检查、命令与真实结果**

- `npm run typecheck`（@mingwu/server）：通过（`tsc --noEmit`，0 错误）。
- `npm test`（vitest run）：**129 passed / 129**，10 个测试文件全过；其中本返修新增 4 个用例（服务层孤儿 / 自引用 / 两节点循环，API 层 500 映射 + 不泄露），既有 125 个用例无回归。
- 真实冒烟测试（单进程内启动服务监听 127.0.0.1:8790，Node fetch 直连 HTTP）：
  - 正常数据（项目 + 关卡 + 任务）`GET progress-tree` → 200，任务树正常；
  - 向仓储注入孤儿父引用后 `GET progress-tree` → 500 `project_task_tree_corrupt`，响应体不含被污染的孤儿任务 id；
  - 向仓储注入两节点父子循环后 `GET progress-tree` → 500 `project_task_tree_corrupt`；
  - 冒烟后 `app.close()`，端口 8790 已释放（`netstat` 确认无监听）。

**未完成内容、已知问题和风险**

- 任务完成、审核流程、AI Task、修改关卡、设置关卡状态仍未实现，留待后续批次。
- "获取主进度树"保持未打勾，仅为候选完成项，待小喵复验后由小喵在计划文档中打勾。
- 环检测为逐节点沿 parent 链上溯（最坏 O(n²)）：第三关原型与单人数据规模无影响；第六关落库后如需大规模树可在数据库层以递归 CTE 或物化层级字段优化，不属于本批范围。
- `assignedActorId` 的真实 Actor 存在性与身份绑定按小喵要求仍留到身份模型/持久化批次，不阻塞本次。
- 工作区未跟踪目录 `ui素材mingwu/` 维持原状未触碰。
- PostgreSQL、身份认证、AuditLog、生产构建仍按计划归第六关；根任务 position 唯一性需以 `NULLS NOT DISTINCT` 或部分/表达式唯一索引落地。

**是否涉及数据库、身份权限、密钥、外部服务或破坏性变化**

- 数据库：未新增/修改任何 Migration（仍为内存仓储，无 DB；仅改正第六关约束说明）。
- 身份权限：未改动。
- 密钥：无。
- 外部服务：未操作 VPS / Cloudflare / GitHub；冒烟测试服务已停止、端口已释放。
- 破坏性变化：无；`docs/project-plan-v0.1.md`、两份关卡报告、`CLAUDE.md`、`infra/`、`ui素材mingwu/` 均保留原样。

**建议下一批任务**

在小喵复验本返修并验收"获取主进度树"后，可选：实现"修改关卡"与"设置关卡状态"；或先做 ProjectTask 的任务完成/审核流转；再排"获取项目当前状态"与"获取项目历史记录"。由小喵确定顺序。

**等待小喵审核。**

---

## 小喵返修验收结果 #3 · 2026-08-09

**结论：返修通过，检查点 #3 关闭。**

小喵已复核数据完整性错误、组树算法、HTTP 错误映射、测试注入方式及 PostgreSQL 约束说明，并独立执行：

- `npm.cmd run typecheck`：通过；
- `npm.cmd test`：10 个测试文件、**129/129** 通过；
- `git diff --check`：通过，仅有 Windows 行尾提示，无空白错误。

验收确认：正常任务树仍完整返回并逐层排序；孤儿父引用、自引用与两节点循环都会被明确识别，不会被提升为 root 或静默丢弃；HTTP 层统一返回 500 `project_task_tree_corrupt` 与通用文案，响应不包含内部任务或关卡 id；第六关 PostgreSQL 根任务 position 唯一约束说明已修正。

已由小喵在 `docs/project-plan-v0.1.md` 勾选：

- `获取主进度树`

`assignedActorId` 的真实 Actor 存在性与身份绑定继续留在身份模型/持久化批次，不影响本次验收。

**检查点 #3 已关闭。**
