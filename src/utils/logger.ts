import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function parseLevel(value: string | undefined): LogLevel {
  switch ((value ?? 'info').toLowerCase()) {
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
    case 'silent':
      return (value ?? 'info').toLowerCase() as LogLevel;
    default:
      return 'info';
  }
}

let currentLevel: LogLevel = parseLevel(process.env.STUDIO_LOG_LEVEL);

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function enabled(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[currentLevel];
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    if (enabled('debug')) {
      console.debug(chalk.gray('[debug]'), message, ...args);
    }
  },
  info(message: string, ...args: unknown[]): void {
    if (enabled('info')) {
      console.info(chalk.cyan('[info]'), message, ...args);
    }
  },
  warn(message: string, ...args: unknown[]): void {
    if (enabled('warn')) {
      console.warn(chalk.yellow('[warn]'), message, ...args);
    }
  },
  error(message: string, ...args: unknown[]): void {
    if (enabled('error')) {
      console.error(chalk.red('[error]'), message, ...args);
    }
  },
};
