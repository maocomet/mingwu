import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  SUMMARY_CONTENT_MAX_LENGTH,
  SUMMARY_SOURCES,
  countCodePoints,
  studySummaryBodySchema,
  studySummaryJsonSchema,
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
// 运行时（app.ts）同样关闭 coerceTypes，与契约层一致：expectedRevision 的
// 数字字符串（如 "1"）在 HTTP 层也会被 400 拒绝，不会发生类型强制转换。
const ajv = new Ajv({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: true,
});

function compile(schema: object) {
  return ajv.compile(schema);
}

describe('StudySummary contract schemas', () => {
  describe('studySummaryBodySchema', () => {
    it('accepts a valid create request with expectedRevision 0', () => {
      const validate = compile({ ...studySummaryBodySchema });
      expect(
        validate({ content: '今天完成了 30 分钟专注', source: 'user', expectedRevision: 0 }),
      ).toBe(true);
    });

    it('accepts a valid update request with a positive expectedRevision', () => {
      const validate = compile({ ...studySummaryBodySchema });
      expect(
        validate({ content: '更新后的总结', source: 'ai_assisted', expectedRevision: 2 }),
      ).toBe(true);
    });

    it('accepts content up to the shared max length', () => {
      const validate = compile({ ...studySummaryBodySchema });
      expect(
        validate({
          content: 'x'.repeat(SUMMARY_CONTENT_MAX_LENGTH),
          source: 'user',
          expectedRevision: 0,
        }),
      ).toBe(true);
    });

    it('rejects content longer than the shared max length', () => {
      const validate = compile({ ...studySummaryBodySchema });
      expect(
        validate({
          content: 'x'.repeat(SUMMARY_CONTENT_MAX_LENGTH + 1),
          source: 'user',
          expectedRevision: 0,
        }),
      ).toBe(false);
    });

    it('measures length in Unicode code points, so exactly max emoji are valid', () => {
      const validate = compile({ ...studySummaryBodySchema });
      // 😀 是 U+1F600：UTF-16 占 2 个 code unit 但只有 1 个 code point。
      // JSON Schema maxLength 按 code point 计数，与服务层 countCodePoints 对齐；
      // '😀'.repeat(5000) 的 UTF-16 length 是 10000，但 code point 数正好 5000，应通过。
      const base = { source: 'user', expectedRevision: 0 };
      expect(validate({ content: '😀'.repeat(SUMMARY_CONTENT_MAX_LENGTH), ...base })).toBe(true);
      expect(
        validate({ content: '😀'.repeat(SUMMARY_CONTENT_MAX_LENGTH + 1), ...base }),
      ).toBe(false);
    });

    it('rejects an empty content string and a non-string content', () => {
      const validate = compile({ ...studySummaryBodySchema });
      expect(validate({ content: '', source: 'user', expectedRevision: 0 })).toBe(false);
      expect(validate({ content: 42, source: 'user', expectedRevision: 0 })).toBe(false);
    });

    it('rejects a missing or unknown source', () => {
      const validate = compile({ ...studySummaryBodySchema });
      expect(validate({ content: '总结', expectedRevision: 0 })).toBe(false);
      expect(validate({ content: '总结', source: 'system', expectedRevision: 0 })).toBe(false);
    });

    it('rejects a missing or non-integer expectedRevision', () => {
      const validate = compile({ ...studySummaryBodySchema });
      expect(validate({ content: '总结', source: 'user' })).toBe(false);
      expect(validate({ content: '总结', source: 'user', expectedRevision: 1.5 })).toBe(false);
      expect(validate({ content: '总结', source: 'user', expectedRevision: -1 })).toBe(false);
    });

    it('rejects a string expectedRevision without coercion', () => {
      const validate = compile({ ...studySummaryBodySchema });
      expect(validate({ content: '总结', source: 'user', expectedRevision: '1' })).toBe(false);
    });

    it('rejects protected and identity fields strictly, including actorId', () => {
      const validate = compile({ ...studySummaryBodySchema });
      const base = { content: '总结', source: 'user', expectedRevision: 0 };
      expect(validate({ ...base, actorId: 'x' })).toBe(false);
      expect(validate({ ...base, id: uuid() })).toBe(false);
      expect(validate({ ...base, studySessionId: uuid() })).toBe(false);
      expect(validate({ ...base, revision: 1 })).toBe(false);
      expect(validate({ ...base, confirmedByUserAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
      expect(validate({ ...base, createdAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
      expect(validate({ ...base, updatedAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
    });
  });

  describe('studySummaryJsonSchema', () => {
    function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      const now = new Date().toISOString();
      return {
        id: uuid(),
        studySessionId: uuid(),
        content: '完成今天的单词背诵',
        source: 'user',
        revision: 1,
        confirmedByUserAt: now,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      };
    }

    it('accepts a fully-formed summary', () => {
      const validate = compile({ ...studySummaryJsonSchema });
      expect(validate(summary())).toBe(true);
    });

    it('accepts the ai_assisted source', () => {
      const validate = compile({ ...studySummaryJsonSchema });
      expect(validate(summary({ source: 'ai_assisted' }))).toBe(true);
    });

    it('rejects a missing required field', () => {
      const validate = compile({ ...studySummaryJsonSchema });
      const { revision, ...missing } = summary();
      expect(validate(missing)).toBe(false);
    });

    it('rejects extra fields', () => {
      const validate = compile({ ...studySummaryJsonSchema });
      expect(validate(summary({ status: 'completed' }))).toBe(false);
    });

    it('enforces uuid id and studySessionId', () => {
      const validate = compile({ ...studySummaryJsonSchema });
      expect(validate(summary({ id: 'nope' }))).toBe(false);
      expect(validate(summary({ studySessionId: 'nope' }))).toBe(false);
    });

    it('enforces revision >= 1 and an integer revision', () => {
      const validate = compile({ ...studySummaryJsonSchema });
      expect(validate(summary({ revision: 0 }))).toBe(false);
      expect(validate(summary({ revision: -1 }))).toBe(false);
      expect(validate(summary({ revision: 1.5 }))).toBe(false);
    });

    it('rejects a source outside the enum', () => {
      const validate = compile({ ...studySummaryJsonSchema });
      expect(validate(summary({ source: 'bogus' }))).toBe(false);
    });

    it('enforces content type and length', () => {
      const validate = compile({ ...studySummaryJsonSchema });
      expect(validate(summary({ content: '' }))).toBe(false);
      expect(validate(summary({ content: 'x'.repeat(SUMMARY_CONTENT_MAX_LENGTH + 1) }))).toBe(false);
      expect(validate(summary({ content: 42 }))).toBe(false);
    });
  });

  describe('shared constants', () => {
    it('declares the user and ai_assisted sources and a positive max length', () => {
      expect(SUMMARY_SOURCES).toEqual(['user', 'ai_assisted']);
      expect(SUMMARY_CONTENT_MAX_LENGTH).toBeGreaterThan(0);
    });
  });

  describe('countCodePoints', () => {
    it('counts Unicode code points, not UTF-16 code units', () => {
      expect(countCodePoints('')).toBe(0);
      expect(countCodePoints('abc')).toBe(3);
      expect(countCodePoints('😀')).toBe(1);
      expect('😀'.length).toBe(2);
      expect(countCodePoints('😀'.repeat(SUMMARY_CONTENT_MAX_LENGTH))).toBe(
        SUMMARY_CONTENT_MAX_LENGTH,
      );
      expect('😀'.repeat(SUMMARY_CONTENT_MAX_LENGTH).length).toBe(
        SUMMARY_CONTENT_MAX_LENGTH * 2,
      );
    });
  });
});
