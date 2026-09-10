/** pickDefined
 * حذف کلیدهایی که مقدارشان undefined است از یک شیء.
 * برای رعایت exactOptionalPropertyTypes در TypeScript.
 */
export function omitUndefined<T extends Record<string, unknown>>(obj: T): T {
  const result: any = {};
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val !== undefined) {
      result[key] = val;
    }
  }
  return result as T;
}

// تبدیل key=value به آبجکت
export function parseKeyValuePairs(pairs: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`expected key=value, got "${pair}"`);
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!key || !value) {
      throw new Error(`expected key=value, got "${pair}"`);
    }
    result[key] = value;
  }
  return result;
}

// Helper to parse comma-separated values
export function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function toArray(
  target: string | string[] | null | undefined,
  delimiter: string = ", ",
): string[] {
  if (Array.isArray(target)) return [...target];

  if (typeof target === "string") {
    if (target.includes(delimiter)) {
      return target
        .split(delimiter)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
    return [target];
  }

  return [];
}

export function toString(
  target: string | string[] | null | undefined,
  delimiter: string = ", ",
): string {
  if (Array.isArray(target)) return target.join(delimiter);
  if (typeof target === "string") return target;
  return "";
}
