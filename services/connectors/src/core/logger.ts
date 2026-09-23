/**
 * Structured JSON logs. Cloud Logging parses `severity` and `message`, so
 * these become filterable fields without extra setup.
 */
type Fields = Record<string, unknown>;

function emit(severity: string, message: string, base: Fields, fields?: Fields) {
  const line = JSON.stringify({ severity, message, ...base, ...fields, time: new Date().toISOString() });
  if (severity === "ERROR") console.error(line);
  else console.log(line);
}

export interface Logger {
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

function make(base: Fields): Logger {
  return {
    info: (m, f) => emit("INFO", m, base, f),
    warn: (m, f) => emit("WARNING", m, base, f),
    error: (m, f) => emit("ERROR", m, base, f),
    child: (f) => make({ ...base, ...f }),
  };
}

export const logger = make({});
