// A validator for the part of JSON Schema the UniFi spec uses: type, enum, ranges and lengths, uuid format, required, items, properties
// (unknown fields are rejected), additionalProperties, allOf, oneOf, and discriminator (the spec's way of saying "one of these shapes"). It
// exists so a dry run catches a missing field, a wrong type or a bad value before the gateway answers with a bare 400.
// Unknown fields are only a warning: the gateway is often newer than the spec and returns (and accepts) fields the spec lacks, so
// rejecting them would block good calls. A misspelt required field still fails, as the right name is then missing.

type Schema = Record<string, unknown>;
export type Resolve = (ref: string) => unknown;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROBLEMS = 10;

export interface Findings { errors: string[]; warnings: string[] }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const TYPES: Record<string, (value: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number',
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: isObject,
};

// One schema from allOf and, for a discriminated schema, the variant the value names. A variant lists its base in its own allOf, so
// the base is flattened without following its discriminator again.
function flatten(schema: Schema, value: unknown, resolve: Resolve, follow = true): Schema {
  const { allOf, ...own } = schema;
  let merged: Schema = own;
  for (const member of (allOf as Schema[] | undefined) ?? []) merged = combine(merged, flatten(member, value, resolve, false));
  const discriminator = merged.discriminator as { propertyName: string; mapping: Record<string, string> } | undefined;
  if (follow && discriminator !== undefined && isObject(value)) {
    const target = discriminator.mapping[String(value[discriminator.propertyName])];
    if (target !== undefined) merged = combine(merged, flatten(resolve(target) as Schema, value, resolve, false));
  }
  return merged;
}

const combine = (a: Schema, b: Schema): Schema => ({
  ...b,
  ...a,
  properties: { ...(b.properties as Schema | undefined), ...(a.properties as Schema | undefined) },
  required: [...new Set([...((a.required as string[] | undefined) ?? []), ...((b.required as string[] | undefined) ?? [])])],
});

export function validate(schema: unknown, value: unknown, resolve: Resolve, path = 'body'): Findings {
  const found: Findings = { errors: [], warnings: [] };
  check(schema as Schema, value, resolve, path, found);
  return { errors: found.errors.slice(0, MAX_PROBLEMS), warnings: found.warnings.slice(0, MAX_PROBLEMS) };
}

function check(raw: Schema, value: unknown, resolve: Resolve, path: string, found: Findings): void {
  // oneOf with no discriminator: the value must fit one alternative; report the one it fits, or fits best.
  if (Array.isArray(raw.oneOf) && raw.discriminator === undefined) {
    const tries = (raw.oneOf as Schema[]).map((alternative) => {
      const attempt: Findings = { errors: [], warnings: [] };
      check(alternative, value, resolve, path, attempt);
      return attempt;
    });
    const best = tries.find((attempt) => attempt.errors.length === 0) ?? tries.reduce((a, b) => (b.errors.length < a.errors.length ? b : a));
    found.errors.push(...best.errors);
    found.warnings.push(...best.warnings);
    return;
  }
  const schema = flatten(raw, value, resolve);
  const type = schema.type as string | undefined;
  if (type !== undefined && !TYPES[type]!(value)) {
    found.errors.push(`${path} must be ${type === 'array' || type === 'object' ? 'an' : 'a'} ${type}`);
    return;
  }
  const enumerated = schema.enum as unknown[] | undefined;
  if (enumerated !== undefined && !enumerated.includes(value)) found.errors.push(`${path} must be one of ${enumerated.map(String).join(', ')}`);
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) found.errors.push(`${path} must be at least ${String(schema.minLength)} characters`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) found.errors.push(`${path} must be at most ${String(schema.maxLength)} characters`);
    if (schema.format === 'uuid' && !UUID.test(value)) found.errors.push(`${path} must be a UUID`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) found.errors.push(`${path} must be at least ${String(schema.minimum)}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) found.errors.push(`${path} must be at most ${String(schema.maximum)}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) found.errors.push(`${path} needs at least ${String(schema.minItems)} item(s)`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) found.errors.push(`${path} allows at most ${String(schema.maxItems)} item(s)`);
    if (isObject(schema.items)) value.forEach((item, index) => check(schema.items as Schema, item, resolve, `${path}[${String(index)}]`, found));
  }
  if (isObject(value)) checkObject(schema, value, resolve, path, found);
}

function checkObject(schema: Schema, value: Record<string, unknown>, resolve: Resolve, path: string, found: Findings): void {
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const required = (schema.required ?? []) as string[];
  for (const key of required) if (!(key in value)) found.errors.push(`${path}.${key} is required`);
  const discriminator = schema.discriminator as { propertyName: string; mapping: Record<string, string> } | undefined;
  if (discriminator !== undefined && discriminator.propertyName in value && !(String(value[discriminator.propertyName]) in discriminator.mapping)) {
    found.errors.push(`${path}.${discriminator.propertyName} must be one of ${Object.keys(discriminator.mapping).join(', ')}`);
  }
  const extra = schema.additionalProperties;
  for (const [key, item] of Object.entries(value)) {
    if (key in properties) {
      // The spec says "if null, match all" in places without declaring null, so null is accepted for an optional field.
      if (item !== null || required.includes(key)) check(properties[key]!, item, resolve, `${path}.${key}`, found);
    } else if (isObject(extra)) {
      check(extra, item, resolve, `${path}.${key}`, found);
    } else if (extra !== true && Object.keys(properties).length > 0) {
      found.warnings.push(`${path}.${key} is not a known field (known: ${Object.keys(properties).join(', ')})`);
    }
  }
}
