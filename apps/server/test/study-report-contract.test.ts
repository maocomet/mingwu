import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  AI_ACTOR_CODE_MAX_LENGTH,
  AI_ACTOR_TYPES,
  STUDY_REPORT_CONTENT_MAX_LENGTH,
  appendStudyReportInputSchema,
  studyParticipantJsonSchema,
  studyReportJsonSchema,
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

const ajv = new Ajv({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: true,
});

function compile(schema: object) {
  return ajv.compile(schema);
}

describe('StudyReport contract schemas', () => {
  describe('appendStudyReportInputSchema', () => {
    it('accepts a valid append request', () => {
      const validate = compile({ ...appendStudyReportInputSchema });
      expect(
        validate({ id: uuid(), studySessionId: uuid(), content: '完成了英语阅读' }),
      ).toBe(true);
    });

    it('rejects a missing id, studySessionId or content', () => {
      const validate = compile({ ...appendStudyReportInputSchema });
      expect(validate({ studySessionId: uuid(), content: 'x' })).toBe(false);
      expect(validate({ id: uuid(), content: 'x' })).toBe(false);
      expect(validate({ id: uuid(), studySessionId: uuid() })).toBe(false);
    });

    it('rejects non-uuid id and studySessionId', () => {
      const validate = compile({ ...appendStudyReportInputSchema });
      expect(validate({ id: 'nope', studySessionId: uuid(), content: 'x' })).toBe(false);
      expect(validate({ id: uuid(), studySessionId: 'nope', content: 'x' })).toBe(false);
    });

    it('rejects identity, sequence and server-owned fields strictly', () => {
      const validate = compile({ ...appendStudyReportInputSchema });
      const base = { id: uuid(), studySessionId: uuid(), content: 'x' };
      expect(validate({ ...base, actorId: uuid() })).toBe(false);
      expect(validate({ ...base, actorCode: 'xiaomiao' })).toBe(false);
      // 三种真实 actorType 值一律严格拒绝：身份只能由服务端认证上下文注入。
      expect(validate({ ...base, actorType: 'resident_ai' })).toBe(false);
      expect(validate({ ...base, actorType: 'temporary_ai' })).toBe(false);
      expect(validate({ ...base, actorType: 'reviewer' })).toBe(false);
      expect(validate({ ...base, actorType: 'ai' })).toBe(false);
      expect(validate({ ...base, author: 'xiaomiao' })).toBe(false);
      expect(validate({ ...base, createdBy: 'xiaomiao' })).toBe(false);
      expect(validate({ ...base, sequenceNumber: 1 })).toBe(false);
      expect(validate({ ...base, submittedAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
    });

    it('rejects empty and non-string content', () => {
      const validate = compile({ ...appendStudyReportInputSchema });
      expect(validate({ id: uuid(), studySessionId: uuid(), content: '' })).toBe(false);
      expect(validate({ id: uuid(), studySessionId: uuid(), content: 42 })).toBe(false);
    });

    it('measures content length in Unicode code points (emoji boundary)', () => {
      const validate = compile({ ...appendStudyReportInputSchema });
      // 😀 是 U+1F600：UTF-16 占 2 个 code unit 但只有 1 个 code point；
      // JSON Schema maxLength 按 code point 计数，与服务层 countCodePoints 对齐。
      const base = { id: uuid(), studySessionId: uuid() };
      expect(
        validate({ ...base, content: '😀'.repeat(STUDY_REPORT_CONTENT_MAX_LENGTH) }),
      ).toBe(true);
      expect(
        validate({ ...base, content: '😀'.repeat(STUDY_REPORT_CONTENT_MAX_LENGTH + 1) }),
      ).toBe(false);
    });
  });

  describe('studyReportJsonSchema', () => {
    function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        id: uuid(),
        studySessionId: uuid(),
        actorId: uuid(),
        sequenceNumber: 1,
        content: 'AI 学习报告',
        submittedAt: new Date().toISOString(),
        ...overrides,
      };
    }

    it('accepts a fully-formed report', () => {
      const validate = compile({ ...studyReportJsonSchema });
      expect(validate(report())).toBe(true);
    });

    it('rejects a missing required field and extra fields', () => {
      const validate = compile({ ...studyReportJsonSchema });
      const { content, ...missing } = report();
      expect(validate(missing)).toBe(false);
      expect(validate(report({ extra: 1 }))).toBe(false);
    });

    it('enforces uuid id / studySessionId / actorId and sequenceNumber >= 1', () => {
      const validate = compile({ ...studyReportJsonSchema });
      expect(validate(report({ id: 'nope' }))).toBe(false);
      expect(validate(report({ studySessionId: 'nope' }))).toBe(false);
      expect(validate(report({ actorId: 'xiaomiao' }))).toBe(false);
      expect(validate(report({ sequenceNumber: 0 }))).toBe(false);
      expect(validate(report({ sequenceNumber: -1 }))).toBe(false);
      expect(validate(report({ sequenceNumber: 1.5 }))).toBe(false);
    });

    it('enforces content type and length', () => {
      const validate = compile({ ...studyReportJsonSchema });
      expect(validate(report({ content: '' }))).toBe(false);
      expect(validate(report({ content: 42 }))).toBe(false);
      expect(
        validate(report({ content: 'x'.repeat(STUDY_REPORT_CONTENT_MAX_LENGTH + 1) })),
      ).toBe(false);
    });
  });

  describe('studyParticipantJsonSchema', () => {
    function participant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      const now = new Date().toISOString();
      return {
        studySessionId: uuid(),
        actorId: uuid(),
        joinedAt: now,
        lastActiveAt: now,
        ...overrides,
      };
    }

    it('accepts a fully-formed participant', () => {
      const validate = compile({ ...studyParticipantJsonSchema });
      expect(validate(participant())).toBe(true);
    });

    it('rejects a missing required field, extra fields and non-uuid actorId', () => {
      const validate = compile({ ...studyParticipantJsonSchema });
      const { lastActiveAt, ...missing } = participant();
      expect(validate(missing)).toBe(false);
      expect(validate(participant({ joined: true }))).toBe(false);
      expect(validate(participant({ actorId: 'xiaomiao' }))).toBe(false);
    });
  });

  describe('shared constants', () => {
    it('declares the three fixed AI actor types and a positive report max length', () => {
      expect(AI_ACTOR_TYPES).toEqual(['resident_ai', 'temporary_ai', 'reviewer']);
      expect(STUDY_REPORT_CONTENT_MAX_LENGTH).toBeGreaterThan(0);
      expect(AI_ACTOR_CODE_MAX_LENGTH).toBeGreaterThan(0);
    });
  });
});
