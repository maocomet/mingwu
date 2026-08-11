import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_STAGE_STATUSES,
  STAGE_UPDATE_REASON_MAX_LENGTH,
  STAGE_UPDATE_REQUEST_STATUSES,
  stageUpdateRequestJsonSchema,
} from '@mingwu/contracts';
import { makeStageUpdateRequest } from './helpers.js';

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

describe('StageUpdateRequest contract schemas', () => {
  describe('stageUpdateRequestJsonSchema', () => {
    it('accepts a fully-formed pending request', () => {
      const validate = compile({ ...stageUpdateRequestJsonSchema });
      expect(validate(makeStageUpdateRequest())).toBe(true);
    });

    it('rejects a missing required field and extra fields', () => {
      const validate = compile({ ...stageUpdateRequestJsonSchema });
      const request = makeStageUpdateRequest();
      const { reason, ...missing } = request;
      expect(validate(missing)).toBe(false);
      expect(validate({ ...request, extra: 1 })).toBe(false);
    });

    it('accepts every declared request status and rejects non-uuid identity / ownership fields', () => {
      const validate = compile({ ...stageUpdateRequestJsonSchema });
      // 契约完整响应允许四种状态（本批创建路径固定写 pending，由服务层保证，
      // 为后续决定批次预留读取能力）。
      for (const status of STAGE_UPDATE_REQUEST_STATUSES) {
        expect(validate(makeStageUpdateRequest({ status }))).toBe(true);
      }
      expect(validate(makeStageUpdateRequest({ id: 'nope' }))).toBe(false);
      expect(validate(makeStageUpdateRequest({ projectId: 'nope' }))).toBe(false);
      expect(validate(makeStageUpdateRequest({ stageId: 'nope' }))).toBe(false);
      expect(validate(makeStageUpdateRequest({ requesterActorId: 'xiaomiao' }))).toBe(false);
    });

    it('enforces expectedStageVersion as a positive integer', () => {
      const validate = compile({ ...stageUpdateRequestJsonSchema });
      expect(validate(makeStageUpdateRequest({ expectedStageVersion: 0 }))).toBe(false);
      expect(validate(makeStageUpdateRequest({ expectedStageVersion: -1 }))).toBe(false);
      expect(validate(makeStageUpdateRequest({ expectedStageVersion: 1.5 }))).toBe(false);
      expect(validate(makeStageUpdateRequest({ expectedStageVersion: '2' as never }))).toBe(false);
    });

    it('enforces proposedStatus among legal stage statuses and reason non-empty', () => {
      const validate = compile({ ...stageUpdateRequestJsonSchema });
      expect(
        validate(makeStageUpdateRequest({ proposedStatus: 'not_a_status' as never })),
      ).toBe(false);
      expect(validate(makeStageUpdateRequest({ reason: '' }))).toBe(false);
      expect(validate(makeStageUpdateRequest({ reason: 42 as never }))).toBe(false);
    });

    it('measures reason length in Unicode code points (emoji boundary)', () => {
      const validate = compile({ ...stageUpdateRequestJsonSchema });
      // 😀 是 U+1F600：UTF-16 占 2 个 code unit 但只有 1 个 code point；
      // JSON Schema maxLength 按 code point 计数，与服务层 countCodePoints 对齐。
      const base = { ...makeStageUpdateRequest(), reason: 'x' };
      expect(validate({ ...base, reason: '😀'.repeat(STAGE_UPDATE_REASON_MAX_LENGTH) })).toBe(
        true,
      );
      expect(
        validate({ ...base, reason: '😀'.repeat(STAGE_UPDATE_REASON_MAX_LENGTH + 1) }),
      ).toBe(false);
    });
  });

  describe('shared constants', () => {
    it('declares the four request statuses with pending first and the seven legal stage statuses', () => {
      expect(STAGE_UPDATE_REQUEST_STATUSES).toEqual([
        'pending',
        'approved',
        'rejected',
        'needs_changes',
      ]);
      expect(PROJECT_STAGE_STATUSES).toHaveLength(7);
      expect(STAGE_UPDATE_REASON_MAX_LENGTH).toBeGreaterThan(0);
    });

    it('stageUpdateRequestJsonSchema declares all four request statuses', () => {
      // 契约与 STAGE_UPDATE_REQUEST_STATUSES 常量保持一致（本批只产生 pending，
      // 其余三种为后续用户决定批次预留，创建路径固定 pending 由服务层保证）。
      const validate = compile({ ...stageUpdateRequestJsonSchema });
      expect(
        (stageUpdateRequestJsonSchema as unknown as {
          properties: { status: { enum: string[] } };
        }).properties.status.enum,
      ).toEqual([...STAGE_UPDATE_REQUEST_STATUSES]);
      expect(validate(makeStageUpdateRequest())).toBe(true);
    });
  });
});
