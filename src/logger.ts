// =============================================================================
// $ANSEM Buy-Back & Airdrop Bot — Logger
// =============================================================================
// Provides structured, color-coded logging for full operational transparency.
// Every significant action is logged so the community can audit bot behavior.
// =============================================================================

/**
 * ANSI color codes for terminal output.
 * Each module gets a distinct color for easy visual scanning.
 */
const Colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
} as const;

/**
 * Log levels control verbosity.
 * DEBUG: Everything (very noisy, useful for development)
 * INFO:  Normal operations (default for production)
 * WARN:  Potential issues that don't stop execution
 * ERROR: Failures that need attention
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/**
 * Module tags — each major system component has a tag and color
 * so operators can quickly filter and identify log sources.
 */
export type LogModule = 'SYSTEM' | 'MONITOR' | 'BUYBACK' | 'AIRDROP' | 'JITO' | 'JUPITER';

const moduleColors: Record<LogModule, string> = {
  SYSTEM: Colors.white,
  MONITOR: Colors.cyan,
  BUYBACK: Colors.green,
  AIRDROP: Colors.magenta,
  JITO: Colors.yellow,
  JUPITER: Colors.blue,
};

const levelLabels: Record<LogLevel, { label: string; color: string }> = {
  [LogLevel.DEBUG]: { label: 'DEBUG', color: Colors.gray },
  [LogLevel.INFO]: { label: 'INFO ', color: Colors.green },
  [LogLevel.WARN]: { label: 'WARN ', color: Colors.yellow },
  [LogLevel.ERROR]: { label: 'ERROR', color: Colors.red },
};

/** Current minimum log level — messages below this are suppressed */
let currentLogLevel: LogLevel = LogLevel.INFO;

/**
 * Set the global log level.
 * Call this at startup based on environment configuration.
 */
export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

/**
 * Format a timestamp for log output.
 * Uses ISO 8601 format for unambiguous time representation.
 */
function getTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Core logging function.
 * Formats: [TIMESTAMP] [LEVEL] [MODULE] message
 *
 * @param level   - Severity level of the message
 * @param module  - Which system component generated this log
 * @param message - The log message
 * @param data    - Optional structured data to append
 */
function log(level: LogLevel, module: LogModule, message: string, data?: unknown): void {
  if (level < currentLogLevel) return;

  const { label, color: levelColor } = levelLabels[level];
  const moduleColor = moduleColors[module];
  const timestamp = getTimestamp();

  const formattedMessage = [
    `${Colors.gray}[${timestamp}]${Colors.reset}`,
    `${levelColor}[${label}]${Colors.reset}`,
    `${moduleColor}${Colors.bright}[${module}]${Colors.reset}`,
    message,
  ].join(' ');

  if (level >= LogLevel.ERROR) {
    console.error(formattedMessage);
  } else if (level >= LogLevel.WARN) {
    console.warn(formattedMessage);
  } else {
    console.log(formattedMessage);
  }

  // Print additional data on the next line if provided
  if (data !== undefined) {
    const dataStr = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
    console.log(`${Colors.gray}  └─ ${dataStr}${Colors.reset}`);
  }
}

/**
 * Public logging API.
 * Usage: logger.info('MONITOR', 'Detected new SOL deposit', { amount: 0.5 });
 */
export const logger = {
  debug: (module: LogModule, message: string, data?: unknown) =>
    log(LogLevel.DEBUG, module, message, data),
  info: (module: LogModule, message: string, data?: unknown) =>
    log(LogLevel.INFO, module, message, data),
  warn: (module: LogModule, message: string, data?: unknown) =>
    log(LogLevel.WARN, module, message, data),
  error: (module: LogModule, message: string, data?: unknown) =>
    log(LogLevel.ERROR, module, message, data),

  /**
   * Log a separator line — useful for visually grouping related operations
   * like the start of a buy-back cycle.
   */
  separator: (module: LogModule, title: string) => {
    const line = '═'.repeat(60);
    console.log(`\n${moduleColors[module]}${Colors.bright}${line}${Colors.reset}`);
    console.log(`${moduleColors[module]}${Colors.bright}  ${title}${Colors.reset}`);
    console.log(`${moduleColors[module]}${Colors.bright}${line}${Colors.reset}\n`);
  },
};
