import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_WORK_REPORT_TEXT_MAX_LENGTH,
  projectWorkReportJsonSchema,
  stageWorkReportListJsonSchema,
  stageWorkReportParamsSchema,
} from '@mingwu/contracts';
import { makeProjectWorkReport, uuid } from './helpers.js';

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

describe('ProjectWorkReport contract schemas', () => {
  describe('projectWorkReportJsonSchema', () => {
    it('accepts a fully-formed report associated with a stage', () => {
      const validate = compile({ ...projectWorkReportJsonSchema });
      expect(validate(makeProjectWorkReport())).toBe(true);
    });

    it('accepts a project-level report (stageId null) and reserved optional IDs null', () => {
      const validate = compile({ ...projectWorkReportJsonSchema });
      const report = makeProjectWorkReport({ stageId: null });
      expect(validate(report)).toBe(true);
      // 预留关联字段本批恒为 null。
      expect(validate(makeProjectWorkReport({ relatedTaskId: null, relatedAiTaskId: null, relatedReviewId: null }))).toBe(true);
    });

    it('rejects a missing required field and extra top-level fields', () => {
      const validate = compile({ ...projectWorkReportJsonSchema });
      const report = makeProjectWorkReport();
      const { roundGoal, ...missing } = report;
      expect(validate(missing)).toBe(false);
      expect(validate({ ...report, extra: 1 })).toBe(false);
    });

    it('rejects extra content inside array items (changedFiles / relatedAssetIds items are strict strings)', () => {
      const validate = compile({ ...projectWorkReportJsonSchema });
      expect(
        validate(makeProjectWorkReport({ changedFiles: [{ path: 'x' }] as never })),
      ).toBe(false);
      expect(
        validate(makeProjectWorkReport({ relatedAssetIds: [123] as never })),
      ).toBe(false);
    });

    it('accepts empty arrays and rejects non-uuid identity / ownership fields', () => {
      const validate = compile({ ...projectWorkReportJsonSchema });
      expect(validate(makeProjectWorkReport({ changedFiles: [], relatedAssetIds: [] }))).toBe(true);
      expect(validate(makeProjectWorkReport({ id: 'nope' }))).toBe(false);
      expect(validate(makeProjectWorkReport({ projectId: 'nope' }))).toBe(false);
      expect(validate(makeProjectWorkReport({ stageId: 'nope' }))).toBe(false);
      expect(validate(makeProjectWorkReport({ submittedActorId: 'nope' }))).toBe(false);
      expect(validate(makeProjectWorkReport({ relatedTaskId: 'nope' }))).toBe(false);
    });

    it('rejects text fields beyond the bound and oversized arrays', () => {
      const validate = compile({ ...projectWorkReportJsonSchema });
      expect(
        validate(
          makeProjectWorkReport({ roundGoal: 'x'.repeat(PROJECT_WORK_REPORT_TEXT_MAX_LENGTH + 1) }),
        ),
      ).toBe(false);
      expect(validate(makeProjectWorkReport({ changedFiles: Array.from({ length: 201 }, () => 'a') }))).toBe(false);
      expect(validate(makeProjectWorkReport({ relatedAssetIds: Array.from({ length: 101 }, () => 'a') }))).toBe(false);
    });
  });

  describe('stageWorkReportListJsonSchema', () => {
    it('accepts an empty list and a populated list', () => {
      const validate = compile({ ...stageWorkReportListJsonSchema });
      expect(validate({ reports: [] })).toBe(true);
      expect(validate({ reports: [makeProjectWorkReport(), makeProjectWorkReport()] })).toBe(true);
    });

    it('rejects a missing reports field, an extra top-level field, and a report item with undeclared content', () => {
      const validate = compile({ ...stageWorkReportListJsonSchema });
      expect(validate({})).toBe(false);
      expect(validate({ reports: [], extra: 1 })).toBe(false);
      expect(validate({ reports: [{ ...makeProjectWorkReport(), leaked: true }] })).toBe(false);
    });
  });

  describe('stageWorkReportParamsSchema', () => {
    it('accepts a uuid stageId and rejects non-uuid or extra fields', () => {
      const validate = compile({ ...stageWorkReportParamsSchema });
      expect(validate({ stageId: uuid() })).toBe(true);
      expect(validate({ stageId: 'nope' })).toBe(false);
      expect(validate({ stageId: uuid(), extra: 1 })).toBe(false);
      expect(validate({})).toBe(false);
    });
  });
});
