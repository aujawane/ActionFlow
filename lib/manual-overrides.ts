export function mergeManualOverrideFields(
  current: unknown,
  fields: string[]
) {
  const values = Array.isArray(current)
    ? current.filter((value): value is string => typeof value === "string")
    : [];
  return Array.from(new Set([...values, ...fields]));
}
