import { createRequire } from "node:module";

type PackageMetadata = {
  engines?: {
    node?: unknown;
  };
};

type NodeVersion = {
  major: number;
  minor: number;
  patch: number;
};

const packageMetadata = createRequire(import.meta.url)("../../package.json") as PackageMetadata;
const nodeEngine = readNodeEngine(packageMetadata);
const minimumNodeVersion = parseNodeEngine(nodeEngine);

/** The package manifest is the sole authority for the supported Node.js baseline. */
export const NODE_RUNTIME_POLICY = Object.freeze({
  engine: nodeEngine,
  minimum: Object.freeze(minimumNodeVersion),
});

export function supportsRuntime(version: string): boolean {
  const parsedVersion = parseNodeVersion(version);
  if (parsedVersion === null) return false;
  return compareVersions(parsedVersion, minimumNodeVersion) >= 0;
}

function readNodeEngine(metadata: PackageMetadata): string {
  if (typeof metadata.engines?.node !== "string") {
    throw new Error("package.json must define engines.node as a string");
  }
  return metadata.engines.node;
}

function parseNodeEngine(engine: string): NodeVersion {
  const match = engine.match(/^>=(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u);
  if (match === null) {
    throw new Error(`package.json engines.node must be a lower-bound-only range, got ${engine}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  };
}

function parseNodeVersion(version: string): NodeVersion | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/u);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left: NodeVersion, right: NodeVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}
