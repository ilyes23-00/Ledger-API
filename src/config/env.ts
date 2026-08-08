type NodeEnvironment = 'development' | 'test' | 'production';

export type AppEnvironment = {
  nodeEnv: NodeEnvironment;
  server: {
    host: string;
    port: number;
    connectionTimeoutMs: number;
    requestTimeoutMs: number;
    handlerTimeoutMs: number;
  };
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    poolMax: number;
    poolMin: number;
    idleTimeoutMs: number;
    connectionTimeoutMs: number;
    statementTimeoutMs: number;
    lockTimeoutMs: number;
    idleInTransactionSessionTimeoutMs: number;
  };
};

const NODE_ENVIRONMENTS = new Set<NodeEnvironment>([
  'development',
  'test',
  'production',
]);

export class EnvironmentValidationError extends Error {
  public readonly issues: string[];

  public constructor(issues: string[]) {
    super(
      `Invalid environment configuration:\n${issues
        .map((issue) => `- ${issue}`)
        .join('\n')}`,
    );
    this.name = 'EnvironmentValidationError';
    this.issues = issues;
  }
}

export const loadEnvironment = (
  source: NodeJS.ProcessEnv = process.env,
): AppEnvironment => {
  const issues: string[] = [];

  const nodeEnvValue = source['NODE_ENV'] ?? 'development';
  const nodeEnv = validateNodeEnvironment(nodeEnvValue, issues);

  const appHost = readRequiredString(
    source['APP_HOST'] ?? '0.0.0.0',
    'APP_HOST',
    issues,
  );
  const appPort = readInteger(
    source['APP_PORT'] ?? '3000',
    'APP_PORT',
    issues,
    {
      min: 1,
      max: 65_535,
    },
  );
  const requestTimeoutMs = readInteger(
    source['APP_REQUEST_TIMEOUT_MS'] ?? '10000',
    'APP_REQUEST_TIMEOUT_MS',
    issues,
    {
      min: 1_000,
      max: 120_000,
    },
  );
  const appConnectionTimeoutMs = readInteger(
    source['APP_CONNECTION_TIMEOUT_MS'] ?? '5000',
    'APP_CONNECTION_TIMEOUT_MS',
    issues,
    {
      min: 1_000,
      max: 120_000,
    },
  );
  const handlerTimeoutMs = readInteger(
    source['APP_HANDLER_TIMEOUT_MS'] ?? '15000',
    'APP_HANDLER_TIMEOUT_MS',
    issues,
    {
      min: 1_000,
      max: 120_000,
    },
  );

  const databaseHost = readRequiredString(
    source['DATABASE_HOST'],
    'DATABASE_HOST',
    issues,
  );
  const databasePort = readInteger(
    source['DATABASE_PORT'] ?? '5432',
    'DATABASE_PORT',
    issues,
    {
      min: 1,
      max: 65_535,
    },
  );
  const databaseName = readRequiredString(
    source['DATABASE_NAME'],
    'DATABASE_NAME',
    issues,
  );
  const databaseUser = readRequiredString(
    source['DATABASE_USER'],
    'DATABASE_USER',
    issues,
  );
  const databasePassword = readRequiredString(
    source['DATABASE_PASSWORD'],
    'DATABASE_PASSWORD',
    issues,
  );
  const poolMax = readInteger(
    source['DATABASE_POOL_MAX'] ?? '10',
    'DATABASE_POOL_MAX',
    issues,
    {
      min: 1,
      max: 100,
    },
  );
  const poolMin = readInteger(
    source['DATABASE_POOL_MIN'] ?? '0',
    'DATABASE_POOL_MIN',
    issues,
    {
      min: 0,
      max: 100,
    },
  );
  const idleTimeoutMs = readInteger(
    source['DATABASE_POOL_IDLE_TIMEOUT_MS'] ?? '30000',
    'DATABASE_POOL_IDLE_TIMEOUT_MS',
    issues,
    {
      min: 1_000,
      max: 300_000,
    },
  );
  const poolConnectionTimeoutMs = readInteger(
    source['DATABASE_POOL_CONNECTION_TIMEOUT_MS'] ?? '5000',
    'DATABASE_POOL_CONNECTION_TIMEOUT_MS',
    issues,
    {
      min: 500,
      max: 60_000,
    },
  );
  const statementTimeoutMs = readInteger(
    source['DATABASE_STATEMENT_TIMEOUT_MS'] ?? '15000',
    'DATABASE_STATEMENT_TIMEOUT_MS',
    issues,
    {
      min: 500,
      max: 120_000,
    },
  );
  const lockTimeoutMs = readInteger(
    source['DATABASE_LOCK_TIMEOUT_MS'] ?? '5000',
    'DATABASE_LOCK_TIMEOUT_MS',
    issues,
    {
      min: 500,
      max: 120_000,
    },
  );
  const idleInTransactionSessionTimeoutMs = readInteger(
    source['DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS'] ?? '10000',
    'DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS',
    issues,
    {
      min: 500,
      max: 120_000,
    },
  );

  if (poolMin > poolMax) {
    issues.push(
      'DATABASE_POOL_MIN must be less than or equal to DATABASE_POOL_MAX',
    );
  }

  if (lockTimeoutMs >= statementTimeoutMs) {
    issues.push(
      'DATABASE_LOCK_TIMEOUT_MS must be less than DATABASE_STATEMENT_TIMEOUT_MS',
    );
  }

  if (issues.length > 0) {
    throw new EnvironmentValidationError(issues);
  }

  return {
    nodeEnv,
    server: {
      host: appHost,
      port: appPort,
      connectionTimeoutMs: appConnectionTimeoutMs,
      requestTimeoutMs,
      handlerTimeoutMs,
    },
    database: {
      host: databaseHost,
      port: databasePort,
      name: databaseName,
      user: databaseUser,
      password: databasePassword,
      poolMax,
      poolMin,
      idleTimeoutMs,
      connectionTimeoutMs: poolConnectionTimeoutMs,
      statementTimeoutMs,
      lockTimeoutMs,
      idleInTransactionSessionTimeoutMs,
    },
  };
};

const validateNodeEnvironment = (
  value: string,
  issues: string[],
): NodeEnvironment => {
  if (NODE_ENVIRONMENTS.has(value as NodeEnvironment)) {
    return value as NodeEnvironment;
  }

  issues.push(
    `NODE_ENV must be one of: ${Array.from(NODE_ENVIRONMENTS).join(', ')}`,
  );

  return 'development';
};

const readRequiredString = (
  value: string | undefined,
  key: string,
  issues: string[],
): string => {
  if (value === undefined || value.trim() === '') {
    issues.push(`${key} is required`);
    return '';
  }

  return value.trim();
};

const readInteger = (
  value: string,
  key: string,
  issues: string[],
  bounds: {
    min: number;
    max: number;
  },
): number => {
  if (!/^\d+$/.test(value)) {
    issues.push(`${key} must be an integer`);
    return bounds.min;
  }

  const parsedValue = Number.parseInt(value, 10);

  if (parsedValue < bounds.min || parsedValue > bounds.max) {
    issues.push(`${key} must be between ${bounds.min} and ${bounds.max}`);
  }

  return parsedValue;
};
