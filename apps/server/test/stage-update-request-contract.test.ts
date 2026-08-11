import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_STAGE_STATUSES,
  STAGE_UPDATE_NOTE_MAX_LENGTH,
  STAGE_UPDATE_REASON_MAX_LENGTH,
  STAGE_UPDATE_REQUEST_DECISION_TYPES,
  STAGE_UPDATE_REQUEST_STATUSES,
  requestChangesBodySchema,
  stageUpdateRequestJsonSchema,
  stageUpdateRequestParamsSchema,
} from '@mingwu/contracts';
import { makeStageUpdateRequest, uuid } from './helpers.js';

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

  describe('requestChangesBodySchema', () => {
    it('accepts only expectedRevision + note and rejects protected/extra fields', () => {
      const validate = compile({ ...requestChangesBodySchema });
      expect(validate({ expectedRevision: 1, note: '请补充细节' })).toBe(true);
      // schema 只保证非空；trim 边界由服务层拒绝（'  ' 长度 2 通过 schema）。
      expect(validate({ expectedRevision: 1, note: '  ' })).toBe(true);
      expect(validate({ expectedRevision: 1, note: 'x', actorId: uuid() })).toBe(false);
      expect(validate({ expectedRevision: 1, note: 'x', requesterActorId: uuid() })).toBe(false);
      expect(validate({ expectedRevision: 1, note: 'x', status: 'approved' })).toBe(false);
      expect(validate({ expectedRevision: 1, note: 'x', decision: {} })).toBe(false);
      expect(validate({ expectedRevision: 1, note: 'x', decidedAt: 't' })).toBe(false);
      expect(validate({ expectedRevision: 1, note: 'x', updatedAt: 't' })).toBe(false);
      expect(validate({ expectedRevision: 1, note: 'x', revision: 9 })).toBe(false);
      expect(validate({ expectedRevision: 1, note: 'x', stageId: uuid() })).toBe(false);
      expect(validate({ expectedRevision: 1, note: 'x', proposedStatus: 'completed' })).toBe(
        false,
      );
    });

    it('enforces expectedRevision as a JSON integer >= 1 and note non-empty within the code-point bound', () => {
      const validate = compile({ ...requestChangesBodySchema });
      expect(validate({ expectedRevision: 1, note: 'x' })).toBe(true);
      expect(validate({ expectedRevision: 0, note: 'x' })).toBe(false);
      expect(validate({ expectedRevision: -1, note: 'x' })).toBe(false);
      expect(validate({ expectedRevision: 1.5, note: 'x' })).toBe(false);
      // coerceTypes:false：数字字符串不会悄悄转换。
      expect(validate({ expectedRevision: '1', note: 'x' })).toBe(false);
      expect(validate({ expectedRevision: 1, note: '' })).toBe(false);
      expect(validate({ expectedRevision: 1 })).toBe(false);
      expect(validate({ note: 'x' })).toBe(false);
      // 恰好上限个 astral emoji 放行（code point 语义），上限 + 1 拒绝。
      expect(
        validate({ expectedRevision: 1, note: '😀'.repeat(STAGE_UPDATE_NOTE_MAX_LENGTH) }),
      ).toBe(true);
      expect(
        validate({ expectedRevision: 1, note: '😀'.repeat(STAGE_UPDATE_NOTE_MAX_LENGTH + 1) }),
      ).toBe(false);
    });
  });

  describe('stageUpdateRequestParamsSchema', () => {
    it('requires a UUID id and rejects extra params', () => {
      const validate = compile({ ...stageUpdateRequestParamsSchema });
      expect(validate({ id: uuid() })).toBe(true);
      expect(validate({})).toBe(false);
      expect(validate({ id: 'nope' })).toBe(false);
      expect(validate({ id: uuid(), extra: 1 })).toBe(false);
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
      expect(STAGE_UPDATE_NOTE_MAX_LENGTH).toBe(STAGE_UPDATE_REASON_MAX_LENGTH);
      expect(STAGE_UPDATE_REQUEST_DECISION_TYPES).toEqual(['needs_changes', 'rejected']);
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

    it('stageUpdateRequestJsonSchema requires decision (nullable) with only the declared decision types', () => {
      const validate = compile({ ...stageUpdateRequestJsonSchema });
      // decision 必填且可为 null（pending 申请）。
      const base = makeStageUpdateRequest();
      const { decision, ...missingDecision } = base;
      expect(validate({ ...missingDecision })).toBe(false);
      expect(validate(makeStageUpdateRequest())).toBe(true);

      // 已决定：type 只允许 STAGE_UPDATE_REQUEST_DECISION_TYPES 声明的类型
      // （needs_changes / rejected）。
      const decided = makeStageUpdateRequest({
        status: 'needs_changes',
        revision: 2,
        decision: { type: 'needs_changes', note: '请补充细节', decidedAt: '2026-08-11T08:00:00.000Z' },
      });
      expect(validate(decided)).toBe(true);
      const rejected = makeStageUpdateRequest({
        status: 'rejected',
        revision: 2,
        decision: { type: 'rejected', note: '不符合要求', decidedAt: '2026-08-11T08:00:00.000Z' },
      });
      expect(validate(rejected)).toBe(true);
      expect(
        validate({ ...decided, decision: { type: 'approved', note: 'x', decidedAt: 't' } }),
      ).toBe(false);
      // decision 对象必须完整，缺 decidedAt / 带额外键均拒绝。
      expect(
        validate({ ...decided, decision: { type: 'needs_changes', note: 'x' } }),
      ).toBe(false);
      expect(
        validate({
          ...decided,
          decision: { type: 'needs_changes', note: 'x', decidedAt: 't', extra: 1 },
        }),
      ).toBe(false);
    });
  });
});
