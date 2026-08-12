import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  AI_TASK_DESCRIPTION_MAX_LENGTH,
  AI_TASK_STATUSES,
  AI_TASK_TITLE_MAX_LENGTH,
  aiTaskJsonSchema,
  createAiTaskInputSchema,
} from '@mingwu/contracts';
import { makeAiTask, uuid } from './helpers.js';

// ajv 已声明为 @mingwu/server 的 devDependency，契约测试直接使用，不依赖传递解析。
// NodeNext 对 CJS 默认导出的类型解析有歧义，这里用 createRequire 在运行时加载
// 并只声明测试需要的 compile 能力。
const require = createRequire(import.meta.url);
type Validate = (data: unknown) => boolean;
interface AjvLike {
  compile(schema: object): Validate;
}
const Ajv = require('ajv') as unknown as new (options: Record<string, unknown>) => AjvLike;

const ajv = new Ajv({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: true,
});

function compile(schema: object) {
  return ajv.compile(schema);
}

/** makeAiTask 生成的完整 AiTask 对象，字段与 TypeScript `AiTask` 接口一一对应。 */
const fullAiTask = makeAiTask();

describe('aiTaskJsonSchema (完整 AI 任务响应)', () => {
  const validate = compile({ ...aiTaskJsonSchema });

  it('accepts a fully-formed AiTask with every field present', () => {
    expect(validate(fullAiTask)).toBe(true);
  });

  it('treats nullable fields as present-and-null: null is legal, missing is not', () => {
    // 值可为 null 的字段显式传 null → 合法。
    expect(
      validate(
        makeAiTask({
          projectTaskId: null,
          parentTaskId: null,
          description: null,
          blockerType: null,
          blockerReason: null,
          completedAt: null,
          archivedAt: null,
        }),
      ),
    ).toBe(true);
  });

  it('rejects the response when ANY single required field is missing (值可空 ≠ 字段可缺失)', () => {
    const required = aiTaskJsonSchema.required as readonly string[];
    // required 必须覆盖 AiTask 接口的全部 18 个字段。
    expect([...required].sort()).toEqual(
      [
        'id',
        'projectId',
        'ownerActorId',
        'projectTaskId',
        'parentTaskId',
        'title',
        'description',
        'status',
        'progressPercent',
        'notes',
        'blockerType',
        'blockerReason',
        'position',
        'version',
        'createdAt',
        'updatedAt',
        'completedAt',
        'archivedAt',
      ].sort(),
    );
    for (const key of required) {
      const rest = Object.fromEntries(
        Object.entries(fullAiTask).filter(([k]) => k !== key),
      );
      expect(validate(rest), `expected rejection when field "${key}" is missing`).toBe(false);
    }
  });

  it('rejects extra undeclared top-level fields', () => {
    expect(validate({ ...fullAiTask, leaked: true })).toBe(false);
  });

  it('rejects non-UUID identity / ownership fields', () => {
    expect(validate(makeAiTask({ id: 'nope' }))).toBe(false);
    expect(validate(makeAiTask({ projectId: 'nope' }))).toBe(false);
    expect(validate(makeAiTask({ ownerActorId: 'nope' }))).toBe(false);
    expect(validate(makeAiTask({ projectTaskId: 'nope' }))).toBe(false);
    expect(validate(makeAiTask({ parentTaskId: 'nope' }))).toBe(false);
  });

  it('bounds status, progress, position and version', () => {
    expect(validate(makeAiTask({ status: 'not_a_status' as never }))).toBe(false);
    expect(validate(makeAiTask({ progressPercent: -1 }))).toBe(false);
    expect(validate(makeAiTask({ progressPercent: 101 }))).toBe(false);
    expect(validate(makeAiTask({ position: 0 }))).toBe(false);
    expect(validate(makeAiTask({ version: 0 }))).toBe(false);
  });

  it('counts the response title / description bound in Unicode code points (astral emoji)', () => {
    // 恰好上限个 code point（200 个 emoji，每个 1 code point / 2 UTF-16 单元）→ 合法。
    expect(validate(makeAiTask({ title: '😀'.repeat(AI_TASK_TITLE_MAX_LENGTH) }))).toBe(true);
    expect(
      validate(makeAiTask({ description: '中'.repeat(AI_TASK_DESCRIPTION_MAX_LENGTH) })),
    ).toBe(true);
    // 超过 1 个 code point → 拒绝。
    expect(validate(makeAiTask({ title: '😀'.repeat(AI_TASK_TITLE_MAX_LENGTH + 1) }))).toBe(false);
  });

  it('accepts empty notes and rejects non-string note items', () => {
    expect(validate(makeAiTask({ notes: [] }))).toBe(true);
    expect(validate(makeAiTask({ notes: ['备注'] }))).toBe(true);
    expect(validate(makeAiTask({ notes: [123] as never }))).toBe(false);
  });
});

describe('createAiTaskInputSchema (创建输入白名单)', () => {
  const validate = compile({ ...createAiTaskInputSchema });

  it('accepts a valid create input with only whitelisted fields', () => {
    expect(
      validate({
        id: uuid(),
        projectId: uuid(),
        projectTaskId: null,
        parentTaskId: null,
        title: '我的任务',
        description: '描述',
      }),
    ).toBe(true);
    // 可空可选字段缺省时合法（description / projectTaskId / parentTaskId 都是可选的）。
    expect(validate({ id: uuid(), projectId: uuid(), title: '仅标题' })).toBe(true);
  });

  it('does NOT wrongly reject a padded title / description that is legal after trim', () => {
    // 前导空格 + 恰好 200 个 emoji（200 code points）+ 尾随空格：
    // trim 后为合法上限，服务层与 MCP refine 都应接受；schema 不设长度，也不应拒绝。
    const paddedTitle = `  ${'😀'.repeat(AI_TASK_TITLE_MAX_LENGTH)}  `;
    expect(validate({ id: uuid(), projectId: uuid(), title: paddedTitle })).toBe(true);
    // 描述同理：恰好 2000 code points + 首尾空白。
    const paddedDescription = ` ${'中'.repeat(AI_TASK_DESCRIPTION_MAX_LENGTH)} `;
    expect(
      validate({ id: uuid(), projectId: uuid(), title: 'X', description: paddedDescription }),
    ).toBe(true);
    // 超长（trim 后仍超 1）由业务服务 / MCP refine 拒绝，不在此 schema 层判定——
    // 契约不再对服务本应接受的输入产生先于入口的错误拒绝。
    expect(validate({ id: uuid(), projectId: uuid(), title: '😀'.repeat(1000) })).toBe(true);
    expect(validate({ id: uuid(), projectId: uuid(), title: '   ' })).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(validate({ projectId: uuid(), title: 'X' })).toBe(false);
    expect(validate({ id: uuid(), title: 'X' })).toBe(false);
    expect(validate({ id: uuid(), projectId: uuid() })).toBe(false);
    expect(validate({})).toBe(false);
  });

  it('rejects smuggled identity / status / protected fields and unknown fields', () => {
    const base = { id: uuid(), projectId: uuid(), title: 'X' };
    expect(validate({ ...base, ownerActorId: uuid() })).toBe(false);
    expect(validate({ ...base, actor_id: uuid() })).toBe(false);
    expect(validate({ ...base, actorId: uuid() })).toBe(false);
    expect(validate({ ...base, actorCode: 'forged' })).toBe(false);
    expect(validate({ ...base, status: 'completed' })).toBe(false);
    expect(validate({ ...base, progressPercent: 100 })).toBe(false);
    expect(validate({ ...base, notes: ['x'] })).toBe(false);
    expect(validate({ ...base, blockerType: 'x' })).toBe(false);
    expect(validate({ ...base, blockerReason: 'x' })).toBe(false);
    expect(validate({ ...base, position: 1 })).toBe(false);
    expect(validate({ ...base, version: 1 })).toBe(false);
    expect(validate({ ...base, createdAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
    expect(validate({ ...base, updatedAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
    expect(validate({ ...base, completedAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
    expect(validate({ ...base, archivedAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
    expect(validate({ ...base, bogus: 1 })).toBe(false);
  });

  it('rejects non-UUID ids and non-string titles', () => {
    expect(validate({ id: 'nope', projectId: uuid(), title: 'X' })).toBe(false);
    expect(validate({ id: uuid(), projectId: 'nope', title: 'X' })).toBe(false);
    expect(validate({ id: uuid(), projectId: uuid(), projectTaskId: 'nope', title: 'X' })).toBe(false);
    expect(validate({ id: uuid(), projectId: uuid(), parentTaskId: 'nope', title: 'X' })).toBe(false);
    expect(validate({ id: uuid(), projectId: uuid(), title: 123 })).toBe(false);
  });

  it('still whitelists status values for the response contract', () => {
    const validateStatus = compile({ ...aiTaskJsonSchema });
    for (const status of AI_TASK_STATUSES) {
      expect(validateStatus(makeAiTask({ status })), `status=${status}`).toBe(true);
    }
  });
});
