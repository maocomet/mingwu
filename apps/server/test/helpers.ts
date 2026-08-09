import type { Project } from '@mingwu/contracts';

export function uuid(): string {
  return crypto.randomUUID();
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? uuid(),
    name: overrides.name ?? 'Test Project',
    description: overrides.description ?? null,
    goal: overrides.goal ?? null,
    scope: overrides.scope ?? null,
    currentVersion: overrides.currentVersion ?? null,
    currentVersionGoal: overrides.currentVersionGoal ?? null,
    coreFeatures: overrides.coreFeatures ?? null,
    outOfScope: overrides.outOfScope ?? null,
    importantPrinciples: overrides.importantPrinciples ?? null,
    status: overrides.status ?? 'active',
    version: overrides.version ?? 1,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    archivedAt: overrides.archivedAt ?? null,
  };
}
