import type { AiActorType } from '@mingwu/contracts';
import { InMemoryMcpAuthenticator } from '../src/infrastructure/auth/in-memory-mcp-authenticator.js';

/**
 * MCP 认证测试固定凭据。全部是测试专用假 token，不是任何真实秘密；
 * 固定 UUID 保证断言确定性。token 仅在构造认证器时用于计算摘要，随后丢弃。
 */
export const AUTH_FIXTURES = {
  actorA: {
    actorId: '00000000-0000-4000-8000-000000000201',
    actorCode: 'xiaoke',
    actorType: 'resident_ai' as AiActorType,
    permissionProfile: 'default',
  },
  actorB: {
    actorId: '00000000-0000-4000-8000-000000000202',
    actorCode: 'xiaomiao',
    actorType: 'resident_ai' as AiActorType,
    permissionProfile: 'default',
  },
  connection1: {
    connectionId: '00000000-0000-4000-8000-000000000101',
    token: 'test-token-alpha-conn1',
  },
  connection2: {
    connectionId: '00000000-0000-4000-8000-000000000102',
    token: 'test-token-alpha-conn2',
  },
  connectionB: {
    connectionId: '00000000-0000-4000-8000-000000000103',
    token: 'test-token-beta-conn1',
  },
} as const;

/** 默认认证器登记：actorA 有两条连接（connection1 / connection2），actorB 一条。 */
export function makeAuthConfigs() {
  const { actorA, actorB, connection1, connection2, connectionB } = AUTH_FIXTURES;
  return [
    {
      connectionId: connection1.connectionId,
      actorId: actorA.actorId,
      actorCode: actorA.actorCode,
      actorType: actorA.actorType,
      permissionProfile: actorA.permissionProfile,
      token: connection1.token,
    },
    {
      connectionId: connection2.connectionId,
      actorId: actorA.actorId,
      actorCode: actorA.actorCode,
      actorType: actorA.actorType,
      permissionProfile: actorA.permissionProfile,
      token: connection2.token,
    },
    {
      connectionId: connectionB.connectionId,
      actorId: actorB.actorId,
      actorCode: actorB.actorCode,
      actorType: actorB.actorType,
      permissionProfile: actorB.permissionProfile,
      token: connectionB.token,
    },
  ] as const;
}

/** 构造带固定凭据的内存认证器。 */
export function makeAuthenticator(): InMemoryMcpAuthenticator {
  return new InMemoryMcpAuthenticator(makeAuthConfigs());
}
