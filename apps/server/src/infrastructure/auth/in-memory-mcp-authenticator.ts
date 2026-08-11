import { createHash, timingSafeEqual } from 'node:crypto';
import type { AiActorType } from '@mingwu/contracts';
import type { McpAuthContext } from '../../domain/mcp-auth/mcp-auth-context.js';
import {
  assertValidMcpAuthContext,
  type McpAuthenticator,
} from '../../domain/mcp-auth/mcp-authenticator.js';
import { McpAuthConfigurationError, McpAuthenticationError } from '../../domain/mcp-auth/errors.js';

/**
 * 内存 MCP 认证器（仅用于本地开发 / 自动化测试 / 第六关之前的临时演示）。
 *
 * 安全边界：
 * - 构造时立即把明文 token 转成不可逆 SHA-256 摘要并丢弃明文，之后任何可观察状态
 *   （对象字段、序列化输出、registry 调试信息）都不含明文 Token；
 * - 摘要比较使用常量时间 timingSafeEqual，避免直接字符串秘密比较；
 * - 只保存不可逆摘要与非敏感指纹（连接登记 / Actor 字段），不保存明文 Token；
 * - 支持 revoked / expiresAt 状态模拟撤销与过期，二者与无效 token 一样统一抛
 *   McpAuthenticationError，不泄露具体失败原因；
 * - 从仓库代码、默认配置或日志中不放入任何真实凭据。
 */
export interface InMemoryCredentialConfig {
  /** 稳定连接登记 UUID。 */
  connectionId: string;
  /** Actor 稳定 UUID。 */
  actorId: string;
  /** 人类可读代号（如 xiaomiao / xiaoke）。 */
  actorCode: string;
  actorType: AiActorType;
  permissionProfile: string;
  /** 明文测试凭据：仅在构造时用于计算摘要，随后立即丢弃。 */
  token: string;
  /** 可选过期时刻（ISO 字符串）；过期后认证失败。 */
  expiresAt?: string;
}

interface StoredCredential extends Omit<InMemoryCredentialConfig, 'token' | 'expiresAt'> {
  tokenHash: string;
  revoked: boolean;
  expiresAtMs: number | null;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 常量时间摘要比较：长度不同直接不匹配；长度相同用 timingSafeEqual。 */
function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export class InMemoryMcpAuthenticator implements McpAuthenticator {
  private readonly credentials: Map<string, StoredCredential> = new Map();

  constructor(configs: readonly InMemoryCredentialConfig[]) {
    for (const config of configs) {
      // 构造登记时即做防御性验证：UUID / 枚举 / 长度非法直接抛内部配置错误。
      assertValidMcpAuthContext({
        actorId: config.actorId,
        actorCode: config.actorCode,
        actorType: config.actorType,
        connectionId: config.connectionId,
        permissionProfile: config.permissionProfile,
      });
      if (config.token.length === 0) {
        throw new McpAuthenticationError();
      }
      const tokenHash = sha256Hex(config.token);
      // 重复 token 摘要必须拒绝配置：绝不允许把同一凭据静默改绑到另一
      // Actor / Connection（错误不带 token / 摘要）。
      if (this.credentials.has(tokenHash)) {
        throw new McpAuthConfigurationError();
      }
      // expiresAt 存在时必须在构造阶段验证为有限、可解析的时间：非法值若被
      // 保存为 NaN，Date.now() >= NaN 永远为 false，会变成“永不过期”。
      let expiresAtMs: number | null = null;
      if (config.expiresAt !== undefined) {
        const parsed = Date.parse(config.expiresAt);
        if (Number.isNaN(parsed)) {
          throw new McpAuthConfigurationError();
        }
        expiresAtMs = parsed;
      }
      this.credentials.set(tokenHash, {
        connectionId: config.connectionId,
        actorId: config.actorId,
        actorCode: config.actorCode,
        actorType: config.actorType,
        permissionProfile: config.permissionProfile,
        tokenHash,
        revoked: false,
        expiresAtMs,
      });
    }
  }

  async authenticate(bearerToken: string): Promise<McpAuthContext> {
    if (bearerToken.length === 0) {
      throw new McpAuthenticationError();
    }
    const tokenHash = sha256Hex(bearerToken);
    // 常量时间遍历比较，命中与否都走相同比较路径，不提前返回，避免时序侧信道。
    let matched: StoredCredential | undefined;
    for (const credential of this.credentials.values()) {
      if (safeHexEqual(credential.tokenHash, tokenHash)) {
        matched = credential;
      }
    }
    if (matched === undefined || matched.revoked) {
      throw new McpAuthenticationError();
    }
    if (
      matched.expiresAtMs !== null &&
      Date.now() >= matched.expiresAtMs
    ) {
      throw new McpAuthenticationError();
    }
    const context: McpAuthContext = {
      actorId: matched.actorId,
      actorCode: matched.actorCode,
      actorType: matched.actorType,
      connectionId: matched.connectionId,
      permissionProfile: matched.permissionProfile,
    };
    assertValidMcpAuthContext(context);
    return context;
  }

  /** 撤销某条连接的全部凭据：该 token 立即认证失败（供测试模拟撤销）。 */
  revoke(connectionId: string): void {
    for (const credential of this.credentials.values()) {
      if (credential.connectionId === connectionId) {
        credential.revoked = true;
      }
    }
  }

  /** 已登记的摘要（hex），供测试断言对象状态不含明文 Token。 */
  hashes(): string[] {
    return [...this.credentials.keys()];
  }
}
