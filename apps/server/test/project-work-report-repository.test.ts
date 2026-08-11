import { describe, expect, it } from 'vitest';
import { InMemoryProjectWorkReportRepository } from '../src/infrastructure/repositories/in-memory-project-work-report-repository.js';
import { createInMemoryStore } from '../src/infrastructure/stores/in-memory-store.js';
import { makeProjectWorkReport, uuid } from './helpers.js';

function makeRepo() {
  const store = createInMemoryStore();
  const repo = new InMemoryProjectWorkReportRepository(store);
  return { store, repo };
}

describe('InMemoryProjectWorkReportRepository.listByStageId', () => {
  it('returns an empty list for a stage with no reports', async () => {
    const { repo } = makeRepo();
    expect(await repo.listByStageId(uuid())).toEqual([]);
  });

  it('returns only reports directly associated with the requested stage (cross-stage isolation)', async () => {
    const { repo } = makeRepo();
    const stageA = uuid();
    const stageB = uuid();
    const a1 = makeProjectWorkReport({ stageId: stageA, submittedAt: '2026-08-11T01:00:00.000Z' });
    const b1 = makeProjectWorkReport({ stageId: stageB, submittedAt: '2026-08-11T02:00:00.000Z' });
    const a2 = makeProjectWorkReport({ stageId: stageA, submittedAt: '2026-08-11T03:00:00.000Z' });
    repo.seed(a1);
    repo.seed(b1);
    repo.seed(a2);

    const listA = await repo.listByStageId(stageA);
    expect(listA.map((r) => r.id).sort()).toEqual([a1.id, a2.id].sort());
    // 其他关卡的报告不混入。
    expect(listA.map((r) => r.id)).not.toContain(b1.id);
    expect(await repo.listByStageId(stageB)).toHaveLength(1);
  });

  it('excludes project-level reports (stageId null) from a stage list', async () => {
    const { repo } = makeRepo();
    const stageId = uuid();
    repo.seed(makeProjectWorkReport({ stageId, submittedAt: '2026-08-11T01:00:00.000Z' }));
    repo.seed(makeProjectWorkReport({ stageId: null, submittedAt: '2026-08-11T02:00:00.000Z' }));
    const list = await repo.listByStageId(stageId);
    expect(list).toHaveLength(1);
    expect(list[0]!.stageId).toBe(stageId);
  });

  it('sorts by submittedAt newest-first, then id ascending as a deterministic tie-break', async () => {
    const { repo } = makeRepo();
    const stageId = uuid();
    // 同一 submittedAt 的两条：按 id 升序兜底。
    const sameTimeLowId = makeProjectWorkReport({
      id: '00000000-0000-4000-8000-000000000001',
      stageId,
      submittedAt: '2026-08-11T05:00:00.000Z',
    });
    const sameTimeHighId = makeProjectWorkReport({
      id: '00000000-0000-4000-8000-000000000002',
      stageId,
      submittedAt: '2026-08-11T05:00:00.000Z',
    });
    const newest = makeProjectWorkReport({
      stageId,
      submittedAt: '2026-08-11T08:00:00.000Z',
    });
    const oldest = makeProjectWorkReport({
      stageId,
      submittedAt: '2026-08-11T00:00:00.000Z',
    });
    // 乱序写入，验证排序与插入顺序无关。
    repo.seed(oldest);
    repo.seed(sameTimeHighId);
    repo.seed(newest);
    repo.seed(sameTimeLowId);

    const list = await repo.listByStageId(stageId);
    expect(list.map((r) => r.id)).toEqual([
      newest.id,
      sameTimeLowId.id,
      sameTimeHighId.id,
      oldest.id,
    ]);
  });

  it('returns deep copies: mutating the returned list does not pollute the store', async () => {
    const { repo } = makeRepo();
    const stageId = uuid();
    const report = makeProjectWorkReport({ stageId, submittedAt: '2026-08-11T01:00:00.000Z' });
    repo.seed(report);

    const list = await repo.listByStageId(stageId);
    list[0]!.roundGoal = 'mutated';
    list[0]!.changedFiles.push('mutated.ts');
    (list as unknown as { push: (r: unknown) => void }).push({ fake: true });

    const again = await repo.listByStageId(stageId);
    expect(again).toHaveLength(1);
    expect(again[0]!.roundGoal).toBe(report.roundGoal);
    expect(again[0]!.changedFiles).toEqual(report.changedFiles);
  });

  it('seed stores a deep copy: mutating the seeded object after seed does not pollute the store', async () => {
    const { repo } = makeRepo();
    const stageId = uuid();
    const report = makeProjectWorkReport({ stageId, submittedAt: '2026-08-11T01:00:00.000Z' });
    repo.seed(report);
    report.roundGoal = 'mutated after seed';
    report.changedFiles.push('mutated.ts');

    const list = await repo.listByStageId(stageId);
    expect(list[0]!.roundGoal).not.toBe('mutated after seed');
    expect(list[0]!.changedFiles).not.toContain('mutated.ts');
  });
});
