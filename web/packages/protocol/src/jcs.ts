/**
 * JSON Canonicalization Scheme (RFC 8785), restricted profile.
 *
 * Numbers must be safe integers. Floating point values are rejected so that
 * every SDK language produces byte-identical output without re-implementing
 * the ECMAScript number formatter.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export class CanonicalizationError extends Error {
  override name = "CanonicalizationError";
}

export function canonicalize(value: unknown): string {
  return write(value, "$");
}

function write(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalizationError(`${path}: only safe integers are allowed (got ${value})`);
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      // ES2019 JSON.stringify is exactly the JCS string serialization.
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map((v, i) => write(v, `${path}[${i}]`)).join(",") + "]";
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalizationError(`${path}: only plain objects are allowed`);
      }
      const record = value as Record<string, unknown>;
      // Default sort compares UTF-16 code units, as RFC 8785 requires.
      const keys = Object.keys(record).sort();
      const members: string[] = [];
      for (const key of keys) {
        const v = record[key];
        if (v === undefined) throw new CanonicalizationError(`${path}.${key}: undefined is not allowed`);
        members.push(JSON.stringify(key) + ":" + write(v, `${path}.${key}`));
      }
      return "{" + members.join(",") + "}";
    }
    default:
      throw new CanonicalizationError(`${path}: unsupported type ${typeof value}`);
  }
}
