import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { declarationFrom, UnsupportedSchema, type Decl } from '../src/ir.ts';
import { emitSwift } from '../src/swift.ts';
import { declarations, generatedTypeNames } from '../src/registry.ts';

/** Convert one schema the way the registry does, so tests exercise the real path. */
const irOf = (name: string, schema: z.ZodType, io: 'input' | 'output' = 'output'): Decl =>
  declarationFrom(name, z.toJSONSchema(schema, { io }));

const swiftOf = (decls: readonly Decl[]): string =>
  emitSwift(decls, { protocolVersion: 1, minProtocolVersion: 1 });

describe('JSON Schema to IR', () => {
  test('a discriminated union keeps its own discriminator name', () => {
    const phaseLike = z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('bidding'), turnId: z.string() }),
      z.strictObject({ kind: z.literal('reveal') }),
    ]);
    const decl = irOf('PhaseLike', phaseLike);
    expect(decl.kind).toBe('union');
    if (decl.kind !== 'union') return;
    expect(decl.discriminator).toBe('kind');
    expect(decl.variants.map((v) => v.tag)).toEqual(['bidding', 'reveal']);
    // A variant carrying nothing but its tag has no payload at all.
    expect(decl.variants[1]?.shape).toBeNull();
    // ...and the discriminator itself is never emitted as a field.
    expect(decl.variants[0]?.shape?.fields.map((f) => f.name)).toEqual(['turnId']);
  });

  test('nullable and optional are kept apart', () => {
    // They look alike in Swift — both become `T?` — but they encode differently, so the IR
    // has to remember which is which.
    const decl = irOf(
      'Mixed',
      z.strictObject({
        mustBePresentMayBeNull: z.string().nullable(),
        mayBeAbsent: z.string().optional(),
        always: z.string(),
      }),
      'input',
    );
    expect(decl.kind).toBe('struct');
    if (decl.kind !== 'struct') return;
    expect(decl.shape.fields).toEqual([
      { name: 'mustBePresentMayBeNull', type: { kind: 'string' }, nullable: true, optional: false },
      { name: 'mayBeAbsent', type: { kind: 'string' }, nullable: false, optional: true },
      { name: 'always', type: { kind: 'string' }, nullable: false, optional: false },
    ]);
  });

  test('both of zod’s spellings of nullable are understood', () => {
    // A bare string nullable renders as `type: ['string', 'null']`; a constrained one renders
    // as `anyOf: [{...}, {type: 'null'}]`. Missing the first spelling was a real bug.
    const decl = irOf(
      'Nullables',
      z.strictObject({
        plain: z.string().nullable(),
        constrained: z.string().min(1).max(64).nullable(),
        numeric: z.number().int().nullable(),
      }),
    );
    if (decl.kind !== 'struct') return expect.unreachable();
    expect(decl.shape.fields.map((f) => [f.name, f.type.kind, f.nullable])).toEqual([
      ['plain', 'string', true],
      ['constrained', 'string', true],
      ['numeric', 'int', true],
    ]);
  });

  test('a record becomes a dictionary and an inline object becomes a nested type', () => {
    const decl = irOf(
      'Holder',
      z.strictObject({
        counts: z.record(z.string(), z.number().int()),
        inner: z.strictObject({ a: z.boolean() }),
      }),
    );
    if (decl.kind !== 'struct') return expect.unreachable();
    const [counts, inner] = decl.shape.fields;
    expect(counts?.type).toEqual({ kind: 'dictionary', value: { kind: 'int' } });
    expect(inner?.type.kind).toBe('nested');
  });

  test('a union of string enums is flattened into one enum', () => {
    const decl = irOf('Codes', z.union([z.enum(['A_ONE', 'A_TWO']), z.enum(['B_ONE'])]));
    expect(decl).toEqual({
      kind: 'stringEnum',
      name: 'Codes',
      values: ['A_ONE', 'A_TWO', 'B_ONE'],
    });
  });

  test('a union of numeric literals becomes an int enum', () => {
    const decl = irOf('Small', z.union([z.literal(1), z.literal(2)]));
    expect(decl).toEqual({ kind: 'intEnum', name: 'Small', values: [1, 2] });
  });

  test('something unrepresentable fails loudly rather than emitting nonsense', () => {
    expect(() => irOf('Tuply', z.tuple([z.string(), z.number()]))).toThrow(UnsupportedSchema);
  });
});

describe('Swift emitter', () => {
  test('an int enum spells its cases out', () => {
    const swift = swiftOf([irOf('Face', z.union([z.literal(1), z.literal(6)]))]);
    expect(swift).toContain('enum Face: Int, Codable, Hashable, Sendable, CaseIterable {');
    expect(swift).toContain('case one = 1');
    expect(swift).toContain('case six = 6');
  });

  test('a string enum keeps the wire value and gives Swift a camelCase case', () => {
    const swift = swiftOf([irOf('Code', z.enum(['MATCH_ENDED', 'afk']))]);
    expect(swift).toContain('case matchEnded = "MATCH_ENDED"');
    expect(swift).toContain('case afk = "afk"');
  });

  test('a plain struct relies on synthesised Codable', () => {
    const swift = swiftOf([irOf('Bid', z.strictObject({ quantity: z.number().int() }))]);
    expect(swift).toContain('struct Bid: Codable, Hashable, Sendable {');
    expect(swift).toContain('let quantity: Int');
    // Nothing nullable, so no hand-written coding is needed.
    expect(swift).not.toContain('init(from decoder');
  });

  test('a nullable field gets explicit coding that writes null rather than omitting the key', () => {
    const swift = swiftOf([
      irOf('Thing', z.strictObject({ maybe: z.string().nullable(), sure: z.string() })),
    ]);
    expect(swift).toContain('let maybe: String?');
    expect(swift).toContain('maybe = try container.decodeIfPresent(String.self, forKey: .maybe)');
    // `encode`, not `encodeIfPresent`: the server's schemas are strict and want the key.
    expect(swift).toContain('try container.encode(maybe, forKey: .maybe)');
  });

  test('an optional-only struct needs no hand-written coding', () => {
    // Swift's synthesised encoder already uses `encodeIfPresent` for optionals, which is
    // exactly right for a field that may be absent. Nothing to override.
    const swift = swiftOf([
      irOf('Hello', z.strictObject({ token: z.string().optional() }), 'input'),
    ]);
    expect(swift).toContain('let token: String?');
    expect(swift).not.toContain('init(from decoder');
  });

  test('where coding is written by hand, optional and nullable encode differently', () => {
    const swift = swiftOf([
      irOf(
        'Mixed',
        z.strictObject({ token: z.string().optional(), detail: z.string().nullable() }),
        'input',
      ),
    ]);
    // Absent when nil...
    expect(swift).toContain('try container.encodeIfPresent(token, forKey: .token)');
    // ...versus present and null.
    expect(swift).toContain('try container.encode(detail, forKey: .detail)');
  });

  test('a union becomes an enum with associated values and a decoder that switches on the tag', () => {
    const swift = swiftOf([
      irOf(
        'Msg',
        z.discriminatedUnion('type', [
          z.strictObject({ type: z.literal('ping') }),
          z.strictObject({ type: z.literal('bidMade'), quantity: z.number().int() }),
        ]),
      ),
    ]);
    expect(swift).toContain('case ping');
    expect(swift).toContain('case bidMade(BidMade)');
    expect(swift).toContain('self = .bidMade(try BidMade(from: decoder))');
    expect(swift).toContain('try container.encode(type, forKey: .type)');
    expect(swift).toContain('debugDescription: "unknown Msg type: \\(other)"');
  });

  test('a payload that would shadow another declared type is renamed', () => {
    const swift = swiftOf([
      irOf('Bid', z.strictObject({ quantity: z.number().int() })),
      irOf(
        'ClientMessage',
        z.discriminatedUnion('type', [
          z.strictObject({ type: z.literal('bid'), matchId: z.string() }),
        ]),
      ),
    ]);
    expect(swift).toContain('case bid(BidPayload)');
    expect(swift).toContain('struct BidPayload: Codable, Hashable, Sendable {');
  });

  test('a payload that would shadow a standard-library type is renamed too', () => {
    const swift = swiftOf([
      irOf(
        'ServerMessage',
        z.discriminatedUnion('type', [
          z.strictObject({ type: z.literal('error'), code: z.string() }),
        ]),
      ),
    ]);
    expect(swift).toContain('case error(ErrorPayload)');
    expect(swift).not.toMatch(/struct Error:/);
  });
});

describe('The real protocol', () => {
  const swift = swiftOf(declarations());

  test('every registered type is declared exactly once', () => {
    for (const name of generatedTypeNames()) {
      const declared = swift.match(new RegExp(`^(struct|enum) ${name}:`, 'gm')) ?? [];
      expect(declared, name).toHaveLength(1);
    }
  });

  test('the file warns against hand-editing, which CLAUDE.md forbids', () => {
    expect(swift).toContain('DO NOT EDIT');
    expect(swift).toContain('pnpm codegen');
  });

  test('the protocol version is baked in, since the server checks it on connect', () => {
    expect(swift).toContain('let protocolVersion = 1');
  });

  test('ProtocolEvent is one flat enum over both engine and server events', () => {
    const cases = [...swift.matchAll(/^ {4}case (\w+)\(/gm)].map((m) => m[1]);
    for (const expected of ['roundStarted', 'diceRevealed', 'playerTimedOut', 'botTookOver']) {
      expect(cases).toContain(expected);
    }
  });

  test('the renamed payload still refers to the type it would have shadowed', () => {
    // The bug this exists for: `ClientMessage.bid` generated a nested struct called `Bid`,
    // whose own `bid: Bid` field then resolved to itself — an infinitely sized type that
    // would not compile. It must reference the top-level `Bid`.
    expect(swift).toMatch(/struct BidPayload[\s\S]*?let bid: Bid\n/);
    expect(swift).toContain('case bid(BidPayload)');
  });

  test('a snapshot references PlayerView rather than inlining a copy of it', () => {
    // The registry emits `$ref`s between registered schemas; without that, MatchSnapshot
    // would carry a duplicate of every PlayerView field.
    expect(swift).toMatch(/struct MatchSnapshot[\s\S]*?let view: PlayerView/);
  });

  test('the output is deterministic', () => {
    expect(swiftOf(declarations())).toBe(swift);
  });
});
