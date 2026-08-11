import { describe, expect, it } from 'vitest';
import {
  InMemoryMcpAuthenticator,
  type InMemoryCredentialConfig,
} from '../src/infrastructure/auth/in-memory-mcp-authenticator.js';
import { McpAuthConfigurationError, McpAuthenticationError } from '../src/domain/mcp-auth/errors.js';
import { MCP_AUTH_PERMISSION_PROFILE_MAX_LENGTH } from '../src/domain/mcp-auth/mcp-authenticator.js';
import { AUTH_FIXTURES, makeAuthConfigs } from './mcp-auth-fixtures.js';

describe('InMemoryMcpAuthenticator', () => {
  it('resolves a valid credential to the correct Actor and Connection context', async () => {
    const auth = new InMemoryMcpAuthenticator(makeAuthConfigs());
    const context = await auth.authenticate(AUTH_FIXTURES.connection1.token);
    expect(context.actorId).toBe(AUTH_FIXTURES.actorA.actorId);
    expect(context.connectionId).toBe(AUTH_FIXTURES.connection1.connectionId);
    expect(context.actorCode).toBe(AUTH_FIXTURES.actorA.actorCode);
    expect(context.actorType).toBe(AUTH_FIXTURES.actorA.actorType);
    expect(context.permissionProfile).toBe(AUTH_FIXTURES.actorA.permissionProfile);
    // 另一条连接解析到同一 Actor、不同 Connection。
    const other = await auth.authenticate(AUTH_FIXTURES.connection2.token);
    expect(other.actorId).toBe(AUTH_FIXTURES.actorA.actorId);
    expect(other.connectionId).toBe(AUTH_FIXTURES.connection2.connectionId);
    // 另一 Actor 连接解析到不同 Actor。
    const beta = await auth.authenticate(AUTH_FIXTURES.connectionB.token);
    expect(beta.actorId).toBe(AUTH_FIXTURES.actorB.actorId);
  });

  it('rejects an unknown or empty token with a controlled error', async () => {
    const auth = new InMemoryMcpAuthenticator(makeAuthConfigs());
    await expect(auth.authenticate('wrong-token')).rejects.toBeInstanceOf(
      McpAuthenticationError,
    );
    await expect(auth.authenticate('')).rejects.toBeInstanceOf(McpAuthenticationError);
  });

  it('rejects a revoked connection immediately while other connections keep working', async () => {
    const auth = new InMemoryMcpAuthenticator(makeAuthConfigs());
    await expect(auth.authenticate(AUTH_FIXTURES.connection1.token)).resolves.toBeTruthy();
    auth.revoke(AUTH_FIXTURES.connection1.connectionId);
    await expect(auth.authenticate(AUTH_FIXTURES.connection1.token)).rejects.toBeInstanceOf(
      McpAuthenticationError,
    );
    // 同一 Actor 的另一条连接未被撤销，仍可用。
    await expect(auth.authenticate(AUTH_FIXTURES.connection2.token)).resolves.toBeTruthy();
  });

  it('rejects an expired credential', async () => {
    const auth = new InMemoryMcpAuthenticator([
      { ...makeAuthConfigs()[0]!, expiresAt: '2020-01-01T00:00:00.000Z' },
    ]);
    await expect(auth.authenticate(AUTH_FIXTURES.connection1.token)).rejects.toBeInstanceOf(
      McpAuthenticationError,
    );
  });

  it('never stores or exposes the plaintext token, only an irreversible SHA-256 digest', async () => {
    const auth = new InMemoryMcpAuthenticator(makeAuthConfigs());
    const hashes = auth.hashes();
    expect(hashes).toHaveLength(makeAuthConfigs().length);
    for (const hash of hashes) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).not.toContain('token');
    }
    // 任何可观察序列化输出都不含明文 Token。
    const serialized = JSON.stringify(auth);
    for (const { token } of [AUTH_FIXTURES.connection1, AUTH_FIXTURES.connection2, AUTH_FIXTURES.connectionB]) {
      expect(serialized).not.toContain(token);
    }
  });

  it('validates configuration defensively: invalid UUID / enum / length are rejected', () => {
    const base: InMemoryCredentialConfig = { ...makeAuthConfigs()[0]! };
    const invalid: Array<Partial<InMemoryCredentialConfig>> = [
      { actorId: 'not-a-uuid' },
      { connectionId: 'not-a-uuid' },
      { actorCode: '' },
      { actorType: 'unknown_type' as InMemoryCredentialConfig['actorType'] },
      { permissionProfile: '' },
      { permissionProfile: '   ' },
      // 超过受控长度上限：permissionProfile 长度上限以内可用、超出即拒绝。
      { permissionProfile: 'x'.repeat(MCP_AUTH_PERMISSION_PROFILE_MAX_LENGTH + 1) },
    ];
    for (const overrides of invalid) {
      expect(() => new InMemoryMcpAuthenticator([{ ...base, ...overrides }])).toThrow(
        McpAuthConfigurationError,
      );
    }
    // 恰好等于上限仍然合法。
    expect(
      () =>
        new InMemoryMcpAuthenticator([
          { ...base, permissionProfile: 'x'.repeat(MCP_AUTH_PERMISSION_PROFILE_MAX_LENGTH) },
        ]),
    ).not.toThrow();
  });

  it('rejects an invalid expiresAt at construction (fail-closed: never silently becomes never-expiring)', () => {
    const base: InMemoryCredentialConfig = { ...makeAuthConfigs()[0]! };
    const invalidDates = ['not-a-date', '2020-13-40T00:00:00.000Z', 'garbage', ''];
    for (const expiresAt of invalidDates) {
      expect(() => new InMemoryMcpAuthenticator([{ ...base, expiresAt }])).toThrow(
        McpAuthConfigurationError,
      );
    }
  });

  it('rejects a duplicate token hash at construction, even when bound to another Connection or Actor', () => {
    const [c1, c2, cB] = makeAuthConfigs().map((c) => ({ ...c }));
    // 同一 token 出现两次：不得静默覆盖。
    expect(() => new InMemoryMcpAuthenticator([c1!, c1!])).toThrow(McpAuthConfigurationError);
    // 同一 token 绑到同一 Actor 的另一条 Connection：不得把连接改绑。
    expect(() => new InMemoryMcpAuthenticator([c1!, { ...c2!, token: c1!.token }])).toThrow(
      McpAuthConfigurationError,
    );
    // 同一 token 绑到另一 Actor 的 Connection：不得把身份改绑。
    expect(() => new InMemoryMcpAuthenticator([c1!, { ...cB!, token: c1!.token }])).toThrow(
      McpAuthConfigurationError,
    );
  });

  it('keeps the plaintext token out of the thrown configuration error (no token or hash echoed)', () => {
    const [c1, c2] = makeAuthConfigs().map((c) => ({ ...c }));
    const SECRET = 'test-token-alpha-conn1';
    const err = (() => {
      try {
        new InMemoryMcpAuthenticator([c1!, { ...c2!, token: SECRET }]);
        throw new Error('expected construction to throw');
      } catch (e) {
        return e as unknown;
      }
    })();
    const serialized = JSON.stringify(err);
    expect(serialized).not.toContain(SECRET);
  });
});
