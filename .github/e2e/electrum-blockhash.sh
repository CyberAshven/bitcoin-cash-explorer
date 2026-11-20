#!/usr/bin/env bash
# Before/after evidence for BitcoinCash1/bitcoin-cash-explorer#13: confirmed transactions read with an
# Electrum backend from a BCHN regtest node that keeps no transaction index (txindex=0).
#
# Usage: electrum-blockhash.sh <fulcrum|rostrum> <before backend dir> <after backend dir> <results dir>
# Each backend dir holds a built backend (dist, node_modules, package.json, rust-gbt).
set -euo pipefail

SERVER=$1
BEFORE=$2
AFTER=$3
OUT=$4
WORK=${RUNNER_TEMP:-/tmp}/e2e-$SERVER
API=http://127.0.0.1:8999/api/v1
FAILED=0

rm -rf "$WORK"
mkdir -p "$WORK/bchn" "$OUT"
trap 'bitcoin-cli -regtest -datadir="$WORK/bchn" -rpcuser=e2e -rpcpassword=e2e stop >/dev/null 2>&1 || true; kill $(jobs -p) 2>/dev/null || true' EXIT

cli() { bitcoin-cli -regtest -datadir="$WORK/bchn" -rpcuser=e2e -rpcpassword=e2e "$@"; }

wait_for() { # <seconds> <what> <command...>
  local limit=$1 what=$2
  shift 2
  for _ in $(seq "$limit"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "Timed out after ${limit}s waiting for $what" >&2
  return 1
}

electrum() { # <method> [JSON params]
  python3 - "$ELECTRUM_PORT" "$1" "${2:-[]}" <<'PY'
import json, socket, sys
port, method, params = int(sys.argv[1]), sys.argv[2], json.loads(sys.argv[3])
with socket.create_connection(('127.0.0.1', port), timeout=10) as s:
    f = s.makefile('rw')
    if method != 'server.version':
        f.write(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'server.version', 'params': ['e2e', '1.4']}) + '\n')
    f.write(json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': method, 'params': params}) + '\n')
    f.flush()
    for line in f:
        reply = json.loads(line)
        if reply.get('id') == 2:
            print(json.dumps(reply))
            break
PY
}

dec() { python3 -c 'import sys; from decimal import Decimal as D; print(D(sys.argv[1]) - D(sys.argv[2]))' "$1" "$2"; }

# --- BCHN regtest without a transaction index -------------------------------------------------------------
bitcoind -regtest -datadir="$WORK/bchn" -daemon -server -txindex=0 -expire=0 \
  -rpcuser=e2e -rpcpassword=e2e -fallbackfee=0.00001 -whitelist=127.0.0.1
wait_for 60 "BCHN RPC" cli getblockcount
cli getwalletinfo >/dev/null 2>&1 || cli createwallet e2e >/dev/null
MINER=$(cli getnewaddress)
X=$(cli getnewaddress)
Y=$(cli getnewaddress)
Z=$(cli getnewaddress)
W=$(cli getnewaddress)
cli generatetoaddress 101 "$MINER" >/dev/null

# T1 pays X and Y from a mature coinbase; T2 spends both outputs, so no output of T1 stays unspent.
COIN=$(cli listunspent 100 | jq -c 'map(select(.spendable)) | sort_by(-.confirmations) | .[0]')
AMOUNT=$(jq -r .amount <<<"$COIN")
RAW1=$(cli createrawtransaction "[{\"txid\":$(jq .txid <<<"$COIN"),\"vout\":$(jq .vout <<<"$COIN")}]" \
  "{\"$X\":10,\"$Y\":$(dec "$AMOUNT" 10.0001)}")
SIGNED1=$(cli signrawtransactionwithwallet "$RAW1" | jq -r .hex)
X_VOUT=$(cli decoderawtransaction "$SIGNED1" | jq --arg a "$X" '.vout[] | select(.scriptPubKey.addresses[0] == $a) | .n')
T1=$(cli sendrawtransaction "$SIGNED1")
cli generatetoaddress 1 "$MINER" >/dev/null
H1=$(cli getblockcount)
B1=$(cli getblockhash "$H1")

RAW2=$(cli createrawtransaction "[{\"txid\":\"$T1\",\"vout\":0},{\"txid\":\"$T1\",\"vout\":1}]" \
  "{\"$Z\":$(dec "$AMOUNT" 0.0002)}")
T2=$(cli sendrawtransaction "$(cli signrawtransactionwithwallet "$RAW2" | jq -r .hex)")
cli generatetoaddress 1 "$MINER" >/dev/null
H2=$(cli getblockcount)
cli generatetoaddress 2 "$MINER" >/dev/null
M=$(cli sendtoaddress "$W" 1)
TIP=$(cli getblockcount)

{
  echo "BCHN $(cli getnetworkinfo | jq -r .subversion), tip $TIP"
  echo "T1 $T1 (block $H1 $B1, fully spent, pays X at vout $X_VOUT)"
  echo "T2 $T2 (block $H2, spends both outputs of T1, pays Z)"
  echo "M  $M (mempool)"
  echo "X $X"
  echo "Z $Z"
  echo "getrawtransaction T1 without a block hash: $(cli getrawtransaction "$T1" 1 2>&1 | head -c 200 | tr '\n' ' ')"
  echo "getrawtransaction T1 with its block hash: $(cli getrawtransaction "$T1" 1 "$B1" | jq -c '{txid, blockhash, confirmations}')"
} | tee "$OUT/$SERVER-chain.txt"

# --- Electrum server ----------------------------------------------------------------------------------------
case $SERVER in
  fulcrum)
    ELECTRUM_PORT=50001
    mkdir -p "$WORK/fulcrum"
    cat >"$WORK/fulcrum.conf" <<EOF
datadir = $WORK/fulcrum
bitcoind = 127.0.0.1:18443
rpcuser = e2e
rpcpassword = e2e
tcp = 127.0.0.1:$ELECTRUM_PORT
peering = false
announce = false
polltime = 1.0
EOF
    Fulcrum "$WORK/fulcrum.conf" >"$OUT/$SERVER-server.log" 2>&1 &
    ;;
  rostrum)
    ELECTRUM_PORT=60401
    rostrum --network regtest --db-dir "$WORK/rostrum" --auth e2e:e2e \
      --electrum-rpc-addr "127.0.0.1:$ELECTRUM_PORT" -vv >"$OUT/$SERVER-server.log" 2>&1 &
    ;;
  *)
    echo "Unknown Electrum server $SERVER" >&2
    exit 2
    ;;
esac
electrum_at_tip() { electrum blockchain.headers.subscribe | jq -e ".result.height == $TIP"; }
wait_for 300 "$SERVER at height $TIP" electrum_at_tip
{
  echo "$SERVER server.version: $(electrum server.version '["e2e", "1.4"]' | jq -c .result)"
  echo "$SERVER get_confirmed_blockhash T1: $(electrum blockchain.transaction.get_confirmed_blockhash "[\"$T1\"]" | jq -c '.result // .error')"
  echo "$SERVER get_confirmed_blockhash M: $(electrum blockchain.transaction.get_confirmed_blockhash "[\"$M\"]" | jq -c '.result // .error')"
} | tee -a "$OUT/$SERVER-chain.txt"

# --- Explorer backend, before and after ---------------------------------------------------------------------
check() { # <side> <name> <API path> <jq condition on a 200 reply> [optional]
  local side=$1 name=$2 path=$3 filter=$4 required=${5:-required}
  local body="$OUT/$SERVER-$side-${name// /_}.json" status verdict
  status=$(curl -s -o "$body" -w '%{http_code}' "$API/$path")
  if [ "$status" = 200 ] && jq -e --arg T1 "$T1" --arg T2 "$T2" --arg M "$M" --arg B1 "$B1" \
    --argjson H1 "$H1" --argjson H2 "$H2" "$filter" "$body" >/dev/null 2>&1; then
    verdict=ok
  elif [ "$status" = 200 ]; then
    verdict="wrong data"
  else
    verdict=$(head -c 100 "$body" | tr '\n\t|' '   ')
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$SERVER" "$side" "$name" "$status" "$verdict" >>"$OUT/results.tsv"
  echo "[$SERVER $side] $name: $status $verdict"
  if [ "$side" = after ] && [ "$required" = required ] && [ "$verdict" != ok ]; then FAILED=1; fi
}

run_side() { # <side> <backend dir>
  local side=$1 dir=$2 pid tip
  cat >"$WORK/explorer-$side.json" <<EOF
{
  "EXPLORER": {
    "NETWORK": "chipnet",
    "BACKEND": "electrum",
    "HTTP_PORT": 8999,
    "CACHE_ENABLED": false,
    "POLL_RATE_MS": 1000,
    "INDEXING_BLOCKS_AMOUNT": 0,
    "POOLS_JSON_URL": "http://127.0.0.1:9/pools-v2.json",
    "POOLS_JSON_TREE_URL": "http://127.0.0.1:9/tree"
  },
  "CORE_RPC": { "HOST": "127.0.0.1", "PORT": 18443, "USERNAME": "e2e", "PASSWORD": "e2e" },
  "ELECTRUM": { "HOST": "127.0.0.1", "PORT": $ELECTRUM_PORT, "TLS_ENABLED": false },
  "DATABASE": { "ENABLED": false },
  "SYSLOG": { "ENABLED": false },
  "STATISTICS": { "ENABLED": false },
  "FIAT_PRICE": { "ENABLED": false }
}
EOF
  (cd "$dir" && EXPLORER_CONFIG_FILE="$WORK/explorer-$side.json" exec node dist/index.js) \
    >"$OUT/$SERVER-$side-backend.log" 2>&1 &
  pid=$!
  wait_for 120 "backend $side" curl -sf "$API/backend-info"
  # A block is processed only once the backend can read its transactions, coinbase included.
  backend_at_tip() { [ "$(curl -s "$API/blocks/tip/height")" = "$TIP" ]; }
  wait_for 90 "backend $side at height $TIP" backend_at_tip || true
  tip=$(curl -s "$API/blocks/tip/height" | head -c 60)
  printf '%s\t%s\t%s\t%s\t%s\n' "$SERVER" "$side" "block processing" "-" \
    "$([ "$tip" = "$TIP" ] && echo "at tip $TIP" || echo "not at tip $TIP: $tip")" >>"$OUT/results.tsv"
  [ "$tip" = "$TIP" ] || { [ "$side" = before ] || FAILED=1; }

  local x=${X#*:} z=${Z#*:}
  check "$side" "tx (fully spent)" "tx/$T1" \
    '.txid == $T1 and .status.confirmed and .status.block_height == $H1 and .status.block_hash == $B1 and .fee == 10000 and (.vout | length) == 2'
  check "$side" "tx (unspent output)" "tx/$T2" \
    '.txid == $T2 and .status.confirmed and .status.block_height == $H2 and .fee == 10000'
  check "$side" "tx (mempool)" "tx/$M" '.txid == $M and (.status.confirmed | not)'
  check "$side" "outspends" "tx/$T1/outspends" '. == [{"spent": true}, {"spent": true}]'
  check "$side" "merkle proof" "tx/$T1/merkle-proof" \
    '.block_height == $H1 and (.merkle | type) == "array" and (.pos | type) == "number"'
  check "$side" "address txs" "address/$x/txs" '[.[].txid] == [$T2, $T1]'
  # Rostrum takes get_history heights as a filter object, not as the positional from/to the paged route sends.
  check "$side" "address transactions (paged)" "address/$x/transactions" \
    '[.transactions[].txid] == [$T2, $T1] and .complete' "$([ "$SERVER" = rostrum ] && echo optional || echo required)"
  check "$side" "address utxo" "address/$z/utxo" \
    'length == 1 and .[0].txid == $T2 and .[0].status.confirmed and .[0].status.block_height == $H2'

  kill "$pid"
  wait "$pid" 2>/dev/null || true
  wait_for 30 "port 8999 to close" bash -c '! curl -s -o /dev/null http://127.0.0.1:8999/'
}

run_side before "$BEFORE"
run_side after "$AFTER"
exit "$FAILED"
