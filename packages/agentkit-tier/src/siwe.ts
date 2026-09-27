/**
 * CAIP-122 / EIP-4361 message handling.
 *
 * AgentKit challenges an agent to sign a "sign in with Ethereum" message and the agent
 * returns it with an EIP-191 signature. Two things follow from that, and both shape
 * this file.
 *
 * First, verification recovers against the message text the client actually sent, never
 * against a message this package re-renders from parsed fields. Re-rendering is how a
 * verifier ends up rejecting valid signatures over a space or a line ending it would
 * have written differently. Parsing is therefore for reading the claims out, and the
 * bytes are checked as they arrived.
 *
 * Second, the chain line is genuinely ambiguous in the ecosystem: EIP-4361 specifies a
 * bare integer, CAIP-122 and World's own field list specify CAIP-2 (`eip155:480`). Both
 * are accepted here, because an implementer cannot tell from the documentation which one
 * a given client emits, and rejecting the wrong guess looks identical to a forged proof.
 */

import type { Address, SiweFields } from './types.js';

const PREAMBLE_SUFFIX = ' wants you to sign in with your Ethereum account:';
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
/** 65 bytes: r (32) + s (32) + v (1). */
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

/** What AgentKit puts in the statement line. Configurable; this is the documented default. */
export const AGENTKIT_STATEMENT = 'Verify your agent is backed by a real human';

export function isAddressLike(value: string): value is Address {
  return ADDRESS_PATTERN.test(value);
}

export function isSignatureLike(value: string): boolean {
  return SIGNATURE_PATTERN.test(value);
}

export function lowercaseAddress(value: string): Address {
  return value.toLowerCase() as Address;
}

export interface SiweMessageInput {
  readonly domain: string;
  readonly address: Address;
  readonly statement?: string | null | undefined;
  readonly uri: string;
  readonly version?: string | undefined;
  readonly chainId: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expirationTime?: string | null | undefined;
  readonly notBefore?: string | null | undefined;
  readonly requestId?: string | null | undefined;
  readonly resources?: readonly string[] | undefined;
}

/**
 * Renders an EIP-4361 message. Used by this package's client helper and by the tests;
 * the verifier never calls it, for the reason in the file header.
 */
export function formatSiweMessage(input: SiweMessageInput): string {
  const lines: string[] = [`${input.domain}${PREAMBLE_SUFFIX}`, input.address, ''];
  const statement = input.statement ?? null;
  if (statement !== null) lines.push(statement, '');
  lines.push(
    `URI: ${input.uri}`,
    `Version: ${input.version ?? '1'}`,
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
  );
  if (input.expirationTime != null) lines.push(`Expiration Time: ${input.expirationTime}`);
  if (input.notBefore != null) lines.push(`Not Before: ${input.notBefore}`);
  if (input.requestId != null) lines.push(`Request ID: ${input.requestId}`);
  const resources = input.resources ?? [];
  if (resources.length > 0) {
    lines.push('Resources:');
    for (const resource of resources) lines.push(`- ${resource}`);
  }
  return lines.join('\n');
}

export type SiweParseResult =
  | { readonly ok: true; readonly fields: SiweFields }
  | { readonly ok: false; readonly detail: string };

function fail(detail: string): SiweParseResult {
  return { ok: false, detail };
}

/**
 * Reads the claims out of a signed message.
 *
 * Deliberately tolerant about line endings and about whether a statement is present,
 * and strict about the five fields EIP-4361 makes mandatory. Anything it cannot read is
 * a malformed proof rather than a forged one, and the caller reports it as such.
 */
export function parseSiweMessage(message: string): SiweParseResult {
  const lines = message.replace(/\r\n/g, '\n').split('\n');

  const preamble = lines[0];
  if (preamble === undefined || !preamble.endsWith(PREAMBLE_SUFFIX)) {
    return fail('message did not open with an EIP-4361 preamble line');
  }
  const domain = preamble.slice(0, preamble.length - PREAMBLE_SUFFIX.length);
  if (domain.length === 0) return fail('message named no domain');

  const address = lines[1];
  if (address === undefined || !isAddressLike(address)) {
    return fail('the address line was missing or not a 20-byte hex address');
  }
  if (lines[2] !== '') return fail('the address line was not followed by a blank line');

  // Everything between the blank line and the first field line is the statement. The
  // spec allows it to be absent, in which case the field block starts immediately.
  const fieldStart = lines.findIndex((line, index) => index >= 3 && line.startsWith('URI: '));
  if (fieldStart === -1) return fail('message contained no URI field');
  const statementLines = lines.slice(3, fieldStart).filter((line) => line.trim().length > 0);
  const statement = statementLines.length === 0 ? null : statementLines.join('\n');

  const scalars = new Map<string, string>();
  const resources: string[] = [];
  let inResources = false;
  for (const line of lines.slice(fieldStart)) {
    if (inResources) {
      if (line.startsWith('- ')) {
        resources.push(line.slice(2));
        continue;
      }
      if (line.trim().length === 0) continue;
      inResources = false;
    }
    if (line === 'Resources:') {
      inResources = true;
      continue;
    }
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(': ');
    if (separator === -1) return fail(`could not read the line ${JSON.stringify(line)} as a field`);
    const key = line.slice(0, separator);
    if (scalars.has(key)) return fail(`the field ${JSON.stringify(key)} appeared twice`);
    scalars.set(key, line.slice(separator + 2));
  }

  const uri = scalars.get('URI');
  const version = scalars.get('Version');
  const chainId = scalars.get('Chain ID');
  const nonce = scalars.get('Nonce');
  const issuedAt = scalars.get('Issued At');
  for (const [name, value] of [
    ['URI', uri],
    ['Version', version],
    ['Chain ID', chainId],
    ['Nonce', nonce],
    ['Issued At', issuedAt],
  ] as const) {
    if (value === undefined || value.length === 0) return fail(`the ${name} field was missing or empty`);
  }

  return {
    ok: true,
    fields: {
      domain,
      address: address as Address,
      statement,
      uri: uri as string,
      version: version as string,
      chainId: chainId as string,
      nonce: nonce as string,
      issuedAt: issuedAt as string,
      expirationTime: scalars.get('Expiration Time') ?? null,
      notBefore: scalars.get('Not Before') ?? null,
      requestId: scalars.get('Request ID') ?? null,
      resources,
    },
  };
}

/**
 * Reads either form of the chain line. Returns null for anything else, including a
 * non-eip155 CAIP-2 namespace, because AgentBook binds EVM wallets.
 */
export function parseChainId(raw: string): number | null {
  const trimmed = raw.trim();
  const caip2 = /^eip155:(\d{1,19})$/.exec(trimmed);
  if (caip2 !== null) return Number(caip2[1]);
  if (/^\d{1,19}$/.test(trimmed)) return Number(trimmed);
  return null;
}

/** ISO 8601 to epoch milliseconds. Null when the string is not a usable timestamp. */
export function parseTimestamp(raw: string): number | null {
  const parsed = Date.parse(raw.trim());
  return Number.isFinite(parsed) ? parsed : null;
}
