export interface AppConfig {
  host: string;
  port: number;
  nodeEnv: string;
  serviceVersion: string;
  serviceName: string;
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
  };
}
