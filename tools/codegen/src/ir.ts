/**
 * JSON Schema in, a small intermediate representation out.
 *
 * `packages/protocol` is the single source of truth for message shapes, and zod 4 can emit
 * JSON Schema from it directly. Rather than emitting Swift straight from zod's internals —
 * which are private and would break on a minor upgrade — the pipeline goes
 *
 *     Zod schema  ->  JSON Schema (public zod API)  ->  this IR  ->  Swift
 *
 * The IR exists because the Swift emitter should not have to know what
 * `anyOf: [X, {type: 'null'}]` means. It also means Phase 9's Kotlin emitter starts from
 * the same normalised description rather than reinterpreting JSON Schema a second time.
 */

export type TypeRef =
  /** A `$ref` to another declared type. */
  | { readonly kind: 'named'; readonly name: string }
  | { readonly kind: 'string' }
  | { readonly kind: 'int' }
  | { readonly kind: 'double' }
  | { readonly kind: 'bool' }
  | { readonly kind: 'array'; readonly element: TypeRef }
  /** A JSON object used as a map: `Record<K, V>` in TS, `[String: V]` in Swift. */
  | { readonly kind: 'dictionary'; readonly value: TypeRef }
  /** An object declared inline in the schema; becomes a nested type in the output. */
  | { readonly kind: 'nested'; readonly name: string; readonly shape: ObjectShape };

export interface Field {
  readonly name: string;
  readonly type: TypeRef;
  /**
   * `nullable` and `optional` are different things and the distinction is load-bearing: a
   * nullable field must be written as an explicit `null`, an optional one must be left out
   * entirely. Conflating them produces messages the server's strict schemas reject.
   */
  readonly nullable: boolean;
  readonly optional: boolean;
}

export interface ObjectShape {
  readonly fields: readonly Field[];
}

export interface UnionVariant {
  /** The discriminator value, e.g. `"matchFound"`. */
  readonly tag: string;
  /** Null when the variant carries nothing beyond its discriminator. */
  readonly shape: ObjectShape | null;
}

export type Decl =
  | { readonly kind: 'intEnum'; readonly name: string; readonly values: readonly number[] }
  | { readonly kind: 'stringEnum'; readonly name: string; readonly values: readonly string[] }
  | { readonly kind: 'struct'; readonly name: string; readonly shape: ObjectShape }
  | {
      readonly kind: 'union';
      readonly name: string;
      readonly discriminator: string;
      readonly variants: readonly UnionVariant[];
    };

/** Just enough of JSON Schema to describe what the protocol actually uses. */
interface Node {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly anyOf?: readonly Node[];
  readonly oneOf?: readonly Node[];
  readonly allOf?: readonly Node[];
  readonly properties?: Readonly<Record<string, Node>>;
  readonly required?: readonly string[];
  readonly items?: Node;
  readonly additionalProperties?: Node | boolean;
  readonly propertyNames?: Node;
}

export class UnsupportedSchema extends Error {
  constructor(where: string, node: unknown) {
    super(`${where}: cannot represent ${JSON.stringify(node).slice(0, 200)}`);
    this.name = 'UnsupportedSchema';
  }
}

const isNull = (node: Node): boolean => node.type === 'null';
const branches = (node: Node): readonly Node[] | null => node.oneOf ?? node.anyOf ?? null;
const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** A `$ref` may be a bare id or a JSON pointer; we only ever need the last segment. */
const refName = (ref: string): string => ref.split('/').pop() ?? ref;

/**
 * Find the field that discriminates a union: present in every branch, a string constant in
 * each, and a different constant each time. Detected rather than configured, so a union that
 * switches from `type` to `kind` needs no change here.
 */
function findDiscriminator(variants: readonly Node[], where: string): string {
  const first = variants[0];
  if (first?.properties === undefined) throw new UnsupportedSchema(where, variants);

  const candidates = Object.keys(first.properties).filter((key) =>
    variants.every((variant) => typeof variant.properties?.[key]?.const === 'string'),
  );
  const usable = candidates.filter((key) => {
    const seen = new Set(variants.map((variant) => String(variant.properties?.[key]?.const)));
    return seen.size === variants.length;
  });
  // Prefer the conventional names so the choice is stable if a shape ever gains a second
  // constant string field.
  const preferred = ['type', 'kind'].find((key) => usable.includes(key));
  const chosen = preferred ?? usable[0];
  if (chosen === undefined) throw new UnsupportedSchema(`${where}: no discriminator`, variants);
  return chosen;
}

/**
 * The string values a node can take, or null if it is not a closed set of strings.
 *
 * Recursive, because a union of two string enums (`ErrorCode` is the rules codes plus the
 * transport codes) nests one level: `anyOf: [{enum: [...]}, {enum: [...]}]`. Flattening it
 * gives Swift one enum to switch over rather than a union of unions.
 */
function stringEnumValues(node: Node): readonly string[] | null {
  if (typeof node.const === 'string') return [node.const];
  if (node.enum !== undefined) {
    const strings = node.enum.filter((value): value is string => typeof value === 'string');
    return strings.length === node.enum.length ? strings : null;
  }
  const options = branches(node);
  if (options === null) return null;

  const collected: string[] = [];
  for (const option of options) {
    const values = stringEnumValues(option);
    if (values === null) return null;
    for (const value of values) if (!collected.includes(value)) collected.push(value);
  }
  return collected.length === 0 ? null : collected;
}

const intEnumValues = (node: Node): readonly number[] | null => {
  const options = branches(node);
  if (options === null) return null;
  const numeric = options.every(
    (option) =>
      (option.type === 'number' || option.type === 'integer') && typeof option.const === 'number',
  );
  if (!numeric) return null;
  return options.map((option) => Number(option.const));
};

/** A named declaration from one registered schema. */
export function declarationFrom(name: string, schema: unknown): Decl {
  const node = schema as Node;

  const ints = intEnumValues(node);
  if (ints !== null) return { kind: 'intEnum', name, values: ints };

  const strings = stringEnumValues(node);
  if (strings !== null) return { kind: 'stringEnum', name, values: strings };

  const options = branches(node);
  if (options !== null) {
    const objects = options.filter((option) => !isNull(option));
    const discriminator = findDiscriminator(objects, name);
    return {
      kind: 'union',
      name,
      discriminator,
      variants: objects.map((option) => {
        const tag = String(option.properties?.[discriminator]?.const);
        const shape = objectShape(option, name, [discriminator]);
        return { tag, shape: shape.fields.length === 0 ? null : shape };
      }),
    };
  }

  if (node.type === 'object' && node.properties !== undefined) {
    return { kind: 'struct', name, shape: objectShape(node, name, []) };
  }

  throw new UnsupportedSchema(name, node);
}

function objectShape(node: Node, owner: string, skip: readonly string[]): ObjectShape {
  const properties = node.properties ?? {};
  const required = new Set(node.required ?? []);
  const fields: Field[] = [];

  for (const [name, property] of Object.entries(properties)) {
    if (skip.includes(name)) continue;
    const unwrapped = unwrapNullable(property);
    fields.push({
      name,
      type: typeRef(unwrapped.node, `${owner}.${name}`, capitalise(name)),
      nullable: unwrapped.nullable,
      optional: !required.has(name),
    });
  }
  return { fields };
}

/**
 * Strip `.nullable()`, which zod spells two different ways: `anyOf: [T, {type: 'null'}]` when
 * the inner schema has constraints of its own, and the shorthand `type: ['string', 'null']`
 * when it does not.
 */
function unwrapNullable(node: Node): { node: Node; nullable: boolean } {
  const declared = node.type;
  // `typeof !== 'string'` rather than `Array.isArray`, which widens a readonly array to any[].
  if (declared !== undefined && typeof declared !== 'string' && declared.includes('null')) {
    const remaining = declared.filter((name) => name !== 'null');
    const only = remaining[0];
    if (remaining.length === 1 && only !== undefined) {
      return { node: { ...node, type: only }, nullable: true };
    }
  }

  const options = branches(node);
  if (options?.length !== 2) return { node, nullable: false };
  const nulls = options.filter(isNull);
  const others = options.filter((option) => !isNull(option));
  const single = others[0];
  if (nulls.length !== 1 || single === undefined) return { node, nullable: false };
  return { node: single, nullable: true };
}

function typeRef(node: Node, where: string, suggestedName: string): TypeRef {
  if (node.$ref !== undefined) return { kind: 'named', name: refName(node.$ref) };

  if (node.type === 'array') {
    if (node.items === undefined) throw new UnsupportedSchema(where, node);
    const element = unwrapNullable(node.items);
    if (element.nullable) throw new UnsupportedSchema(`${where}: nullable array element`, node);
    return { kind: 'array', element: typeRef(element.node, where, `${suggestedName}Element`) };
  }

  if (node.type === 'object') {
    // A map: no declared properties, but a schema for the values. `Record<K, V>` in the
    // protocol, `[String: V]` in Swift. Keys are strings in JSON either way, so the key
    // schema is only a validation concern and does not survive into the generated type.
    if (node.properties === undefined && typeof node.additionalProperties === 'object') {
      const value = unwrapNullable(node.additionalProperties);
      return { kind: 'dictionary', value: typeRef(value.node, where, `${suggestedName}Value`) };
    }
    if (node.properties !== undefined) {
      return { kind: 'nested', name: suggestedName, shape: objectShape(node, where, []) };
    }
  }

  if (node.type === 'string') return { kind: 'string' };
  if (node.type === 'integer') return { kind: 'int' };
  if (node.type === 'number') return { kind: 'double' };
  if (node.type === 'boolean') return { kind: 'bool' };

  const strings = stringEnumValues(node);
  // A one-value string enum is a `z.literal` used as data rather than as a discriminator
  // (`matchAbandoned.reason`). It carries no information a client can act on, so it stays a
  // plain string rather than becoming a single-case enum.
  if (strings !== null) return { kind: 'string' };

  throw new UnsupportedSchema(where, node);
}
