type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";

function stringify(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function line(level: Level, message: string, meta?: unknown): void {
  const suffix = meta === undefined ? "" : ` ${stringify(meta)}`;
  console.log(`${new Date().toISOString()} [${level}] ${message}${suffix}`);
}

export const log = {
  info: (message: string, meta?: unknown) => line("INFO", message, meta),
  warn: (message: string, meta?: unknown) => line("WARN", message, meta),
  error: (message: string, meta?: unknown) => line("ERROR", message, meta),
  debug: (message: string, meta?: unknown) => line("DEBUG", message, meta),
};
