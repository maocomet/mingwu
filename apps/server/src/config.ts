export interface AppConfig {
  host: string;
  port: number;
  nodeEnv: string;
  serviceVersion: string;
  serviceName: string;
  /**
   * MCP `/mcp` 入口允许的 Host / Origin 主机名白名单（防 DNS rebinding）。
   * 只允许非敏感主机；当前默认仅覆盖本地测试主机。
   * 正式域名（如 mingwu.maomao.im）留待未来认证批次启用，未认证阶段不作为默认白名单。
   * 缺少 Origin 头允许，出现但主机名不在白名单内的 Origin/Host 一律拒绝。
   */
  mcpAllowedHosts: string[];
}

// 未认证阶段只放行本地主机。公网域名必须等 AuthContext/OAuth 接入后再由小喵确认启用。
const DEFAULT_MCP_ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '::1'];

function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) {
    return DEFAULT_MCP_ALLOWED_HOSTS;
  }
  const hosts = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (hosts.length === 0) {
    throw new Error('MCP_ALLOWED_HOSTS must contain at least one non-empty host');
  }
  return hosts;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawPort = env.PORT ?? '8790';
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${rawPort}`);
  }
  return {
    host: env.HOST ?? '127.0.0.1',
    port,
    nodeEnv: env.NODE_ENV ?? 'development',
    serviceVersion: env.SERVICE_VERSION ?? '0.1.0',
    serviceName: env.SERVICE_NAME ?? 'mingwu-server',
    mcpAllowedHosts: parseAllowedHosts(env.MCP_ALLOWED_HOSTS),
  };
}
