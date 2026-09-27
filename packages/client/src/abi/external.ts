import { parseAbi } from 'viem';

/**
 * ABIs of contracts Hunch reads but does not own. Only the functions the venue uses.
 */

/** Paxos USDG (UUPS proxy + facets) on chain 4663: ERC-20, EIP-2612, EIP-3009 views. */
export const usdgAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function nonces(address owner) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() view returns (bytes32)',
  'function isFrozen(address account) view returns (bool)',
  'function paused() view returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);

/** Chainlink AggregatorV3 proxy (and the aggregator's AnswerUpdated event). */
export const aggregatorV3Abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
  'function version() view returns (uint256)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function latestRound() view returns (uint256)',
  'function aggregator() view returns (address)',
  'function phaseId() view returns (uint16)',
  'function phaseAggregators(uint16 phaseId) view returns (address)',
  'event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)',
  'event NewRound(uint256 indexed roundId, address indexed startedBy, uint256 startedAt)',
]);

/** Robinhood Stock Token (Beacon proxy → `Stock`), read-only surface. */
export const stockTokenAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function oraclePaused() view returns (bool)',
  'function paused() view returns (bool)',
  'function uiMultiplier() view returns (uint256)',
  // Topics verified in the Stock implementation's bytecode (0xb35490d6…5aE2) on 2026-09-28.
  'event OraclePaused()',
  'event OracleUnpaused()',
]);

/** Multicall3 (canonical address). `getBlockNumber()` returns `block.number` = the L1 block estimate on 4663. */
export const multicall3Abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getBlockNumber() view returns (uint256 blockNumber)',
  'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);
