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
  if (error.details !== null) {
    if (typeof error.details.allowed === "boolean") response.allowed = error.details.allowed;
    response.details = error.details;
  }
  return JSON.stringify(response);
}

type JsonPrimitive = null | boolean | number | string;

const INDENT = "  ";

function isPrimitive(value: JsonValue): value is JsonPrimitive {
  return value === null || typeof value !== "object";
}

function formatPrimitive(value: JsonPrimitive): string {
  if (value === null) return "null";
  return String(value);
}

function inlineValue(value: JsonValue): string | null {
  if (isPrimitive(value)) return formatPrimitive(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every(isPrimitive)) return `[${value.map(formatPrimitive).join(", ")}]`;
    return null;
  }
  return Object.keys(value).length === 0 ? "{}" : null;
}

function formatListItem(value: JsonValue, indent: string): string[] {
  const inline = inlineValue(value);
  if (inline !== null) return [`${indent}- ${inline}`];

  const nested = formatValue(value, `${indent}${INDENT}`);
  if (Array.isArray(value)) return [`${indent}-`, ...nested];

  const itemIndent = `${indent}${INDENT}`;
  return [`${indent}- ${nested[0].slice(itemIndent.length)}`, ...nested.slice(1)];
}

function formatValue(value: JsonValue, indent = ""): string[] {
  const inline = inlineValue(value);
  if (inline !== null) return [`${indent}${inline}`];

  if (isPrimitive(value)) return [`${indent}${formatPrimitive(value)}`];
  if (Array.isArray(value)) return value.flatMap((item) => formatListItem(item, indent));

  return Object.entries(value).flatMap(([key, child]) => formatField(key, child, indent));
}

function formatField(key: string, value: JsonValue, indent: string): string[] {
  const inline = inlineValue(value);
  if (inline !== null) return [`${indent}${key}: ${inline}`];
  return [`${indent}${key}:`, ...formatValue(value, `${indent}${INDENT}`)];
}

function humanSuccess(command: string, payload: JsonObject): string {
  if (Object.keys(payload).length === 0) return `${command}: ok`;

  const lines = [`${command}: ok`];
  for (const [key, value] of Object.entries(payload)) lines.push(...formatField(key, value, INDENT));
  return lines.join("\n");
}

function humanFailure(command: string, error: DomainError): string {
  const lines = [`${command}: rejected`, `  code: ${error.code}`, `  message: ${error.message}`];
  if (error.details !== null) lines.push(...formatField("details", error.details, INDENT));
  return lines.join("\n");
}

export function renderSuccess(mode: CliMode, command: string, payload: JsonObject): string {
  return mode === "json" ? jsonSuccess(command, payload) : humanSuccess(command, payload);
}

export function renderFailure(mode: CliMode, command: string, error: DomainError): string {
  return mode === "json" ? jsonFailure(command, error) : humanFailure(command, error);
}
