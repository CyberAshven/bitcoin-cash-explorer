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
import BitcoindElectrsApi from '../../api/bitcoin/electrum-api';

// A node reads a confirmed transaction without a block hash only with a transaction index (or, on BCHN, while it
// has an unspent output); without one it answers -5 unless given the block the transaction is in.
const tip = 10;
const blockHash = (height: number) => height.toString(16).padStart(64, '0');
const address = 'qrv4ytx9jweyy095v3rxxysrs2luz5kcrq50kljf27';
const funding = 'a'.repeat(64);
const spending = 'b'.repeat(64);
const pending = 'c'.repeat(64);
const unknown = 'd'.repeat(64);
const script = { hex: '51', asm: '1', type: 'nonstandard', byteCodePattern: { pattern: '51', data: ['51'] } };
const transactions: Record<string, { height?: number; vin: any[]; value: number }> = {
  [funding]: { height: 5, vin: [{ coinbase: '0101', sequence: 0xffffffff }], value: 0.00001 },
  // Spends the only output of the funding transaction, so no output of it stays unspent
  [spending]: {
    height: 7,
    vin: [
      { txid: funding, vout: 0, sequence: 0xffffffff, value: 0.00001, scriptSig: { hex: '51' }, scriptPubKey: script },
    ],
    value: 0.000009,
  },
  [pending]: { vin: [{ coinbase: '0101', sequence: 0xffffffff }], value: 0.00001 },
};
const raw = (txid: string) => {
  const { height, vin, value } = transactions[txid];
  return {
    txid,
    hex: '02' + txid,
    version: 2,
    locktime: 0,
    size: 100,
    vin: structuredClone(vin),
    vout: [{ value, n: 0, scriptPubKey: { hex: '51', asm: '1', type: 'nonstandard' } }],
    ...(height && { confirmations: tip - height + 1, blockhash: blockHash(height), blocktime: 1 }),
  };
};
let txindex = false;
const node = {
  validateAddress: jest.fn(async () => ({ isvalid: true, address, scriptPubKey: '51' })),
  getBestBlockHash: jest.fn(async () => blockHash(tip)),
  getBlockHash: jest.fn(async (height: number) => blockHash(height)),
  getBlock: jest.fn(async (hash: string) => ({ hash, height: parseInt(hash, 16) })),
  getRawTransaction: jest.fn(async (txid: string, _verbosity: number | boolean, hash = '', _patterns?: boolean) => {
    const tx = transactions[txid];
    if (tx && hash && tx.height !== undefined && hash === blockHash(tx.height)) return raw(txid);
    if (tx && !hash && (tx.height === undefined || txindex)) return raw(txid);
    const message = hash ? 'No such transaction found in the provided block' : 'No such mempool transaction';
    throw Object.assign(new Error(message), { code: -5 });
  }),
  getMempoolEntry: jest.fn(async () => ({ fees: { base: 0.000001 } })),
  getTxOut: jest.fn(async () => null),
};

let server: Server;
let api: BitcoindElectrsApi;
const sockets = new Set<Socket>();
const requests: { method: string; params: any[] }[] = [];
const previous = { ...config.ELECTRUM };
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
            result = { height: 5, block_hash: blockHash(5), tx_hash: funding };
            break;
          case 'blockchain.scripthash.get_mempool':
            result = [];
            break;
          case 'blockchain.scripthash.get_history':
            result = [
              { tx_hash: funding, height: 5 },
              { tx_hash: spending, height: 7 },
            ];
            break;
          case 'blockchain.transaction.get_merkle':
            result = { block_height: request.params[1], merkle: [], pos: 0 };
            break;
          case 'blockchain.transaction.get_confirmed_blockhash': {
            const height = transactions[request.params[0]]?.height;
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
  txindex = false;
  node.getRawTransaction.mockClear();
  node.getBlockHash.mockClear();
  (api as any).historyCoordinator.cache.clear();
});
const blockHashLookups = () =>
  requests.filter((request) => request.method === 'blockchain.transaction.get_confirmed_blockhash');
const historyBlockHeights = () =>
  node.getBlockHash.mock.calls.map(([height]) => height).filter((height) => height !== tip);

test.each([true, false])('address page reads history rows by the block at their height (txindex %s)', async (index) => {
  txindex = index;
  const page = await api.$getAddressPage(address);
  expect(page.transactions.map((tx) => [tx.txid, tx.status.block_height, tx.fee])).toEqual([
    [spending, 7, 100],
    [funding, 5, 0],
  ]);
  expect(node.getRawTransaction.mock.calls).toEqual(
    index
      ? [
          [spending, 2, '', true],
          [funding, 2, '', true],
        ]
      : [
          [spending, 2, '', true],
          [spending, 2, blockHash(7), true],
          [funding, 2, '', true],
          [funding, 2, blockHash(5), true],
        ]
  );
  // The node with a transaction index needs neither a block hash nor the Electrum server
  expect(historyBlockHeights()).toEqual(index ? [] : [7, 5]);
  expect(blockHashLookups()).toHaveLength(0);
});

test('address transactions read history rows by the block at their height', async () => {
  const transactions = await api.$getAddressTransactions(address, '');
  expect(transactions.map((tx) => tx.txid)).toEqual([spending, funding]);
  expect(historyBlockHeights()).toEqual([7, 5]);
  expect(blockHashLookups()).toHaveLength(0);
});

const bareTxid: [string, () => Promise<unknown>, any[][], any[][]][] = [
  [
    'transaction',
    () => api.$getRawTransaction(funding, false, true),
    [[funding, 2, '', true]],
    [
      [funding, 2, '', true],
      [funding, 2, blockHash(5), true],
    ],
  ],
  [
    'outspends',
    () => api.$getOutspends(funding),
    [[funding, 2, '', true]],
    [
      [funding, 2, '', true],
      [funding, 2, blockHash(5), true],
    ],
  ],
  [
    'merkle proof',
    () => api.$getTransactionMerkleProof(funding),
    [[funding, 2, '', true]],
    [
      [funding, 2, '', true],
      [funding, 2, blockHash(5), true],
    ],
  ],
  [
    'hex',
    () => api.$getTransactionHex(funding),
    [[funding, true]],
    [
      [funding, true],
      [funding, true, blockHash(5)],
    ],
  ],
];

test.each(bareTxid)(
  '%s of a bare txid on a node with a transaction index asks no Electrum server',
  async (_n, call, calls) => {
    txindex = true;
    await call();
    expect(node.getRawTransaction.mock.calls).toEqual(calls);
    expect(blockHashLookups()).toHaveLength(0);
  }
);

test.each(bareTxid)(
  '%s of a bare txid on a node without a transaction index asks the Electrum server once for its block',
  async (_n, call, _calls, calls) => {
    await call();
    expect(node.getRawTransaction.mock.calls).toEqual(calls);
    expect(blockHashLookups().map((request) => request.params)).toEqual([[funding]]);
  }
);

test('merkle proof uses the height of the block the node read the transaction from', async () => {
  expect(await api.$getTransactionMerkleProof(funding)).toEqual({ block_height: 5, merkle: [], pos: 0 });
  expect(requests.find((request) => request.method === 'blockchain.transaction.get_merkle')?.params).toEqual([
    funding,
    5,
  ]);
});

test('a mempool transaction is read without a block hash or an Electrum lookup', async () => {
  const tx: any = await api.$getRawTransaction(pending);
  expect(tx.status).toEqual({ confirmed: false });
  expect(node.getRawTransaction.mock.calls).toEqual([[pending, 2, '', true]]);
  expect(blockHashLookups()).toHaveLength(0);
});

test('a transaction the Electrum server cannot place keeps the node error', async () => {
  await expect(api.$getRawTransaction(unknown)).rejects.toMatchObject({
    code: -5,
    message: 'No such mempool transaction',
  });
  expect(node.getRawTransaction.mock.calls).toEqual([[unknown, 2, '', true]]);
  expect(blockHashLookups().map((request) => request.params)).toEqual([[unknown]]);
});

test('a not found answer that carries only the message is read again from the block', async () => {
  node.getRawTransaction.mockRejectedValueOnce(new Error('No such mempool or blockchain transaction'));
  const tx: any = await api.$getRawTransaction(funding);
  expect(tx.status.block_height).toBe(5);
  expect(node.getRawTransaction.mock.calls).toEqual([
    [funding, 2, '', true],
    [funding, 2, blockHash(5), true],
  ]);
});

test('the genesis coinbase is built from its block without an Electrum lookup', async () => {
  const message = 'The genesis block coinbase is not considered an ordinary transaction and cannot be retrieved';
  node.getRawTransaction.mockRejectedValueOnce(Object.assign(new Error(message), { code: -5 }));
  const genesis = jest.spyOn(api as any, '$returnCoinbaseTransaction').mockResolvedValue({ txid: 'genesis' });
  try {
    expect(await api.$getRawTransaction(unknown)).toEqual({ txid: 'genesis' });
    expect(node.getRawTransaction).toHaveBeenCalledTimes(1);
    expect(blockHashLookups()).toHaveLength(0);
  } finally {
    genesis.mockRestore();
  }
});

test.each([true, false])('a block hash the caller knows needs no Electrum lookup (txindex %s)', async (index) => {
  txindex = index;
  const tx: any = await api.$getRawTransaction(funding, false, false, false, blockHash(5));
  expect(tx.status.block_hash).toBe(blockHash(5));
  expect(node.getRawTransaction.mock.calls).toEqual(
    index
      ? [[funding, 2, '', true]]
      : [
          [funding, 2, '', true],
          [funding, 2, blockHash(5), true],
        ]
  );
  expect(blockHashLookups()).toHaveLength(0);
});

test.each([true, false])('outspend reads the spender from the node by its history row (txindex %s)', async (index) => {
  txindex = index;
  expect(await api.$getOutspend(funding, 0)).toEqual({ spent: true, txid: spending, vin: 0 });
  expect(node.getRawTransaction.mock.calls.filter(([txid]) => txid === spending)).toEqual(
    index
      ? [[spending, 1, '']]
      : [
          [spending, 1, ''],
          [spending, 1, blockHash(7)],
        ]
  );
  expect(requests.some((request) => request.method === 'blockchain.transaction.get')).toBe(false);
  // Only the bare txid of the spent transaction may need the Electrum server
  expect(blockHashLookups().map((request) => request.params)).toEqual(index ? [] : [[funding]]);
});
