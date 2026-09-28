/**
 * IR in, Swift out.
 *
 * The output is deliberately plain: value types, `Codable` for the wire, `Hashable` so views
 * can diff them, and `Sendable` so they can cross an actor boundary under Swift 6 strict
 * concurrency without a warning. Structs of value types get all three synthesised for free.
 *
 * Two places need hand-written coding logic, both for reasons the compiler cannot guess:
 *
 *   Discriminated unions become Swift enums with associated values, which is the idiomatic
 *   shape and the whole reason to generate rather than hand-write. Swift will not synthesise
 *   a decoder that switches on a `type` field, so the emitter writes one.
 *
 *   Nullable fields must encode as an explicit `null`. Swift's synthesised encoder uses
 *   `encodeIfPresent` for optionals, which omits the key instead — and the server's schemas
 *   are strict, so an omitted key is a rejected message. Any struct with a nullable field
 *   therefore gets an explicit `encode(to:)`.
 */
import type { Decl, Field, ObjectShape, TypeRef } from './ir.ts';

const INDENT = '    ';

/** Swift keywords that would need escaping if the protocol ever used one as a name. */
const RESERVED = new Set([
  'associatedtype',
  'class',
  'deinit',
  'enum',
  'extension',
  'fileprivate',
  'func',
  'import',
  'init',
  'inout',
  'internal',
  'let',
  'open',
  'operator',
  'private',
  'protocol',
  'public',
  'rethrows',
  'static',
  'struct',
  'subscript',
  'typealias',
  'var',
  'break',
  'case',
  'catch',
  'continue',
  'default',
  'defer',
  'do',
  'else',
  'fallthrough',
  'for',
  'guard',
  'if',
  'in',
  'repeat',
  'return',
  'throw',
  'switch',
  'where',
  'while',
  'as',
  'is',
  'super',
  'self',
  'Self',
  'throws',
  'true',
  'false',
  'nil',
  'Any',
  'Protocol',
  'Type',
  'try',
  'await',
  'actor',
]);

/**
 * Type names a nested struct must not take. A payload struct is declared *inside* its union,
 * so an unqualified reference to `Bid` from within `ClientMessage` would resolve to
 * `ClientMessage.Bid` rather than the top-level `Bid` — which made `ClientMessage` an
 * infinitely sized type the first time this generator ran. Shadowing `Error` is the same
 * landmine waiting for the first person to write `catch` in that scope.
 */
const STDLIB_TYPE_NAMES = [
  'Error',
  'String',
  'Int',
  'Double',
  'Float',
  'Bool',
  'Array',
  'Dictionary',
  'Set',
  'Optional',
  'Result',
  'Data',
  'Date',
  'Task',
  'Character',
  'Never',
  'Sequence',
  'Collection',
  'Codable',
  'Encoder',
  'Decoder',
  'Encodable',
  'Decodable',
  'Hashable',
  'Equatable',
  'Sendable',
  'Identifiable',
  'Comparable',
  'URL',
  'UUID',
];

/** Names in scope that a generated nested type would collide with. */
interface Names {
  readonly reserved: ReadonlySet<string>;
}

/** `Bid` inside `ClientMessage` becomes `BidPayload`; anything unambiguous keeps its name. */
const nestedName = (candidate: string, names: Names): string =>
  names.reserved.has(candidate) ? `${candidate}Payload` : candidate;

const escape = (name: string): string => (RESERVED.has(name) ? `\`${name}\`` : name);
const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** `MATCH_ENDED` and `all-humans` alike become `matchEnded` / `allHumans`. */
function camelCase(raw: string): string {
  const parts = raw.split(/[^A-Za-z0-9]+/).filter((part) => part !== '');
  const words = parts.flatMap((part) =>
    // Split ALLCAPS runs only when the whole token is uppercase, so `matchFound` survives.
    part === part.toUpperCase() ? [part.toLowerCase()] : [part],
  );
  const [first, ...rest] = words;
  if (first === undefined) return raw;
  return first.charAt(0).toLowerCase() + first.slice(1) + rest.map(capitalise).join('');
}

const lines = (...parts: (string | readonly string[])[]): string[] => parts.flat();
const indent = (body: readonly string[], depth = 1): string[] =>
  body.map((line) => (line === '' ? '' : INDENT.repeat(depth) + line));

function swiftType(ref: TypeRef, owner: string, names: Names): string {
  switch (ref.kind) {
    case 'named':
      return ref.name;
    case 'string':
      return 'String';
    case 'int':
      return 'Int';
    case 'double':
      return 'Double';
    case 'bool':
      return 'Bool';
    case 'array':
      return `[${swiftType(ref.element, owner, names)}]`;
    case 'dictionary':
      return `[String: ${swiftType(ref.value, owner, names)}]`;
    case 'nested':
      return `${owner}.${nestedName(ref.name, names)}`;
    default: {
      const unreachable: never = ref;
      return unreachable;
    }
  }
}

const fieldType = (field: Field, owner: string, names: Names): string =>
  `${swiftType(field.type, owner, names)}${field.nullable || field.optional ? '?' : ''}`;

/** Nested inline objects, emitted as types inside their owner. */
function nestedDecls(shape: ObjectShape, owner: string, names: Names): string[] {
  const out: string[] = [];
  for (const field of shape.fields) {
    for (const ref of collectNested(field.type)) {
      const name = nestedName(ref.name, names);
      out.push(...structBody(name, ref.shape, `${owner}.${name}`, names), '');
    }
  }
  return out;
}

function collectNested(ref: TypeRef): { name: string; shape: ObjectShape }[] {
  switch (ref.kind) {
    case 'nested':
      return [{ name: ref.name, shape: ref.shape }];
    case 'array':
      return collectNested(ref.element);
    case 'dictionary':
      return collectNested(ref.value);
    case 'named':
    case 'string':
    case 'int':
    case 'double':
    case 'bool':
      return [];
    default: {
      const unreachable: never = ref;
      return unreachable;
    }
  }
}

const CONFORMANCES = 'Codable, Hashable, Sendable';

function codingKeys(shape: ObjectShape): string[] {
  return lines(
    'private enum CodingKeys: String, CodingKey {',
    indent(shape.fields.map((field) => `case ${escape(camelCase(field.name))} = "${field.name}"`)),
    '}',
  );
}

/**
 * Explicit coding, emitted only when a struct has a nullable field. `decodeIfPresent` accepts
 * both an explicit null and an absent key, which is the lenient half; `encode` writes the
 * explicit null the server requires, which is the strict half.
 */
function explicitCoding(shape: ObjectShape, owner: string, names: Names): string[] {
  const decode = shape.fields.map((field) => {
    const name = escape(camelCase(field.name));
    const type = swiftType(field.type, owner, names);
    if (field.nullable || field.optional) {
      return `${name} = try container.decodeIfPresent(${type}.self, forKey: .${name})`;
    }
    return `${name} = try container.decode(${type}.self, forKey: .${name})`;
  });

  const encode = shape.fields.map((field) => {
    const name = escape(camelCase(field.name));
    // Optional means "may be absent"; nullable means "present, possibly null".
    const call = field.optional && !field.nullable ? 'encodeIfPresent' : 'encode';
    return `try container.${call}(${name}, forKey: .${name})`;
  });

  return lines(
    '',
    codingKeys(shape),
    '',
    'init(from decoder: any Decoder) throws {',
    indent(lines('let container = try decoder.container(keyedBy: CodingKeys.self)', decode)),
    '}',
    '',
    'func encode(to encoder: any Encoder) throws {',
    indent(lines('var container = encoder.container(keyedBy: CodingKeys.self)', encode)),
    '}',
  );
}

/**
 * A memberwise initialiser, always — not only when Swift would decline to synthesise one.
 *
 * Swift drops the synthesised memberwise init as soon as a struct declares any initialiser of
 * its own, so the structs that need explicit `Codable` coding would otherwise be constructible
 * only by decoding JSON. Tests and previews need to build these values directly, and a generated
 * API that varies depending on whether a field happens to be nullable is a trap.
 *
 * No default values: adding a field to the protocol then becomes a compile error at every
 * construction site, rather than a silent nil.
 */
function memberwiseInit(shape: ObjectShape, owner: string, names: Names): string[] {
  const parameters = shape.fields
    .map((field) => `${escape(camelCase(field.name))}: ${fieldType(field, owner, names)}`)
    .join(', ');
  const assignments = shape.fields.map((field) => {
    const name = escape(camelCase(field.name));
    return `self.${name} = ${name}`;
  });
  return lines('', `init(${parameters}) {`, indent(assignments), '}');
}

function structBody(name: string, shape: ObjectShape, owner: string, names: Names): string[] {
  const needsExplicit = shape.fields.some((field) => field.nullable);
  const properties = shape.fields.map(
    (field) => `let ${escape(camelCase(field.name))}: ${fieldType(field, owner, names)}`,
  );
  const body = lines(
    nestedDecls(shape, owner, names),
    properties,
    shape.fields.length === 0 ? [] : memberwiseInit(shape, owner, names),
    needsExplicit ? explicitCoding(shape, owner, names) : [],
  );
  return lines(`struct ${name}: ${CONFORMANCES} {`, indent(body), '}');
}

function emitStruct(decl: Extract<Decl, { kind: 'struct' }>, names: Names): string[] {
  return structBody(decl.name, decl.shape, decl.name, names);
}

function emitIntEnum(decl: Extract<Decl, { kind: 'intEnum' }>): string[] {
  return lines(
    `enum ${decl.name}: Int, ${CONFORMANCES}, CaseIterable {`,
    indent(decl.values.map((value) => `case ${spelledOut(value)} = ${String(value)}`)),
    '}',
  );
}

/** `Face` reads far better as `.four` than as `.value4`. */
const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
];
const spelledOut = (value: number): string =>
  Number.isInteger(value) && value >= 0 && value <= 9
    ? (NUMBER_WORDS[value] ?? `value${String(value)}`)
    : `value${String(value)}`;

function emitStringEnum(decl: Extract<Decl, { kind: 'stringEnum' }>): string[] {
  return lines(
    `enum ${decl.name}: String, ${CONFORMANCES}, CaseIterable {`,
    indent(decl.values.map((value) => `case ${escape(camelCase(value))} = "${value}"`)),
    '}',
  );
}

/**
 * A discriminated union becomes an enum with associated values, so a `switch` over it is
 * exhaustive and the compiler catches a missed case. The payload of each variant is a nested
 * struct; variants carrying nothing but their tag become bare cases.
 *
 * Decoding reads the discriminator, then hands the *same* decoder to the payload struct —
 * which ignores the extra `type` key, since Codable ignores keys it does not declare.
 * Encoding does the reverse: write the payload into the container, then add the tag.
 */
function emitUnion(decl: Extract<Decl, { kind: 'union' }>, names: Names): string[] {
  const disc = escape(camelCase(decl.discriminator));
  const cases = decl.variants.map((variant) => {
    const caseName = escape(camelCase(variant.tag));
    const payload =
      variant.shape === null ? null : nestedName(capitalise(camelCase(variant.tag)), names);
    return { ...variant, caseName, payload };
  });

  const payloads = cases.flatMap((variant) =>
    variant.payload === null || variant.shape === null
      ? []
      : lines(
          structBody(variant.payload, variant.shape, `${decl.name}.${variant.payload}`, names),
          '',
        ),
  );

  const decodeCases = cases.flatMap((variant) =>
    variant.payload === null
      ? [`case "${variant.tag}":`, `${INDENT}self = .${variant.caseName}`]
      : [
          `case "${variant.tag}":`,
          `${INDENT}self = .${variant.caseName}(try ${variant.payload}(from: decoder))`,
        ],
  );

  const encodeCases = cases.flatMap((variant) =>
    variant.payload === null
      ? [`case .${variant.caseName}:`, `${INDENT}break`]
      : [`case .${variant.caseName}(let payload):`, `${INDENT}try payload.encode(to: encoder)`],
  );

  const tagCases = cases.map((variant) =>
    variant.payload === null
      ? `case .${variant.caseName}: "${variant.tag}"`
      : `case .${variant.caseName}: "${variant.tag}"`,
  );

  return lines(
    `enum ${decl.name}: ${CONFORMANCES} {`,
    indent(
      lines(
        cases.map((variant) =>
          variant.payload === null
            ? `case ${variant.caseName}`
            : `case ${variant.caseName}(${variant.payload})`,
        ),
        '',
        payloads,
        `private enum CodingKeys: String, CodingKey { case ${disc} = "${decl.discriminator}" }`,
        '',
        `/// The wire value of this variant's \`${decl.discriminator}\` field.`,
        'var ' + disc + ': String {',
        indent(lines('switch self {', tagCases, '}')),
        '}',
        '',
        'init(from decoder: any Decoder) throws {',
        indent(
          lines(
            'let container = try decoder.container(keyedBy: CodingKeys.self)',
            `switch try container.decode(String.self, forKey: .${disc}) {`,
            decodeCases,
            'case let other:',
            indent([
              'throw DecodingError.dataCorruptedError(',
              `${INDENT}forKey: .${disc},`,
              `${INDENT}in: container,`,
              `${INDENT}debugDescription: "unknown ${decl.name} ${decl.discriminator}: \\(other)"`,
              ')',
            ]),
            '}',
          ),
        ),
        '}',
        '',
        'func encode(to encoder: any Encoder) throws {',
        indent(
          lines(
            'switch self {',
            encodeCases,
            '}',
            'var container = encoder.container(keyedBy: CodingKeys.self)',
            `try container.encode(${disc}, forKey: .${disc})`,
          ),
        ),
        '}',
      ),
    ),
    '}',
  );
}

function emitDecl(decl: Decl, names: Names): string[] {
  switch (decl.kind) {
    case 'struct':
      return emitStruct(decl, names);
    case 'intEnum':
      return emitIntEnum(decl);
    case 'stringEnum':
      return emitStringEnum(decl);
    case 'union':
      return emitUnion(decl, names);
    default: {
      const unreachable: never = decl;
      return unreachable;
    }
  }
}

export interface SwiftFileOptions {
  readonly protocolVersion: number;
  readonly minProtocolVersion: number;
  /** The party-code alphabet, emitted so a client normalises against the same set the wire uses. */
  readonly partyCodeAlphabet: string;
  readonly partyCodeLength: number;
}

export function emitSwift(decls: readonly Decl[], options: SwiftFileOptions): string {
  // Everything a nested type must not be called: the types this file declares, plus the
  // standard-library names a nested declaration would shadow inside its own scope.
  const names: Names = {
    reserved: new Set([...decls.map((decl) => decl.name), ...STDLIB_TYPE_NAMES]),
  };
  const header = [
    '//',
    '//  Generated by tools/codegen from packages/protocol. DO NOT EDIT.',
    '//',
    '//  To change a message shape, edit the Zod schema in packages/protocol and run',
    '//  `pnpm codegen`. Hand-editing this file guarantees it disagrees with the server.',
    '//',
    '//  Every type here is a value type conforming to Codable, Hashable and Sendable:',
    '//  Codable to cross the socket, Hashable so SwiftUI can diff it, and Sendable so it can',
    '//  pass between the GameSocket actor and a main-actor view model without a concurrency',
    '//  warning under Swift 6.',
    '//',
    '',
    'import Foundation',
    '',
    '/// The wire contract this client speaks. Sent on connect; the server hangs up on a',
    '/// version it does not support.',
    `let protocolVersion = ${String(options.protocolVersion)}`,
    `let minProtocolVersion = ${String(options.minProtocolVersion)}`,
    '',
    "/// A private game's invite code. The wire contract is strict and uppercase, so a client",
    '/// normalises what a player typed against this alphabet before sending it — which only works',
    '/// if it is the same alphabet, which is why it is generated rather than retyped.',
    `let partyCodeAlphabet = ${JSON.stringify(options.partyCodeAlphabet)}`,
    `let partyCodeLength = ${String(options.partyCodeLength)}`,
    '',
  ];
  const body = decls.flatMap((decl) => lines(emitDecl(decl, names), ''));
  return `${[...header, ...body]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
