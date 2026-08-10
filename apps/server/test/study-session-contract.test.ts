import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  TASK_TEXT_MAX_LENGTH,
  createStudySessionBodySchema,
  pauseStudySessionBodySchema,
  resumeStudySessionBodySchema,
  setCountdownBodySchema,
  setTaskBodySchema,
  startStudySessionBodySchema,
  studySessionJsonSchema,
} from '@mingwu/contracts';
import { uuid } from './helpers.js';

// ajv 已声明为 @mingwu/server 的 devDependency，契约测试直接使用，不依赖传递解析。
// NodeNext 对 CJS 默认导出的类型解析有歧义，这里用 createRequire 在运行时加载
// 并只声明测试需要的 compile 能力。
const require = createRequire(import.meta.url);
type Validate = (data: unknown) => boolean;
interface AjvLike {
  compile(schema: object): Validate;
}
const Ajv = require('ajv') as unknown as new (options: Record<string, unknown>) => AjvLike;

// 契约层校验只验证 schema 自身的类型约束，因此关闭 coerceTypes。
// 运行时（app.ts）同样关闭 coerceTypes，与契约层一致：JSON 请求中的
// 数字字符串（如 plannedDurationSeconds: "600"）在 HTTP 层也会被 400 拒绝，
// 不会发生类型强制转换。
const ajv = new Ajv({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: true,
});

function compile(schema: object) {
  return ajv.compile(schema);
}

describe('StudySession contract schemas', () => {
  describe('createStudySessionBodySchema', () => {
    it('accepts the minimal count_down draft', () => {
      const validate = compile({ ...createStudySessionBodySchema });
      expect(validate({ id: uuid(), timerMode: 'count_down' })).toBe(true);
    });

    it('accepts count_down with task text and duration', () => {
      const validate = compile({ ...createStudySessionBodySchema });
      expect(
        validate({
          id: uuid(),
          timerMode: 'count_down',
          taskText: '任务',
          plannedDurationSeconds: 600,
        }),
      ).toBe(true);
    });

    it('accepts explicit null taskText and null duration', () => {
      const validate = compile({ ...createStudySessionBodySchema });
      expect(
        validate({
          id: uuid(),
          timerMode: 'count_up',
          taskText: null,
          plannedDurationSeconds: null,
        }),
      ).toBe(true);
    });

    it('rejects an unknown field (strict whitelist, no actorId)', () => {
      const validate = compile({ ...createStudySessionBodySchema });
      expect(validate({ id: uuid(), timerMode: 'count_down', actorId: 'x' })).toBe(false);
    });

    it('rejects a missing timerMode and a missing id', () => {
      const validate = compile({ ...createStudySessionBodySchema });
      expect(validate({ id: uuid() })).toBe(false);
      expect(validate({ timerMode: 'count_down' })).toBe(false);
    });

    it('rejects a non-uuid id', () => {
      const validate = compile({ ...createStudySessionBodySchema });
      expect(validate({ id: 'not-a-uuid', timerMode: 'count_down' })).toBe(false);
    });

    it('rejects an unknown timerMode', () => {
      const validate = compile({ ...createStudySessionBodySchema });
      expect(validate({ id: uuid(), timerMode: 'elapsed' })).toBe(false);
    });

    it('enforces taskText length and type', () => {
      const validate = compile({ ...createStudySessionBodySchema });
      expect(
        validate({ id: uuid(), timerMode: 'count_down', taskText: 'x'.repeat(TASK_TEXT_MAX_LENGTH) }),
      ).toBe(true);
      expect(
        validate({
          id: uuid(),
          timerMode: 'count_down',
          taskText: 'x'.repeat(TASK_TEXT_MAX_LENGTH + 1),
        }),
      ).toBe(false);
      expect(validate({ id: uuid(), timerMode: 'count_down', taskText: 42 })).toBe(false);
    });

    it('enforces plannedDurationSeconds range, integer and type', () => {
      const validate = compile({ ...createStudySessionBodySchema });
      expect(validate({ id: uuid(), timerMode: 'count_down', plannedDurationSeconds: 1 })).toBe(true);
      expect(validate({ id: uuid(), timerMode: 'count_down', plannedDurationSeconds: 86400 })).toBe(
        true,
      );
      expect(validate({ id: uuid(), timerMode: 'count_down', plannedDurationSeconds: 0 })).toBe(
        false,
      );
      expect(validate({ id: uuid(), timerMode: 'count_down', plannedDurationSeconds: 86401 })).toBe(
        false,
      );
      expect(validate({ id: uuid(), timerMode: 'count_down', plannedDurationSeconds: 1.5 })).toBe(
        false,
      );
      expect(validate({ id: uuid(), timerMode: 'count_down', plannedDurationSeconds: '600' })).toBe(
        false,
      );
    });
  });

  describe('setTaskBodySchema', () => {
    it('accepts a valid request', () => {
      const validate = compile({ ...setTaskBodySchema });
      expect(validate({ expectedVersion: 1, taskText: '任务' })).toBe(true);
    });

    it('requires expectedVersion >= 1 and rejects extra fields', () => {
      const validate = compile({ ...setTaskBodySchema });
      expect(validate({ taskText: '任务' })).toBe(false);
      expect(validate({ expectedVersion: 0, taskText: '任务' })).toBe(false);
      expect(validate({ expectedVersion: 1, taskText: '任务', actorId: 'x' })).toBe(false);
    });

    it('enforces taskText type and length', () => {
      const validate = compile({ ...setTaskBodySchema });
      expect(validate({ expectedVersion: 1, taskText: '' })).toBe(false);
      expect(
        validate({ expectedVersion: 1, taskText: 'x'.repeat(TASK_TEXT_MAX_LENGTH + 1) }),
      ).toBe(false);
    });
  });

  describe('setCountdownBodySchema', () => {
    it('accepts a valid request', () => {
      const validate = compile({ ...setCountdownBodySchema });
      expect(validate({ expectedVersion: 1, plannedDurationSeconds: 600 })).toBe(true);
    });

    it('enforces the 1..86400 integer range', () => {
      const validate = compile({ ...setCountdownBodySchema });
      expect(validate({ expectedVersion: 1, plannedDurationSeconds: 1 })).toBe(true);
      expect(validate({ expectedVersion: 1, plannedDurationSeconds: 86400 })).toBe(true);
      expect(validate({ expectedVersion: 1, plannedDurationSeconds: 0 })).toBe(false);
      expect(validate({ expectedVersion: 1, plannedDurationSeconds: 86401 })).toBe(false);
      expect(validate({ expectedVersion: 1, plannedDurationSeconds: 1.5 })).toBe(false);
    });

    it('rejects extra fields and missing expectedVersion', () => {
      const validate = compile({ ...setCountdownBodySchema });
      expect(validate({ plannedDurationSeconds: 600 })).toBe(false);
      expect(
        validate({ expectedVersion: 1, plannedDurationSeconds: 600, status: 'created' }),
      ).toBe(false);
    });
  });

  describe('startStudySessionBodySchema', () => {
    it('accepts a valid start request', () => {
      const validate = compile({ ...startStudySessionBodySchema });
      expect(validate({ expectedVersion: 1 })).toBe(true);
    });

    it('requires expectedVersion >= 1 and rejects extra fields and a string version', () => {
      const validate = compile({ ...startStudySessionBodySchema });
      expect(validate({})).toBe(false);
      expect(validate({ expectedVersion: 0 })).toBe(false);
      expect(validate({ expectedVersion: '1' })).toBe(false);
      expect(validate({ expectedVersion: 1, actorId: 'x' })).toBe(false);
    });
  });

  describe('pauseStudySessionBodySchema', () => {
    it('accepts a valid pause request', () => {
      const validate = compile({ ...pauseStudySessionBodySchema });
      expect(validate({ expectedVersion: 1 })).toBe(true);
    });

    it('requires expectedVersion >= 1 and rejects extra fields and a string version', () => {
      const validate = compile({ ...pauseStudySessionBodySchema });
      expect(validate({})).toBe(false);
      expect(validate({ expectedVersion: 0 })).toBe(false);
      expect(validate({ expectedVersion: '1' })).toBe(false);
      expect(validate({ expectedVersion: 1, actorId: 'x' })).toBe(false);
    });
  });

  describe('resumeStudySessionBodySchema', () => {
    it('accepts a valid resume request', () => {
      const validate = compile({ ...resumeStudySessionBodySchema });
      expect(validate({ expectedVersion: 1 })).toBe(true);
    });

    it('requires expectedVersion >= 1 and rejects extra fields and a string version', () => {
      const validate = compile({ ...resumeStudySessionBodySchema });
      expect(validate({})).toBe(false);
      expect(validate({ expectedVersion: 0 })).toBe(false);
      expect(validate({ expectedVersion: '1' })).toBe(false);
      expect(validate({ expectedVersion: 1, status: 'running' })).toBe(false);
    });
  });

  describe('studySessionJsonSchema', () => {
    function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      const now = new Date().toISOString();
      return {
        id: uuid(),
        taskText: null,
        timerMode: 'count_down',
        plannedDurationSeconds: null,
        startedAt: null,
        pausedAt: null,
        endedAt: null,
        actualDurationSeconds: 0,
        pausedDurationSeconds: 0,
        status: 'created',
        version: 1,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      };
    }

    it('accepts a fully-formed created study session', () => {
      const validate = compile({ ...studySessionJsonSchema });
      expect(validate(session())).toBe(true);
    });

    it('rejects a session missing a required field', () => {
      const validate = compile({ ...studySessionJsonSchema });
      const { timerMode, ...missing } = session();
      expect(validate(missing)).toBe(false);
    });

    it('rejects a session carrying extra fields', () => {
      const validate = compile({ ...studySessionJsonSchema });
      expect(validate(session({ extra: 1 }))).toBe(false);
    });

    it('rejects a status value outside the enum', () => {
      const validate = compile({ ...studySessionJsonSchema });
      expect(validate(session({ status: 'bogus' }))).toBe(false);
    });
  });
});
