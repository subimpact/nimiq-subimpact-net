/**
 * Sanity check for the staking transactions StakeDialog builds in the browser.
 *
 * Runs the same @nimiq/core TransactionBuilder calls the dialog makes (via the
 * nodejs export instead of the bundler one), serializes each transaction, parses
 * the bytes back with Transaction.fromAny, and asserts the fields survive the
 * round trip. This is what the Hub popup will show the user, so a mismatch here
 * means the dialog would ask someone to sign the wrong thing.
 *
 *   node scripts/test-tx-build.mjs
 */

import { Address, Transaction, TransactionBuilder } from '@nimiq/core';

// Mainnet. Keep in sync with NETWORK_ID in src/components/StakeDialog.tsx.
const NETWORK_ID = 24;
const FEE = 0n;
const VALIDATOR = 'NQ08 ACT8 T0FE PTG8 P5RL H2S3 QGXH V15R NVXY';
const OTHER_VALIDATOR = 'NQ97 04UL PBTY 3P4R TARV G303 K713 FNNY 4J3Y';
// A real staker of ImpactZero, used here only as a well-formed sender address.
const SENDER = 'NQ27 NCB1 3CYU 9P4L EM2V D7L2 28QE 36PA EXB1';
const AMOUNT_LUNA = 12_345_600_000n; // 123,456 NIM
const VALIDITY_START_HEIGHT = 61_311_377;

// Every staking transaction is addressed to the staking contract; the operation
// itself lives in the recipient data.
const STAKING_CONTRACT = 'NQ77 0000 0000 0000 0000 0000 0000 0000 0001';
// Transaction.flags bit 1 — set on signalling transactions, which move no value.
const FLAG_SIGNALLING = 2;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label}: expected ${expected}, got ${actual}`);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.message}`);
  }
}

function addr(userFriendly) {
  return Address.fromUserFriendlyAddress(userFriendly);
}

/** serialize() → the exact bytes handed to the Hub → parse back. */
function roundTrip(transaction) {
  const bytes = transaction.serialize();
  assert(bytes instanceof Uint8Array, 'serialize() did not return a Uint8Array');
  assert(bytes.length > 0, 'serialize() returned no bytes');
  return { bytes, parsed: Transaction.fromAny(bytes) };
}

test('newCreateStaker round-trips sender, delegation, value, fee, network', () => {
  const tx = TransactionBuilder.newCreateStaker(
    addr(SENDER),
    addr(VALIDATOR),
    AMOUNT_LUNA,
    FEE,
    VALIDITY_START_HEIGHT,
    NETWORK_ID,
  );
  const { bytes, parsed } = roundTrip(tx);

  assertEqual(parsed.sender.toUserFriendlyAddress(), SENDER, 'sender');
  assertEqual(parsed.recipient.toUserFriendlyAddress(), STAKING_CONTRACT, 'recipient');
  assertEqual(parsed.value, AMOUNT_LUNA, 'value');
  assertEqual(parsed.fee, 0n, 'fee');
  assertEqual(parsed.networkId, NETWORK_ID, 'networkId');
  assertEqual(parsed.validityStartHeight, VALIDITY_START_HEIGHT, 'validityStartHeight');

  // The delegated validator lives in the recipient data, not in a top-level field.
  const data = Buffer.from(parsed.data).toString('hex');
  const delegation = Buffer.from(addr(VALIDATOR).serialize()).toString('hex');
  assert(data.includes(delegation), `recipient data is missing the delegation: ${data}`);

  console.log(`      create: ${bytes.length} bytes, value ${parsed.value} luna`);
});

test('newAddStake round-trips sender, staker, value', () => {
  const tx = TransactionBuilder.newAddStake(
    addr(SENDER),
    addr(SENDER),
    AMOUNT_LUNA,
    FEE,
    VALIDITY_START_HEIGHT,
    NETWORK_ID,
  );
  const { bytes, parsed } = roundTrip(tx);

  assertEqual(parsed.sender.toUserFriendlyAddress(), SENDER, 'sender');
  assertEqual(parsed.recipient.toUserFriendlyAddress(), STAKING_CONTRACT, 'recipient');
  assertEqual(parsed.value, AMOUNT_LUNA, 'value');
  assertEqual(parsed.fee, 0n, 'fee');
  assertEqual(parsed.networkId, NETWORK_ID, 'networkId');

  const data = Buffer.from(parsed.data).toString('hex');
  const staker = Buffer.from(addr(SENDER).serialize()).toString('hex');
  assert(data.includes(staker), `recipient data is missing the staker address: ${data}`);

  console.log(`      add: ${bytes.length} bytes, value ${parsed.value} luna`);
});

test('newUpdateStaker round-trips the new delegation and carries no value', () => {
  const tx = TransactionBuilder.newUpdateStaker(
    addr(SENDER),
    addr(VALIDATOR),
    true,
    FEE,
    VALIDITY_START_HEIGHT,
    NETWORK_ID,
  );
  const { bytes, parsed } = roundTrip(tx);

  assertEqual(parsed.sender.toUserFriendlyAddress(), SENDER, 'sender');
  assertEqual(parsed.recipient.toUserFriendlyAddress(), STAKING_CONTRACT, 'recipient');
  assertEqual(parsed.value, 0n, 'value (a switch moves the existing stake, it sends none)');
  assertEqual(parsed.fee, 0n, 'fee');
  assertEqual(parsed.networkId, NETWORK_ID, 'networkId');
  assertEqual(parsed.flags, FLAG_SIGNALLING, 'flags (signalling)');

  const data = Buffer.from(parsed.data).toString('hex');
  assert(
    data.includes(Buffer.from(addr(VALIDATOR).serialize()).toString('hex')),
    `recipient data is missing the new delegation: ${data}`,
  );
  assert(
    !data.includes(Buffer.from(addr(OTHER_VALIDATOR).serialize()).toString('hex')),
    'recipient data references the wrong validator',
  );

  console.log(`      update: ${bytes.length} bytes, value ${parsed.value} luna`);
});

test('the hex the dialog broadcasts is the serialization of the built tx', () => {
  const tx = TransactionBuilder.newCreateStaker(
    addr(SENDER),
    addr(VALIDATOR),
    AMOUNT_LUNA,
    FEE,
    VALIDITY_START_HEIGHT,
    NETWORK_ID,
  );
  const hex = Buffer.from(tx.serialize()).toString('hex');
  assert(/^[0-9a-f]+$/.test(hex), 'serialized hex contains non-hex characters');
  assertEqual(hex.length % 2, 0, 'serialized hex length parity');
  // Unsigned here — the Hub replaces the empty proof with the signed one — so we
  // only assert the wire format the worker validates, not chain acceptance.
  assertEqual(
    Transaction.fromAny(Buffer.from(hex, 'hex')).value,
    AMOUNT_LUNA,
    'value after a hex round trip',
  );
});

test('a below-minimum first stake still builds (the dialog enforces the minimum)', () => {
  // Policy exposes the consensus minimum; the dialog blocks amounts under it
  // client-side, since the builder itself does not check.
  const tx = TransactionBuilder.newCreateStaker(
    addr(SENDER),
    addr(VALIDATOR),
    1n,
    FEE,
    VALIDITY_START_HEIGHT,
    NETWORK_ID,
  );
  assertEqual(Transaction.fromAny(tx.serialize()).value, 1n, 'value');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
