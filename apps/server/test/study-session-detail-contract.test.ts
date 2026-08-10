import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { studySessionDetailJsonSchema } from '@mingwu/contracts';
import {
  makeStudyParticipant,
  makeStudyReport,
  makeStudySession,
  makeStudySummary,
  uuid,
} from './helpers.js';

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

function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sessionId = uuid();
  return {
    session: makeStudySession({ id: sessionId }),
    summary: makeStudySummary({ studySessionId: sessionId }),
    participants: [makeStudyParticipant({ studySessionId: sessionId })],
    reports: [makeStudyReport({ studySessionId: sessionId })],
    ...overrides,
  };
}

describe('StudySessionDetail contract schema', () => {
  it('accepts a fully-formed detail with all four parts', () => {
    const validate = compile({ ...studySessionDetailJsonSchema });
    expect(validate(detail())).toBe(true);
  });

  it('accepts summary null and empty participants / reports arrays', () => {
    const validate = compile({ ...studySessionDetailJsonSchema });
    expect(validate(detail({ summary: null, participants: [], reports: [] }))).toBe(true);
  });

  it('rejects a missing required part and extra fields', () => {
    const validate = compile({ ...studySessionDetailJsonSchema });
    const { reports, ...missingReports } = detail();
    expect(validate(missingReports)).toBe(false);
    expect(validate(detail({ extra: 1 }))).toBe(false);
  });

  it('rejects invalid nested values: bad uuid session and malformed summary / participant / report', () => {
    const validate = compile({ ...studySessionDetailJsonSchema });
    expect(validate(detail({ session: makeStudySession({ id: 'nope' }) }))).toBe(false);
    expect(validate(detail({ summary: makeStudySummary({ revision: 0 }) }))).toBe(false);
    expect(validate(detail({ participants: [makeStudyParticipant({ actorId: 'xiaomiao' })] }))).toBe(
      false,
    );
    expect(
      validate(detail({ reports: [makeStudyReport({ sequenceNumber: 0 })] })),
    ).toBe(false);
  });
});
