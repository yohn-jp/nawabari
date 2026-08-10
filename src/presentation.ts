import { DomainError, type JsonObject, type JsonValue } from "./domain/errors.js";

export type CliMode = "human" | "json";

export type CliIO = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

export function defaultCliIO(): CliIO {
  return {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  };
}

function jsonSuccess(command: string, payload: JsonObject): string {
  return JSON.stringify({ ok: true, command, ...payload });
}

function jsonFailure(command: string, error: DomainError): string {
  const response: JsonObject = {
    ok: false,
    command,
    code: error.code,
    message: error.message,
  };
  if (error.details !== null) response.details = error.details;
  return JSON.stringify(response);
}

function formatValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function humanSuccess(command: string, payload: JsonObject): string {
  if (Object.keys(payload).length === 0) return `${command}: ok`;

  const lines = [`${command}: ok`];
  for (const [key, value] of Object.entries(payload)) {
    if (key === "checks" && Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "object" && item !== null && !Array.isArray(item) && "name" in item && "status" in item) {
          const name = item.name;
          const status = item.status;
          if (typeof name === "string" && typeof status === "string") lines.push(`  ${name}: ${status}`);
        }
      }
      continue;
    }
    lines.push(`  ${key}: ${formatValue(value)}`);
  }
  return lines.join("\n");
}

function humanFailure(command: string, error: DomainError): string {
  const lines = [`${command}: rejected`, `  code: ${error.code}`, `  message: ${error.message}`];
  if (error.details !== null) lines.push(`  details: ${JSON.stringify(error.details)}`);
  return lines.join("\n");
}

export function renderSuccess(mode: CliMode, command: string, payload: JsonObject): string {
  return mode === "json" ? jsonSuccess(command, payload) : humanSuccess(command, payload);
}

export function renderFailure(mode: CliMode, command: string, error: DomainError): string {
  return mode === "json" ? jsonFailure(command, error) : humanFailure(command, error);
}
