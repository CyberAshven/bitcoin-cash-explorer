jest.mock('../../api/mempool', () => ({ __esModule: true, default: { getMempool: () => ({}) } }));
import blocks from '../../api/blocks';
import transactionUtils from '../../api/transaction-utils';
import bitcoinApi, { bitcoinCoreApi } from '../../api/bitcoin/bitcoin-api-factory';
import BitcoinApi from '../../api/bitcoin/bitcoin-api';

const hash = 'f'.repeat(64);
const extended = (txid: string, coinbase: boolean): any => ({ txid, vin: [{ is_coinbase: coinbase }] });

afterEach(() => jest.restoreAllMocks());

test.each([false, true])(
  'block transactions are read with the hash of their block (only coinbase %s)',
  async (only) => {
    const retry = jest
      .spyOn(transactionUtils, '$getTransactionExtendedRetry')
      .mockImplementation(async (txid) => extended(txid, txid === 'coinbase'));
    const txs = await (blocks as any).$getTransactionsExtended(hash, 5, 1, only, ['coinbase', 'spent'], true, true);
    expect(txs.map((tx) => tx.txid)).toEqual(only ? ['coinbase'] : ['coinbase', 'spent']);
    expect(retry.mock.calls).toEqual(
      (only ? ['coinbase'] : ['coinbase', 'spent']).map((txid) => [txid, false, false, false, true, hash])
    );
  }
);

test.each([false, true])('the known block hash reaches the node API (core %s)', async (core) => {
  const api = jest
    .spyOn(core ? bitcoinCoreApi : bitcoinApi, '$getRawTransaction')
    .mockResolvedValue({ txid: 'spent', status: { confirmed: true } } as any);
  await transactionUtils.$getTransactionExtended('spent', false, false, core, false, hash);
  expect(api).toHaveBeenCalledWith('spent', false, false, false, hash);
});

test('the coinbase of a block is read from that block by a node without a transaction index', async () => {
  const client = {
    getBlock: jest.fn(async () => ({ tx: ['coinbase'] })),
    getRawTransaction: jest.fn(async (txid: string, _verbosity: number, blockHash: string) => {
      if (blockHash !== hash) throw Object.assign(new Error('No such mempool transaction'), { code: -5 });
      return { txid, size: 100, vin: [{ coinbase: '0101' }], vout: [], confirmations: 1, blockhash: hash };
    }),
  };
  const coinbase = await new BitcoinApi(client).$getCoinbaseTx(hash);
  expect(coinbase.status.block_hash).toBe(hash);
  expect(client.getRawTransaction.mock.calls).toEqual([
    ['coinbase', 2, '', true],
    ['coinbase', 2, hash, true],
  ]);
});

test('a failed read retries on the core node with the same block hash', async () => {
  jest.spyOn(bitcoinApi, '$getRawTransaction').mockRejectedValue(new Error('backend failed'));
  const core = jest
    .spyOn(bitcoinCoreApi, '$getRawTransaction')
    .mockResolvedValue({ txid: 'spent', status: { confirmed: true } } as any);
  await transactionUtils.$getTransactionExtendedRetry('spent', false, false, false, false, hash);
  expect(core).toHaveBeenCalledWith('spent', false, false, false, hash);
});
