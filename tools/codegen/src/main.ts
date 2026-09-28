/**
 * `pnpm codegen`.
 *
 * Writes the Swift models into `clients/ios/Sources/Generated/`, which is gitignored: the
 * protocol is the source of truth and the Swift is a build product, so it is regenerated
 * rather than reviewed. CI runs this before `xcodebuild`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIN_PROTOCOL_VERSION,
  PARTY_CODE_ALPHABET,
  PARTY_CODE_LENGTH,
  PROTOCOL_VERSION,
} from '@liars-dice/protocol';
import { declarations } from './registry.ts';
import { emitSwift } from './swift.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const target = join(repoRoot, 'clients', 'ios', 'Sources', 'Generated', 'Protocol.swift');

const source = emitSwift(declarations(), {
  protocolVersion: PROTOCOL_VERSION,
  minProtocolVersion: MIN_PROTOCOL_VERSION,
  partyCodeAlphabet: PARTY_CODE_ALPHABET,
  partyCodeLength: PARTY_CODE_LENGTH,
});

await mkdir(dirname(target), { recursive: true });
await writeFile(target, source, 'utf8');

const lines = source.split('\n').length;
process.stdout.write(
  `codegen: wrote ${String(lines)} lines to ${target.replace(`${repoRoot}/`, '')}\n`,
);
