jest.mock('@bitcoincash/electrum-client', () => {
  // Bypass the suite-wide package mock and Jest's ESM loader: Node 26 loads the actual installed client.
  const nativeModule = process.getBuiltinModule('node:module');
  const loader = new nativeModule.Module(__filename);
  return loader.require(require.resolve('@bitcoincash/electrum-client'));
});
jest.mock('../../api/blocks', () => ({
  __esModule: true,
  default: { getBlocks: () => [], getCurrentBlockHeight: () => 10 },
}));
jest.mock('../../api/mempool', () => ({
  __esModule: true,
  default: { getMempool: jest.fn(() => ({})), isInSync: () => true },
}));
jest.mock('../../api/memory-cache', () => ({ __esModule: true, default: { get: () => undefined, set: () => {} } }));
jest.mock('../../api/bitcoin/bitcoin-api-factory', () => ({ __esModule: true, default: {}, bitcoinCoreApi: {} }));
import { createServer, Server, Socket, AddressInfo } from 'node:net';
import config from '../../config';
import mempool from '../../api/mempool';
import BitcoindElectrsApi from '../../api/bitcoin/electrum-api';

// A node without a transaction index: it reads a confirmed transaction only from the block named by its hash
// and a mempool transaction only without one.
const tip = 10;
const blockHash = (height: number) => height.toString(16).padStart(64, '0');
const address = 'qrv4ytx9jweyy095v3rxxysrs2luz5kcrq50kljf27';
const confirmedAt5 = 'a'.repeat(64);
const confirmedAt7 = 'b'.repeat(64);
const pending = 'c'.repeat(64);
const heights: Record<string, number> = { [confirmedAt5]: 5, [confirmedAt7]: 7 };
const raw = (txid: string) => ({
  txid,
  version: 2,
  locktime: 0,
  size: 100,
  vin: [{ coinbase: '0101', sequence: 0xffffffff }],
  vout: [{ value: 0.00001, n: 0, scriptPubKey: { hex: '51', asm: '1', type: 'nonstandard' } }],
  ...(heights[txid] && { confirmations: tip - heights[txid] + 1, blockhash: blockHash(heights[txid]), blocktime: 1 }),
});
const node = {
  validateAddress: jest.fn(async () => ({ isvalid: true, address, scriptPubKey: '76a914' + '00'.repeat(20) + '88ac' })),
  getBestBlockHash: jest.fn(async () => blockHash(tip)),
  getBlockHash: jest.fn(async (height: number) => blockHash(height)),
  getBlock: jest.fn(async (hash: string) => ({ hash, height: parseInt(hash, 16) })),
  getRawTransaction: jest.fn(async (txid: string, _verbosity: number, hash: string, _patterns: boolean) => {
    const found = heights[txid] !== undefined ? hash === blockHash(heights[txid]) : txid === pending && hash === '';
    if (!found) throw new Error('No such mempool transaction. Use -txindex or provide a block hash.');
    return raw(txid);
  }),
  getMempoolEntry: jest.fn(async () => ({ fees: { base: 0.000001 } })),
  getTxOut: jest.fn(async () => null),
};

let server: Server;
let api: BitcoindElectrsApi;
const sockets = new Set<Socket>();
const requests: { method: string; params: any[] }[] = [];
const previous = { ...config.ELECTRUM };
let history: unknown[] = [];
beforeAll(async () => {
  server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        requests.push(request);
        let result: unknown;
        let error: unknown;
        switch (request.method) {
          case 'server.version':
            result = ['Fulcrum mock', '1.6'];
            break;
          case 'blockchain.scripthash.get_first_use':
            result = { height: 5, block_hash: blockHash(5), tx_hash: confirmedAt5 };
            break;
          case 'blockchain.scripthash.get_mempool':
            result = [];
            break;
          case 'blockchain.scripthash.get_history':
            result = history;
            break;
          case 'blockchain.transaction.get_merkle':
            result = { block_height: request.params[1], merkle: [], pos: 0 };
            break;
          case 'blockchain.transaction.get_confirmed_blockhash': {
            const height = heights[request.params[0]];
            if (height !== undefined) {
              result = { block_hash: blockHash(height), block_height: height };
            } else {
              // Fulcrum and Rostrum answer with an error for a mempool or unknown transaction
              error = { code: 1, message: 'No confirmed transaction matching the requested hash was found' };
            }
            break;
          }
          default:
            error = { code: -32601, message: 'Unexpected method' };
        }
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) }) + '\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  Object.assign(config.ELECTRUM, {
    HOST: '127.0.0.1',
    PORT: (server.address() as AddressInfo).port,
    TLS_ENABLED: false,
  });
  api = new BitcoindElectrsApi(node);
  await Promise.all([
    (api as any).electrumClient.server_version('test', '1.6'),
    (api as any).historyClient.server_version('test', '1.6'),
  ]);
});
afterAll(async () => {
  (api as any).electrumClient.close();
  (api as any).historyClient.close();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  Object.assign(config.ELECTRUM, previous);
});
beforeEach(() => {
  requests.length = 0;
  history = [
    { tx_hash: confirmedAt5, height: 5 },
    { tx_hash: confirmedAt7, height: 7 },
  ];
  node.getRawTransaction.mockClear();
  jest.mocked(mempool.getMempool).mockReturnValue({});
  (api as any).historyCoordinator.cache.clear();
});
const blockHashLookups = () =>
  requests.filter((request) => request.method === 'blockchain.transaction.get_confirmed_blockhash');

test('address page reads each confirmed history row from the block at its height', async () => {
  const page = await api.$getAddressPage(address);
  expect(page.transactions.map((tx) => [tx.txid, tx.status])).toEqual([
    [confirmedAt7, { confirmed: true, block_height: 7, block_hash: blockHash(7), block_time: 1 }],
    [confirmedAt5, { confirmed: true, block_height: 5, block_hash: blockHash(5), block_time: 1 }],
  ]);
  expect(node.getRawTransaction.mock.calls).toEqual([
    [confirmedAt7, 2, blockHash(7), true],
    [confirmedAt5, 2, blockHash(5), true],
  ]);
  expect(blockHashLookups()).toHaveLength(0);
});

test('address transactions read each confirmed history row from the block at its height', async () => {
  const transactions = await api.$getAddressTransactions(address, '');
  expect(transactions.map((tx) => tx.txid)).toEqual([confirmedAt7, confirmedAt5]);
  expect(node.getRawTransaction.mock.calls).toEqual([
    [confirmedAt7, 2, blockHash(7), true],
    [confirmedAt5, 2, blockHash(5), true],
  ]);
  expect(blockHashLookups()).toHaveLength(0);
});

test.each([
  ['transaction', () => api.$getRawTransaction(confirmedAt7, false, true)],
  ['outspends', () => api.$getOutspends(confirmedAt7)],
  ['merkle proof', () => api.$getTransactionMerkleProof(confirmedAt7)],
])('%s of a bare confirmed txid asks the Electrum server for its block', async (_name, call) => {
  await call();
  expect(blockHashLookups().map((request) => request.params)).toEqual([[confirmedAt7]]);
  expect(node.getRawTransaction.mock.calls).toEqual([[confirmedAt7, 2, blockHash(7), true]]);
});

test('merkle proof uses the height of the block the node read the transaction from', async () => {
  await api.$getTransactionMerkleProof(confirmedAt7);
  expect(requests.find((request) => request.method === 'blockchain.transaction.get_merkle')?.params).toEqual([
    confirmedAt7,
    7,
  ]);
});

test('a mempool transaction is read without a block hash or an Electrum lookup', async () => {
  jest.mocked(mempool.getMempool).mockReturnValue({ [pending]: {} } as any);
  const tx: any = await api.$getRawTransaction(pending);
  expect(tx.status).toEqual({ confirmed: false });
  expect(node.getRawTransaction.mock.calls).toEqual([[pending, 2, '', true]]);
  expect(blockHashLookups()).toHaveLength(0);
});

test('a transaction the Electrum server cannot place is read without a block hash', async () => {
  // Not yet in the explorer's mempool, so the Electrum server is asked and answers with an error
  const tx: any = await api.$getRawTransaction(pending);
  expect(tx.status).toEqual({ confirmed: false });
  expect(blockHashLookups().map((request) => request.params)).toEqual([[pending]]);
  expect(node.getRawTransaction.mock.calls).toEqual([[pending, 2, '', true]]);
});
