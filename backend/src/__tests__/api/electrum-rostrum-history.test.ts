jest.mock('@bitcoincash/electrum-client', () => {
  // Bypass the suite-wide package mock and Jest's ESM loader: Node 26 loads the actual installed client.
  const nativeModule = process.getBuiltinModule('node:module');
  const loader = new nativeModule.Module(__filename);
  return loader.require(require.resolve('@bitcoincash/electrum-client'));
});
jest.mock('../../api/blocks', () => ({ __esModule: true, default: { getBlocks: () => [] } }));
jest.mock('../../api/memory-cache', () => ({ __esModule: true, default: { get: () => undefined, set: () => {} } }));
jest.mock('../../api/bitcoin/bitcoin-api-factory', () => ({ __esModule: true, default: {}, bitcoinCoreApi: {} }));
import { createServer, Server, Socket, AddressInfo } from 'node:net';
import config from '../../config';
import BitcoindElectrsApi from '../../api/bitcoin/electrum-api';

const address = 'qrv4ytx9jweyy095v3rxxysrs2luz5kcrq50kljf27';
const blockHash = (height: number) => height.toString(16).padStart(64, '0');
let software = '';
let firstUse: unknown;
let server: Server;
let api: BitcoindElectrsApi | undefined;
const sockets = new Set<Socket>();
const requests: { method: string; params: any[] }[] = [];
const previous = { ...config.ELECTRUM };

// Rostrum 15 rejects positional get_history heights and wants a filter object; Fulcrum is the other way round.
function reply(request: { method: string; params: any[] }): { result?: unknown; error?: unknown } {
  const rostrum = software.startsWith('Rostrum');
  switch (request.method) {
    case 'server.version':
      return { result: [software, rostrum ? '1.4.3' : '1.6'] };
    case 'blockchain.scripthash.get_first_use':
      return firstUse === undefined
        ? { error: { code: -32004, message: `scripthash '${request.params[0]}' not found` } }
        : { result: firstUse };
    case 'blockchain.scripthash.get_history': {
      const filter = request.params[1];
      if (filter !== undefined && (typeof filter === 'object') !== rostrum) {
        return { error: { code: -32602, message: 'Invalid query filter parameter. Needs to be an object or string' } };
      }
      return { result: [{ tx_hash: 'a'.repeat(64), height: 5 }] };
    }
    case 'blockchain.scripthash.get_mempool':
      return { result: [] };
    default:
      return { error: { code: -32601, message: 'Unexpected method' } };
  }
}

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
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...reply(request) }) + '\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  Object.assign(config.ELECTRUM, {
    HOST: '127.0.0.1',
    PORT: (server.address() as AddressInfo).port,
    TLS_ENABLED: false,
  });
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  Object.assign(config.ELECTRUM, previous);
});
afterEach(() => {
  (api as any)?.electrumClient.close();
  (api as any)?.historyClient.close();
  for (const socket of sockets) socket.destroy();
  api = undefined;
});

async function connect(name: string): Promise<BitcoindElectrsApi> {
  software = name;
  firstUse = { height: 5, block_hash: blockHash(5), tx_hash: 'a'.repeat(64) };
  api = new BitcoindElectrsApi({
    validateAddress: async () => ({ isvalid: true, address, scriptPubKey: '51' }),
    getBestBlockHash: async () => blockHash(10),
    getBlockHash: async (height: number) => blockHash(height),
    getBlock: async (hash: string) => ({ hash, height: parseInt(hash, 16) }),
  });
  // The history client learns which server it talks to from its server.version handshake
  for (let i = 0; i < 200 && !(api as any).historyClient.versionInfo[0]; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect((api as any).historyClient.versionInfo[0]).toBe(name);
  requests.length = 0;
  return api;
}
const historyParams = () =>
  requests.filter((request) => request.method === 'blockchain.scripthash.get_history').map((r) => r.params.slice(1));

test.each([
  ['Fulcrum 2.1.4', [5, 11]],
  ['Rostrum 15.0.0', [{ from_height: 5, to_height: 11 }]],
])('paged history sends %s its heights in the form it takes', async (name, heights) => {
  const count = await (await connect(name)).$getAddressCount(address);
  expect(count).toMatchObject({ confirmedCount: 1, complete: true });
  expect(historyParams()).toEqual([heights]);
});

test.each([
  ['Fulcrum 2.1.4', [[0], []]],
  ['Rostrum 15.0.0', [[{ from_height: 0 }], []]],
])('history from a height, as the outspend search asks it, reaches %s in its form', async (name, heights) => {
  const electrum = (await connect(name)) as any;
  await electrum.$getScriptHashHistory('51', 0);
  await electrum.$getScriptHashHistory('51');
  expect(historyParams()).toEqual(heights);
});

test('an unused address on Rostrum completes as one without history', async () => {
  const rostrum = await connect('Rostrum 15.0.0');
  firstUse = undefined;
  expect(await rostrum.$getAddressCount(address)).toMatchObject({ confirmedCount: 0, complete: true, progress: 100 });
  expect(await rostrum.$getAddressPage(address)).toMatchObject({ transactions: [], complete: true });
  expect(historyParams()).toEqual([]);
});

test('a not found first use stays an error on Fulcrum', async () => {
  const fulcrum = await connect('Fulcrum 2.1.4');
  firstUse = undefined;
  await expect(fulcrum.$getAddressCount(address)).rejects.toBeTruthy();
});
