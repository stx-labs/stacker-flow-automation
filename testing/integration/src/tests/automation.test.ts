import { StacksDevnet } from '@stacks/network';
import { startRegtestEnv, stopRegtestEnv, withRetry } from '../utils';
import axios from 'axios';
import {
  getAccount,
  rewardCycleToBurnHeight,
  waitForBurnBlockHeight,
  waitForCycle,
  waitForNextCycle,
  waitForNode,
} from '../helpers';
import { PoxInfo, StackingClient } from '@stacks/stacking';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

jest.setTimeout(1_000_000_000);

let appProcess: any;

function startApp(command: string, args: string[], options: any = {}): void {
  const process = spawn(command, args, options);

  process.stdout.on('data', data => {
    console.log(`stdout: ${data}`);
  });

  process.stderr.on('data', data => {
    console.error(`stderr: ${data}`);
  });

  appProcess = process;
}

function stopAppProcess() {
  if (appProcess) {
    appProcess.kill();
    appProcess = null;
  }
}

const updateEnvValue = (filePath: string, key: string, newValue: string) => {
  const envPath = path.resolve(filePath);

  const envContents = fs.readFileSync(envPath, 'utf-8');
  const envConfig = dotenv.parse(envContents);

  envConfig[key] = newValue;

  const newEnvContents = Object.entries(envConfig)
    .map(([envKey, envValue]) => `${envKey}="${envValue}"`)
    .join('\n');

  fs.writeFileSync(envPath, newEnvContents, 'utf-8');
};

interface MyTransaction {
  sender_address: string;
  function_name: string;
  function_args: { [key: string]: string };
}
interface FunctionArg {
  hex: string;
  repr: string;
  name: string;
  type: string;
}
interface ContractCall {
  contract_id: string;
  function_name: string;
  function_args: FunctionArg[];
}
interface ApiTransaction {
  sender_address: string;
  tx_status: string;
  contract_call: ContractCall;
  tx_type: string;
}

const fetchApiTransactions = async (blockHeight: number): Promise<ApiTransaction[]> =>
  await axios
    .get(`http://localhost:3999/extended/v2/blocks/${blockHeight}/transactions`)
    .then(res => res.data.results);

function transactionsMatch(tx1: MyTransaction, tx2: ApiTransaction): boolean {
  if (tx1.sender_address !== tx2.sender_address) return false;
  if (tx1.function_name !== tx2.contract_call.function_name) return false;

  const tx1ArgsValues = Object.values(tx1.function_args);

  const tx2ArgsValues = tx2.contract_call.function_args.map(arg => arg.repr);

  for (const value of tx1ArgsValues) {
    if (!tx2ArgsValues.includes(value)) return false;
  }

  return true;
}

async function filterMyTransactions(
  myTransactions: MyTransaction[],
  blockHeight: number
): Promise<{ filteredApiTxs: ApiTransaction[]; filteredExpectedTxs: MyTransaction[] }> {
  const apiTransactions = await fetchApiTransactions(blockHeight);

  const contractCallTxs = apiTransactions.filter(
    tx =>
      tx.tx_type === 'contract_call' &&
      tx.contract_call.function_name !== 'stack-extend' &&
      tx.contract_call.function_name !== 'stack-stx' &&
      tx.contract_call.function_name !== 'stack-increase' &&
      tx.contract_call.contract_id === 'ST000000000000000000002AMW42H.pox-4' &&
      tx.tx_status === 'success'
  );

  const filteredExpectedTxs: MyTransaction[] = [];
  const filteredApiTxs: ApiTransaction[] = [];

  for (const myTx of myTransactions) {
    let matchFound = false;
    for (let i = 0; i < contractCallTxs.length; i++) {
      if (transactionsMatch(myTx, contractCallTxs[i])) {
        matchFound = true;
        contractCallTxs.splice(i, 1);
        break;
      }
    }
    if (!matchFound) {
      filteredExpectedTxs.push(myTx);
    }
  }

  filteredApiTxs.push(...contractCallTxs);

  return { filteredApiTxs, filteredExpectedTxs };
}

describe('Stacks transactions', () => {
  const network = new StacksDevnet({ fetchFn: withRetry(3, fetch) });
  let client: StackingClient;
  const stackerKeys = [
    'f9d7206a47f14d2870c163ebab4bf3e70d18f5d14ce1031f3902fbbc894fe4c701',
    '21d43d2ae0da1d9d04cfcaac7d397a33733881081f0b2cd038062cf0ccbb752601',
    '66b7a77a3e0abc2cddaa51ed38fc4553498e19d3620ef08eb141afcfd0e3f5b501',
    '5b8303150239eceaba43892af7cdd1fa7fc26eda5182ebaaa568e3341d54a4d001',
    'c71700b07d520a8c9731e4d0f095aa6efb91e16e25fb27ce2b72e7b698f8127a01',
    '975b251dd7809469ef0c26ec3917971b75c51cd73a022024df4bf3b232cc2dc001',
    '0d2f965b472a82efd5a96e6513c8b9f7edc725d5c96c7d35d6c722cedeb80d1b01',
  ];
  const pool = getAccount(stackerKeys[0]);
  const alice = getAccount(stackerKeys[1]);
  const bob = getAccount(stackerKeys[2]);
  const charlie = getAccount(stackerKeys[3]);
  const dave = getAccount(stackerKeys[4]);
  const erin = getAccount(stackerKeys[5]);
  const frank = getAccount(stackerKeys[6]);
  const envFilePath = '../../backend/.env';
  const keyToUpdate = 'MAX_CYCLES_FOR_OPERATIONS';
  let expectedTxs: MyTransaction[] = [];
  let poxInfo: PoxInfo;

  const expectedDelegateStx = (amount: number, principal: string) => {
    return {
      sender_address: principal,
      function_name: 'delegate-stx',
      function_args: { uint: `u${amount}`, principal: `'${pool.address}` },
    };
  };

  const expectedRevokeDelegateStx = (principal: string) => {
    return {
      sender_address: principal,
      function_name: 'revoke-delegate-stx',
      function_args: {},
    };
  };

  const expectedDelegateStackStx = (amount: number, principal: string) => {
    return {
      sender_address: pool.address,
      function_name: 'delegate-stack-stx',
      function_args: {
        uint: `u${amount}`,
        principal: `'${principal}`,
      },
    };
  };

  const expectedDelegateStackExtend = (numCycles: number, principal: string) => {
    return {
      sender_address: pool.address,
      function_name: 'delegate-stack-extend',
      function_args: { uint: `u${numCycles}`, principal: `'${principal}` },
    };
  };

  const expectedDelegateStackIncrease = (amount: number, principal: string) => {
    return {
      sender_address: pool.address,
      function_name: 'delegate-stack-increase',
      function_args: {
        uint: `u${amount}`,
        principal: `'${principal}`,
      },
    };
  };

  const expectedAggCommit = (cycle: number) => {
    return {
      sender_address: pool.address,
      function_name: 'stack-aggregation-commit-indexed',
      function_args: { uint: `u${cycle}` },
    };
  };

  const expectedAggIncrease = (cycle: number) => {
    return {
      sender_address: pool.address,
      function_name: 'stack-aggregation-increase',
      function_args: { uint: `u${cycle}` },
    };
  };

  beforeEach(async () => {
    await startRegtestEnv();
    await waitForNode();
    try {
      startApp('npm', ['run', 'start'], { cwd: '../../backend' });
    } catch (error) {
      console.error('Failed to run command:', error);
    }

    client = new StackingClient('', network);
  });

  afterEach(async () => {
    stopAppProcess();
    await stopRegtestEnv();
  });

  test('automation for MAX_CYCLES_FOR_OPERATIONS = 2', async () => {
    updateEnvValue(envFilePath, keyToUpdate, '2');

    poxInfo = await client.getPoxInfo();

    await waitForCycle(poxInfo, 7);

    poxInfo = await client.getPoxInfo();

    // TEST DELEGATE STX

    await client.delegateStx({
      amountMicroStx: 2_000_000_000_000_000,
      delegateTo: pool.address,
      poxAddress: pool.btcAddress,
      privateKey: alice.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(10, poxInfo),
    });

    await client.delegateStx({
      amountMicroStx: 1_500_000_000_000_000,
      delegateTo: pool.address,
      poxAddress: pool.btcAddress,
      privateKey: bob.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(12, poxInfo),
    });

    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 10);

    const resultBeforeExtend = await axios.get('http://localhost:8080/data');

    const delegations = resultBeforeExtend.data.delegations;

    const expectedDelegationDel = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 10,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 12,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];
    delegations.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedDelegationDel.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(delegations).toEqual(expectedDelegationDel);

    const acceptedDelegations = resultBeforeExtend.data.acceptedDelegations;

    const expectedAcceptedDelegationsDel = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 10,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 10,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];
    acceptedDelegations.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsDel.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(acceptedDelegations).toEqual(expectedAcceptedDelegationsDel);

    const committedDelegations = resultBeforeExtend.data.committedDelegations;

    const expectedCommitedDelDel = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegations.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelDel.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegations).toEqual(expectedCommitedDelDel);

    // CHECK BLOCKS

    expectedTxs.push(expectedDelegateStx(1_500_000_000_000_000, bob.address));
    expectedTxs.push(expectedDelegateStackStx(1_500_000_000_000_000, bob.address));

    expectedTxs.push(expectedDelegateStx(2_000_000_000_000_000, alice.address));
    expectedTxs.push(expectedDelegateStackStx(2_000_000_000_000_000, alice.address));

    for (let i = 8; i <= 9; i++) expectedTxs.push(expectedAggCommit(i));

    //TODO:
    // rename for all filteredMyTransactions to filteredExpectedTxs
    // rename for all currentFilteredMyTransactions to remainingFilteredExpectedTxs
    // rename from Transactions to Txs
    // rename from Transaction to Tx

    let filteredExpectedTxs = [...expectedTxs];

    // stacks block height 1 is anchored in burn block height 101. we need to check transactions
    // on stacks blocks so we start from height 38 (theoretically burn height 140)
    for (let height = 38; height < 48; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);
      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);

    // TEST IF DELEGATION IS EXTENDED IF POSSIBLE

    poxInfo = await client.getPoxInfo();

    await waitForCycle(poxInfo, 8);

    poxInfo = await client.getPoxInfo();

    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 5);

    const resultAfterExtend = await axios.get('http://localhost:8080/data');

    const acceptedDelegationsAfter = resultAfterExtend.data.acceptedDelegations;

    const expectedAcceptedDelegationsExt = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 10,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 11,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];
    acceptedDelegationsAfter.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsExt.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(acceptedDelegationsAfter).toEqual(expectedAcceptedDelegationsExt);

    const committedDelegationsAfter = resultAfterExtend.data.committedDelegations;

    const expectedCommitedDelAfter = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 1_500_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegationsAfter.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelAfter.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegationsAfter).toEqual(expectedCommitedDelAfter);

    // CHECK BLOCKS

    expectedTxs = filteredExpectedTxs;

    expectedTxs.push(expectedDelegateStackExtend(1, bob.address));
    expectedTxs.push(expectedAggCommit(10));

    filteredExpectedTxs = [...expectedTxs];

    for (let height = 58; height < 63; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);
      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);

    // TEST INCREASE
    poxInfo = await client.getPoxInfo();

    // cycle 9
    await waitForNextCycle(poxInfo);

    await client.revokeDelegateStx(bob.key);

    poxInfo = await client.getPoxInfo();
    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 2);

    await client.delegateStx({
      amountMicroStx: 4_000_000_000_000_000,
      delegateTo: pool.address,
      poxAddress: pool.btcAddress,
      privateKey: bob.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(14, poxInfo),
    });

    await client.delegateStx({
      amountMicroStx: 5_000_000_000_000_000,
      delegateTo: pool.address,
      privateKey: charlie.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(11, poxInfo),
    });

    poxInfo = await client.getPoxInfo();
    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 10);

    const resultIncrease = await axios.get('http://localhost:8080/data');

    const delegationsIncrease = resultIncrease.data.delegations;

    const expectedDelegationIncrease = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 10,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 10,
        end_cycle: 11,
        pox_address: null,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 10,
        end_cycle: 14,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
    ];
    delegationsIncrease.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedDelegationIncrease.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(delegationsIncrease).toEqual(expectedDelegationIncrease);

    const previousDelegeationsIncrease = resultIncrease.data.previousDelegations;

    const expectedPreviousDelegationsIncrease = [
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 12,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];

    expect(previousDelegeationsIncrease).toEqual(expectedPreviousDelegationsIncrease);

    const acceptedDelegationsIncrease = resultIncrease.data.acceptedDelegations;

    const expectedAcceptedDelegationsIncrease = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 10,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 10,
        end_cycle: 11,
        pox_address: pool.btcAddress,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 10,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 10,
        end_cycle: 12,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
    ];
    acceptedDelegationsIncrease.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsIncrease.sort((a: any, b: any) =>
      a.stacker.localeCompare(b.stacker)
    );

    expect(acceptedDelegationsIncrease).toEqual(expectedAcceptedDelegationsIncrease);

    const committedDelegationsIncrease = resultIncrease.data.committedDelegations;

    const expectedCommitedDelIncrease = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx: 4_000_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegationsIncrease.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelIncrease.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegationsIncrease).toEqual(expectedCommitedDelIncrease);

    // CHECK BLOCKS

    expectedTxs = filteredExpectedTxs;

    expectedTxs.push(expectedRevokeDelegateStx(bob.address));
    expectedTxs.push(expectedDelegateStx(4_000_000_000_000_000, bob.address));
    expectedTxs.push(
      expectedDelegateStackIncrease(4_000_000_000_000_000 - 1_500_000_000_000_000, bob.address)
    );
    expectedTxs.push(expectedDelegateStackExtend(1, bob.address));

    expectedTxs.push(expectedDelegateStx(5_000_000_000_000_000, charlie.address));
    expectedTxs.push(expectedDelegateStackStx(5_000_000_000_000_000, charlie.address));

    expectedTxs.push(expectedAggIncrease(10));
    expectedTxs.push(expectedAggCommit(11));

    filteredExpectedTxs = [...expectedTxs];
    for (let height = 78; height < 88; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);

      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);

    await waitForCycle(poxInfo, 14);

    poxInfo = await client.getPoxInfo();

    const resultEnd = await axios.get('http://localhost:8080/data');

    const delegationsEnd = resultEnd.data.delegations;

    const expectedDelegationEnd = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 10,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 10,
        end_cycle: 11,
        pox_address: null,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 10,
        end_cycle: 14,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
    ];
    delegationsEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedDelegationEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(delegationsEnd).toEqual(expectedDelegationEnd);

    const previousDelegeationsEnd = resultEnd.data.previousDelegations;

    const expectedPreviousDelegationsEnd = [
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 12,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];

    expect(previousDelegeationsEnd).toEqual(expectedPreviousDelegationsEnd);

    const acceptedDelegationsEnd = resultEnd.data.acceptedDelegations;

    const expectedAcceptedDelegationsEnd = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 10,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 10,
        end_cycle: 11,
        pox_address: pool.btcAddress,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 10,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 10,
        end_cycle: 14,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
    ];
    acceptedDelegationsEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(acceptedDelegationsEnd).toEqual(expectedAcceptedDelegationsEnd);

    const committedDelegationsEnd = resultEnd.data.committedDelegations;

    const expectedCommitedDelEnd = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx: 4_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 12,
        end_cycle: 13,
        amount_ustx: 4_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 13,
        end_cycle: 14,
        amount_ustx: 4_000_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegationsEnd.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelEnd.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegationsEnd).toEqual(expectedCommitedDelEnd);

    // CHECK BLOCKS

    expectedTxs = filteredExpectedTxs;

    for (let i = 1; i <= 2; i++) expectedTxs.push(expectedDelegateStackExtend(1, bob.address));
    for (let i = 12; i <= 13; i++) expectedTxs.push(expectedAggCommit(i));

    filteredExpectedTxs = [...expectedTxs];

    for (let height = 88; height < 178; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);
      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);
    expectedTxs = filteredExpectedTxs;
  });

  test('automation for MAX_CYCLES_FOR_OPERATIONS = 12', async () => {
    updateEnvValue(envFilePath, keyToUpdate, '12');

    poxInfo = await client.getPoxInfo();

    await waitForCycle(poxInfo, 7);

    poxInfo = await client.getPoxInfo();

    // TEST DELEGATE STX

    await client.delegateStx({
      amountMicroStx: 2_000_000_000_000_000,
      delegateTo: pool.address,
      poxAddress: pool.btcAddress,
      privateKey: alice.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(20, poxInfo),
    });

    expectedTxs.push(expectedDelegateStx(2_000_000_000_000_000, alice.address));
    expectedTxs.push(expectedDelegateStackStx(2_000_000_000_000_000, alice.address));

    await client.delegateStx({
      amountMicroStx: 1_500_000_000_000_000,
      delegateTo: pool.address,
      poxAddress: pool.btcAddress,
      privateKey: bob.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(21, poxInfo),
    });

    expectedTxs.push(expectedDelegateStx(1_500_000_000_000_000, bob.address));
    expectedTxs.push(expectedDelegateStackStx(1_500_000_000_000_000, bob.address));
    for (let i = 8; i <= 19; i++) expectedTxs.push(expectedAggCommit(i));

    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 10);

    // CHECK BLOCKS

    let filteredExpectedTxs = [...expectedTxs];

    for (let height = 38; height < 48; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);
      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);

    const resultBeforeExtend = await axios.get('http://localhost:8080/data');

    const delegations = resultBeforeExtend.data.delegations;

    const expectedDelegationDel = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 20,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 21,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];
    delegations.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedDelegationDel.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(delegations).toEqual(expectedDelegationDel);

    const acceptedDelegations = resultBeforeExtend.data.acceptedDelegations;

    const expectedAcceptedDelegationsDel = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 20,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 20,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];
    acceptedDelegations.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsDel.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(acceptedDelegations).toEqual(expectedAcceptedDelegationsDel);

    const committedDelegations = resultBeforeExtend.data.committedDelegations;

    const expectedCommitedDelDel = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 12,
        end_cycle: 13,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 13,
        end_cycle: 14,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 14,
        end_cycle: 15,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 15,
        end_cycle: 16,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 16,
        end_cycle: 17,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 17,
        end_cycle: 18,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 18,
        end_cycle: 19,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 19,
        end_cycle: 20,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegations.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelDel.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegations).toEqual(expectedCommitedDelDel);

    // TEST IF DELEGATION IS EXTENDED IF POSSIBLE

    poxInfo = await client.getPoxInfo();

    await waitForCycle(poxInfo, 9);

    poxInfo = await client.getPoxInfo();

    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 5);

    // CHECK BLOCKS

    const resultAfterExtend = await axios.get('http://localhost:8080/data');

    const acceptedDelegationsAfter = resultAfterExtend.data.acceptedDelegations;

    const expectedAcceptedDelegationsExt = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 20,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 21,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];
    acceptedDelegationsAfter.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsExt.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(acceptedDelegationsAfter).toEqual(expectedAcceptedDelegationsExt);

    const committedDelegationsAfter = resultAfterExtend.data.committedDelegations;

    const expectedCommitedDelAfter = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 12,
        end_cycle: 13,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 13,
        end_cycle: 14,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 14,
        end_cycle: 15,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 15,
        end_cycle: 16,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 16,
        end_cycle: 17,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 17,
        end_cycle: 18,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 18,
        end_cycle: 19,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 19,
        end_cycle: 20,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 20,
        end_cycle: 21,
        amount_ustx: 1_500_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegationsAfter.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelAfter.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegationsAfter).toEqual(expectedCommitedDelAfter);

    expectedTxs = filteredExpectedTxs;
    expectedTxs.push(expectedDelegateStackExtend(1, bob.address));
    expectedTxs.push(expectedAggCommit(20));
    filteredExpectedTxs = [...expectedTxs];

    for (let height = 48; height < 83; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);
      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);

    // TEST INCREASE
    poxInfo = await client.getPoxInfo();

    // cycle 10
    await waitForNextCycle(poxInfo);

    await client.revokeDelegateStx(bob.key);

    poxInfo = await client.getPoxInfo();
    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 2);

    await client.delegateStx({
      amountMicroStx: 4_000_000_000_000_000,
      delegateTo: pool.address,
      poxAddress: pool.btcAddress,
      privateKey: bob.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(25, poxInfo),
    });

    await client.delegateStx({
      amountMicroStx: 5_000_000_000_000_000,
      delegateTo: pool.address,
      privateKey: charlie.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(19, poxInfo),
    });

    poxInfo = await client.getPoxInfo();
    await waitForNextCycle(poxInfo);

    // CHECK BLOCKS

    const resultIncrease = await axios.get('http://localhost:8080/data');

    const delegationsIncrease = resultIncrease.data.delegations;

    const expectedDelegationIncrease = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 20,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 11,
        end_cycle: 19,
        pox_address: null,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 11,
        end_cycle: 25,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
    ];
    delegationsIncrease.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedDelegationIncrease.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(delegationsIncrease).toEqual(expectedDelegationIncrease);

    const previousDelegeationsIncrease = resultIncrease.data.previousDelegations;

    const expectedPreviousDelegationsIncrease = [
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 21,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];

    expect(previousDelegeationsIncrease).toEqual(expectedPreviousDelegationsIncrease);

    const acceptedDelegationsIncrease = resultIncrease.data.acceptedDelegations;

    const expectedAcceptedDelegationsIncrease = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 20,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 11,
        end_cycle: 19,
        pox_address: pool.btcAddress,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 11,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 11,
        end_cycle: 22,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
    ];
    acceptedDelegationsIncrease.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsIncrease.sort((a: any, b: any) =>
      a.stacker.localeCompare(b.stacker)
    );

    expect(acceptedDelegationsIncrease).toEqual(expectedAcceptedDelegationsIncrease);

    const committedDelegationsIncrease = resultIncrease.data.committedDelegations;

    const expectedCommitedDelIncrease = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 12,
        end_cycle: 13,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 13,
        end_cycle: 14,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 14,
        end_cycle: 15,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 15,
        end_cycle: 16,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 16,
        end_cycle: 17,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 17,
        end_cycle: 18,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 18,
        end_cycle: 19,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 19,
        end_cycle: 20,
        amount_ustx: 4_000_000_000_000_000 + 2_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 20,
        end_cycle: 21,
        amount_ustx: 4_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 21,
        end_cycle: 22,
        amount_ustx: 4_000_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegationsIncrease.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelIncrease.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegationsIncrease).toEqual(expectedCommitedDelIncrease);

    expectedTxs = filteredExpectedTxs;
    expectedTxs.push(expectedRevokeDelegateStx(bob.address));
    expectedTxs.push(expectedDelegateStx(4_000_000_000_000_000, bob.address));
    expectedTxs.push(
      expectedDelegateStackIncrease(4_000_000_000_000_000 - 1_500_000_000_000_000, bob.address)
    );

    expectedTxs.push(expectedDelegateStx(5_000_000_000_000_000, charlie.address));
    expectedTxs.push(expectedDelegateStackStx(5_000_000_000_000_000, charlie.address));

    expectedTxs.push(expectedDelegateStackExtend(1, bob.address));

    for (let i = 11; i <= 20; i++) expectedTxs.push(expectedAggIncrease(i));
    expectedTxs.push(expectedAggCommit(21));
    filteredExpectedTxs = [...expectedTxs];
    for (let height = 83; height < 108; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);
      console.log(filteredApiTxs);

      expect(filteredApiTxs.length).toEqual(0);

      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    console.log(filteredExpectedTxs);

    expect(filteredExpectedTxs.length).toEqual(0);

    await waitForCycle(poxInfo, 25);

    poxInfo = await client.getPoxInfo();

    const resultEnd = await axios.get('http://localhost:8080/data');

    const delegationsEnd = resultEnd.data.delegations;

    const expectedDelegationEnd = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 20,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 11,
        end_cycle: 19,
        pox_address: null,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 11,
        end_cycle: 25,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
    ];
    delegationsEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedDelegationEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(delegationsEnd).toEqual(expectedDelegationEnd);

    const previousDelegeationsEnd = resultEnd.data.previousDelegations;

    const expectedPreviousDelegationsEnd = [
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 21,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];

    expect(previousDelegeationsEnd).toEqual(expectedPreviousDelegationsEnd);

    const acceptedDelegationsEnd = resultEnd.data.acceptedDelegations;

    const expectedAcceptedDelegationsEnd = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 20,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 11,
        end_cycle: 19,
        pox_address: pool.btcAddress,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 11,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 11,
        end_cycle: 25,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
    ];
    acceptedDelegationsEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(acceptedDelegationsEnd).toEqual(expectedAcceptedDelegationsEnd);

    const committedDelegationsEnd = resultEnd.data.committedDelegations;

    const expectedCommitedDelEnd = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 12,
        end_cycle: 13,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 13,
        end_cycle: 14,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 14,
        end_cycle: 15,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 15,
        end_cycle: 16,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 16,
        end_cycle: 17,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 17,
        end_cycle: 18,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 18,
        end_cycle: 19,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 19,
        end_cycle: 20,
        amount_ustx: 4_000_000_000_000_000 + 2_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 20,
        end_cycle: 21,
        amount_ustx: 4_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 21,
        end_cycle: 22,
        amount_ustx: 4_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 22,
        end_cycle: 23,
        amount_ustx: 4_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 23,
        end_cycle: 24,
        amount_ustx: 4_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 24,
        end_cycle: 25,
        amount_ustx: 4_000_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegationsEnd.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelEnd.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegationsEnd).toEqual(expectedCommitedDelEnd);

    expectedTxs = filteredExpectedTxs;
    for (let i = 1; i <= 3; i++) expectedTxs.push(expectedDelegateStackExtend(1, bob.address));

    for (let i = 22; i <= 24; i++) expectedTxs.push(expectedAggCommit(i));
    filteredExpectedTxs = [...expectedTxs];

    for (let height = 108; height < 398; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);
      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);
    expectedTxs = filteredExpectedTxs;
  });

  test('automation for MAX_CYCLES_FOR_OPERATIONS = 1', async () => {
    updateEnvValue(envFilePath, keyToUpdate, '1');

    poxInfo = await client.getPoxInfo();

    await waitForCycle(poxInfo, 7);

    poxInfo = await client.getPoxInfo();

    // TEST DELEGATE STX

    await client.delegateStx({
      amountMicroStx: 2_000_000_000_000_000,
      delegateTo: pool.address,
      poxAddress: pool.btcAddress,
      privateKey: alice.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(9, poxInfo),
    });

    await client.delegateStx({
      amountMicroStx: 1_500_000_000_000_000,
      delegateTo: pool.address,
      poxAddress: pool.btcAddress,
      privateKey: bob.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(12, poxInfo),
    });

    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 10);

    const resultBeforeExtend = await axios.get('http://localhost:8080/data');

    const delegations = resultBeforeExtend.data.delegations;

    const expectedDelegationDel = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 9,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 12,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];
    delegations.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedDelegationDel.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(delegations).toEqual(expectedDelegationDel);

    const acceptedDelegations = resultBeforeExtend.data.acceptedDelegations;

    const expectedAcceptedDelegationsDel = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 9,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 9,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];
    acceptedDelegations.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsDel.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(acceptedDelegations).toEqual(expectedAcceptedDelegationsDel);

    const committedDelegations = resultBeforeExtend.data.committedDelegations;

    const expectedCommitedDelDel = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
    ];
    committedDelegations.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelDel.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegations).toEqual(expectedCommitedDelDel);

    // CHECK BLOCKS

    expectedTxs.push(expectedDelegateStx(1_500_000_000_000_000, bob.address));
    expectedTxs.push(expectedDelegateStackStx(1_500_000_000_000_000, bob.address));

    expectedTxs.push(expectedDelegateStx(2_000_000_000_000_000, alice.address));
    expectedTxs.push(expectedDelegateStackStx(2_000_000_000_000_000, alice.address));

    expectedTxs.push(expectedAggCommit(8));

    let filteredExpectedTxs = [...expectedTxs];

    for (let height = 38; height < 48; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);
      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);

    // TEST IF DELEGATION IS EXTENDED IF POSSIBLE

    poxInfo = await client.getPoxInfo();

    await waitForCycle(poxInfo, 8);

    poxInfo = await client.getPoxInfo();

    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 5);

    const resultAfterExtend = await axios.get('http://localhost:8080/data');

    const acceptedDelegationsAfter = resultAfterExtend.data.acceptedDelegations;

    const expectedAcceptedDelegationsExt = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 9,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 10,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];
    acceptedDelegationsAfter.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsExt.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(acceptedDelegationsAfter).toEqual(expectedAcceptedDelegationsExt);

    const committedDelegationsAfter = resultAfterExtend.data.committedDelegations;

    const expectedCommitedDelAfter = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 1_500_000_000_000_000,
        reward_index: 3,
      },
    ];
    committedDelegationsAfter.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelAfter.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegationsAfter).toEqual(expectedCommitedDelAfter);

    // CHECK BLOCKS

    expectedTxs = filteredExpectedTxs;

    expectedTxs.push(expectedDelegateStackExtend(1, bob.address));
    expectedTxs.push(expectedAggCommit(9));

    filteredExpectedTxs = [...expectedTxs];

    for (let height = 58; height < 63; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);
      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);

    // TEST INCREASE
    poxInfo = await client.getPoxInfo();

    // cycle 9
    await waitForNextCycle(poxInfo);

    await client.revokeDelegateStx(bob.key);

    poxInfo = await client.getPoxInfo();
    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 2);

    await client.delegateStx({
      amountMicroStx: 4_000_000_000_000_000,
      delegateTo: pool.address,
      poxAddress: pool.btcAddress,
      privateKey: bob.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(14, poxInfo),
    });

    await client.delegateStx({
      amountMicroStx: 5_000_000_000_000_000,
      delegateTo: pool.address,
      privateKey: charlie.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(11, poxInfo),
    });

    poxInfo = await client.getPoxInfo();
    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 10);

    const resultIncrease = await axios.get('http://localhost:8080/data');

    const delegationsIncrease = resultIncrease.data.delegations;

    const expectedDelegationIncrease = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 9,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 10,
        end_cycle: 11,
        pox_address: null,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 10,
        end_cycle: 14,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
    ];
    delegationsIncrease.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedDelegationIncrease.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(delegationsIncrease).toEqual(expectedDelegationIncrease);

    const previousDelegeationsIncrease = resultIncrease.data.previousDelegations;

    const expectedPreviousDelegationsIncrease = [
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 12,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];

    expect(previousDelegeationsIncrease).toEqual(expectedPreviousDelegationsIncrease);

    const acceptedDelegationsIncrease = resultIncrease.data.acceptedDelegations;

    const expectedAcceptedDelegationsIncrease = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 9,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 10,
        end_cycle: 11,
        pox_address: pool.btcAddress,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 10,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 10,
        end_cycle: 11,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
    ];
    acceptedDelegationsIncrease.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsIncrease.sort((a: any, b: any) =>
      a.stacker.localeCompare(b.stacker)
    );

    expect(acceptedDelegationsIncrease).toEqual(expectedAcceptedDelegationsIncrease);

    const committedDelegationsIncrease = resultIncrease.data.committedDelegations;

    const expectedCommitedDelIncrease = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 3,
      },
    ];
    committedDelegationsIncrease.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelIncrease.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegationsIncrease).toEqual(expectedCommitedDelIncrease);

    // CHECK BLOCKS

    expectedTxs = filteredExpectedTxs;

    expectedTxs.push(expectedRevokeDelegateStx(bob.address));
    expectedTxs.push(expectedDelegateStx(4_000_000_000_000_000, bob.address));
    expectedTxs.push(
      expectedDelegateStackIncrease(4_000_000_000_000_000 - 1_500_000_000_000_000, bob.address)
    );
    expectedTxs.push(expectedDelegateStackExtend(1, bob.address));

    expectedTxs.push(expectedDelegateStx(5_000_000_000_000_000, charlie.address));
    expectedTxs.push(expectedDelegateStackStx(5_000_000_000_000_000, charlie.address));

    expectedTxs.push(expectedAggCommit(10));

    filteredExpectedTxs = [...expectedTxs];
    for (let height = 78; height < 88; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);

      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);

    await waitForCycle(poxInfo, 14);

    poxInfo = await client.getPoxInfo();

    const resultEnd = await axios.get('http://localhost:8080/data');

    const delegationsEnd = resultEnd.data.delegations;

    const expectedDelegationEnd = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 9,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 10,
        end_cycle: 11,
        pox_address: null,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 10,
        end_cycle: 14,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
    ];
    delegationsEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedDelegationEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(delegationsEnd).toEqual(expectedDelegationEnd);

    const previousDelegeationsEnd = resultEnd.data.previousDelegations;

    const expectedPreviousDelegationsEnd = [
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 12,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];

    expect(previousDelegeationsEnd).toEqual(expectedPreviousDelegationsEnd);

    const acceptedDelegationsEnd = resultEnd.data.acceptedDelegations;

    const expectedAcceptedDelegationsEnd = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 9,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 10,
        end_cycle: 11,
        pox_address: pool.btcAddress,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 10,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 10,
        end_cycle: 14,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
    ];
    acceptedDelegationsEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(acceptedDelegationsEnd).toEqual(expectedAcceptedDelegationsEnd);

    const committedDelegationsEnd = resultEnd.data.committedDelegations;

    const expectedCommitedDelEnd = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx: 4_000_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 12,
        end_cycle: 13,
        amount_ustx: 4_000_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 13,
        end_cycle: 14,
        amount_ustx: 4_000_000_000_000_000,
        reward_index: 3,
      },
    ];
    committedDelegationsEnd.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelEnd.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegationsEnd).toEqual(expectedCommitedDelEnd);

    // CHECK BLOCKS

    expectedTxs = filteredExpectedTxs;

    for (let i = 1; i <= 3; i++) expectedTxs.push(expectedDelegateStackExtend(1, bob.address));
    for (let i = 11; i <= 13; i++) expectedTxs.push(expectedAggCommit(i));

    filteredExpectedTxs = [...expectedTxs];

    for (let height = 88; height < 178; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);
      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);
    expectedTxs = filteredExpectedTxs;
  });

  test('automation for MAX_CYCLES_FOR_OPERATIONS = 7', async () => {
    updateEnvValue(envFilePath, keyToUpdate, '7');

    poxInfo = await client.getPoxInfo();

    await waitForCycle(poxInfo, 7);

    poxInfo = await client.getPoxInfo();

    // TEST DELEGATE STX

    await client.delegateStx({
      amountMicroStx: 2_000_000_000_000_000,
      delegateTo: pool.address,
      poxAddress: pool.btcAddress,
      privateKey: alice.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(14, poxInfo),
    });

    await client.delegateStx({
      amountMicroStx: 1_500_000_000_000_000,
      delegateTo: pool.address,
      poxAddress: pool.btcAddress,
      privateKey: bob.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(18, poxInfo),
    });

    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 10);

    const resultBeforeExtend = await axios.get('http://localhost:8080/data');

    const delegations = resultBeforeExtend.data.delegations;

    const expectedDelegationDel = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 14,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 18,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];
    delegations.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedDelegationDel.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(delegations).toEqual(expectedDelegationDel);

    const acceptedDelegations = resultBeforeExtend.data.acceptedDelegations;

    const expectedAcceptedDelegationsDel = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 14,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 15,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];
    acceptedDelegations.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsDel.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(acceptedDelegations).toEqual(expectedAcceptedDelegationsDel);

    const committedDelegations = resultBeforeExtend.data.committedDelegations;

    const expectedCommitedDelDel = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 12,
        end_cycle: 13,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 13,
        end_cycle: 14,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 14,
        end_cycle: 15,
        amount_ustx: 1_500_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegations.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelDel.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegations).toEqual(expectedCommitedDelDel);

    // CHECK BLOCKS

    expectedTxs.push(expectedDelegateStx(1_500_000_000_000_000, bob.address));
    expectedTxs.push(expectedDelegateStackStx(1_500_000_000_000_000, bob.address));

    expectedTxs.push(expectedDelegateStx(2_000_000_000_000_000, alice.address));
    expectedTxs.push(expectedDelegateStackStx(2_000_000_000_000_000, alice.address));

    for (let i = 8; i <= 14; i++) expectedTxs.push(expectedAggCommit(i));

    let filteredExpectedTxs = [...expectedTxs];

    for (let height = 38; height < 48; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);
      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);

    // TEST IF DELEGATION IS EXTENDED IF POSSIBLE

    poxInfo = await client.getPoxInfo();

    await waitForCycle(poxInfo, 8);

    poxInfo = await client.getPoxInfo();

    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 5);

    const resultAfterExtend = await axios.get('http://localhost:8080/data');

    const acceptedDelegationsAfter = resultAfterExtend.data.acceptedDelegations;

    const expectedAcceptedDelegationsExt = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 14,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 16,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];
    acceptedDelegationsAfter.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsExt.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(acceptedDelegationsAfter).toEqual(expectedAcceptedDelegationsExt);

    const committedDelegationsAfter = resultAfterExtend.data.committedDelegations;

    const expectedCommitedDelAfter = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 12,
        end_cycle: 13,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 13,
        end_cycle: 14,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 14,
        end_cycle: 15,
        amount_ustx: 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 15,
        end_cycle: 16,
        amount_ustx: 1_500_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegationsAfter.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelAfter.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegationsAfter).toEqual(expectedCommitedDelAfter);

    // CHECK BLOCKS

    expectedTxs = filteredExpectedTxs;

    expectedTxs.push(expectedDelegateStackExtend(1, bob.address));
    expectedTxs.push(expectedAggCommit(15));

    filteredExpectedTxs = [...expectedTxs];

    for (let height = 58; height < 63; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);
      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);

    // TEST INCREASE
    poxInfo = await client.getPoxInfo();

    // cycle 9
    await waitForNextCycle(poxInfo);

    await client.revokeDelegateStx(bob.key);

    poxInfo = await client.getPoxInfo();
    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 2);

    await client.delegateStx({
      amountMicroStx: 4_000_000_000_000_000,
      delegateTo: pool.address,
      poxAddress: pool.btcAddress,
      privateKey: bob.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(20, poxInfo),
    });

    await client.delegateStx({
      amountMicroStx: 5_000_000_000_000_000,
      delegateTo: pool.address,
      privateKey: charlie.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(17, poxInfo),
    });

    poxInfo = await client.getPoxInfo();
    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 10);

    const resultIncrease = await axios.get('http://localhost:8080/data');

    const delegationsIncrease = resultIncrease.data.delegations;

    const expectedDelegationIncrease = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 14,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 10,
        end_cycle: 17,
        pox_address: null,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 10,
        end_cycle: 20,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
    ];
    delegationsIncrease.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedDelegationIncrease.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(delegationsIncrease).toEqual(expectedDelegationIncrease);

    const previousDelegeationsIncrease = resultIncrease.data.previousDelegations;

    const expectedPreviousDelegationsIncrease = [
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 18,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];

    expect(previousDelegeationsIncrease).toEqual(expectedPreviousDelegationsIncrease);

    const acceptedDelegationsIncrease = resultIncrease.data.acceptedDelegations;

    const expectedAcceptedDelegationsIncrease = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 14,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 10,
        end_cycle: 17,
        pox_address: pool.btcAddress,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 10,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 10,
        end_cycle: 17,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
    ];
    acceptedDelegationsIncrease.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsIncrease.sort((a: any, b: any) =>
      a.stacker.localeCompare(b.stacker)
    );

    expect(acceptedDelegationsIncrease).toEqual(expectedAcceptedDelegationsIncrease);

    const committedDelegationsIncrease = resultIncrease.data.committedDelegations;

    const expectedCommitedDelIncrease = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 12,
        end_cycle: 13,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 13,
        end_cycle: 14,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 14,
        end_cycle: 15,
        amount_ustx: 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 15,
        end_cycle: 16,
        amount_ustx: 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 16,
        end_cycle: 17,
        amount_ustx: 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegationsIncrease.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelIncrease.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegationsIncrease).toEqual(expectedCommitedDelIncrease);

    // CHECK BLOCKS

    expectedTxs = filteredExpectedTxs;

    expectedTxs.push(expectedRevokeDelegateStx(bob.address));
    expectedTxs.push(expectedDelegateStx(4_000_000_000_000_000, bob.address));
    expectedTxs.push(
      expectedDelegateStackIncrease(4_000_000_000_000_000 - 1_500_000_000_000_000, bob.address)
    );
    expectedTxs.push(expectedDelegateStackExtend(1, bob.address));

    expectedTxs.push(expectedDelegateStx(5_000_000_000_000_000, charlie.address));
    expectedTxs.push(expectedDelegateStackStx(5_000_000_000_000_000, charlie.address));

    for (let i = 10; i <= 15; i++) expectedTxs.push(expectedAggIncrease(i));
    expectedTxs.push(expectedAggCommit(16));

    filteredExpectedTxs = [...expectedTxs];
    for (let height = 78; height < 88; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);

      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);

    await waitForCycle(poxInfo, 20);

    poxInfo = await client.getPoxInfo();

    const resultEnd = await axios.get('http://localhost:8080/data');

    const delegationsEnd = resultEnd.data.delegations;

    const expectedDelegationEnd = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 14,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 10,
        end_cycle: 17,
        pox_address: null,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 10,
        end_cycle: 20,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
    ];
    delegationsEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedDelegationEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(delegationsEnd).toEqual(expectedDelegationEnd);

    const previousDelegeationsEnd = resultEnd.data.previousDelegations;

    const expectedPreviousDelegationsEnd = [
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 18,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];

    expect(previousDelegeationsEnd).toEqual(expectedPreviousDelegationsEnd);

    const acceptedDelegationsEnd = resultEnd.data.acceptedDelegations;

    const expectedAcceptedDelegationsEnd = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 14,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 10,
        end_cycle: 17,
        pox_address: pool.btcAddress,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 10,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 10,
        end_cycle: 20,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
    ];
    acceptedDelegationsEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(acceptedDelegationsEnd).toEqual(expectedAcceptedDelegationsEnd);

    const committedDelegationsEnd = resultEnd.data.committedDelegations;

    const expectedCommitedDelEnd = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 12,
        end_cycle: 13,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 13,
        end_cycle: 14,
        amount_ustx: 2_000_000_000_000_000 + 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 14,
        end_cycle: 15,
        amount_ustx: 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 15,
        end_cycle: 16,
        amount_ustx: 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 16,
        end_cycle: 17,
        amount_ustx: 4_000_000_000_000_000 + 5_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 17,
        end_cycle: 18,
        amount_ustx: 4_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 18,
        end_cycle: 19,
        amount_ustx: 4_000_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 19,
        end_cycle: 20,
        amount_ustx: 4_000_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegationsEnd.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelEnd.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegationsEnd).toEqual(expectedCommitedDelEnd);

    // CHECK BLOCKS

    expectedTxs = filteredExpectedTxs;

    for (let i = 1; i <= 3; i++) expectedTxs.push(expectedDelegateStackExtend(1, bob.address));
    for (let i = 17; i <= 19; i++) expectedTxs.push(expectedAggCommit(i));

    filteredExpectedTxs = [...expectedTxs];

    for (let height = 88; height < 298; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);
      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);
    expectedTxs = filteredExpectedTxs;
  });

  test('automation for MAX_CYCLES_FOR_OPERATIONS = 12 with long delegations', async () => {
    updateEnvValue(envFilePath, keyToUpdate, '12');

    poxInfo = await client.getPoxInfo();

    await waitForCycle(poxInfo, 7);

    poxInfo = await client.getPoxInfo();

    // TEST DELEGATE STX

    await client.delegateStx({
      amountMicroStx: 2_000_000_000_000_000,
      delegateTo: pool.address,
      poxAddress: pool.btcAddress,
      privateKey: alice.key,
    });

    expectedTxs.push(expectedDelegateStx(2_000_000_000_000_000, alice.address));
    expectedTxs.push(expectedDelegateStackStx(2_000_000_000_000_000, alice.address));

    await client.delegateStx({
      amountMicroStx: 1_500_000_000_000_000,
      delegateTo: pool.address,
      poxAddress: pool.btcAddress,
      privateKey: bob.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(1111, poxInfo),
    });

    expectedTxs.push(expectedDelegateStx(1_500_000_000_000_000, bob.address));
    expectedTxs.push(expectedDelegateStackStx(1_500_000_000_000_000, bob.address));

    for (let i = 8; i <= 19; i++) expectedTxs.push(expectedAggCommit(i));

    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 10);

    // CHECK BLOCKS

    let filteredExpectedTxs = [...expectedTxs];

    for (let height = 38; height < 48; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);
      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);

    const resultBeforeExtend = await axios.get('http://localhost:8080/data');

    const delegations = resultBeforeExtend.data.delegations;

    const expectedDelegationDel = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: null,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 1111,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];
    delegations.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedDelegationDel.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(delegations).toEqual(expectedDelegationDel);

    const acceptedDelegations = resultBeforeExtend.data.acceptedDelegations;

    const expectedAcceptedDelegationsDel = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 20,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 20,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];
    acceptedDelegations.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsDel.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(acceptedDelegations).toEqual(expectedAcceptedDelegationsDel);

    const committedDelegations = resultBeforeExtend.data.committedDelegations;

    const expectedCommitedDelDel = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 12,
        end_cycle: 13,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 13,
        end_cycle: 14,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 14,
        end_cycle: 15,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 15,
        end_cycle: 16,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 16,
        end_cycle: 17,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 17,
        end_cycle: 18,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 18,
        end_cycle: 19,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 19,
        end_cycle: 20,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegations.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelDel.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegations).toEqual(expectedCommitedDelDel);

    // TEST IF DELEGATION IS EXTENDED IF POSSIBLE

    poxInfo = await client.getPoxInfo();

    await waitForCycle(poxInfo, 9);

    poxInfo = await client.getPoxInfo();

    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 5);

    // CHECK BLOCKS

    const resultAfterExtend = await axios.get('http://localhost:8080/data');

    const acceptedDelegationsAfter = resultAfterExtend.data.acceptedDelegations;

    const expectedAcceptedDelegationsExt = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 21,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 21,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];
    acceptedDelegationsAfter.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsExt.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(acceptedDelegationsAfter).toEqual(expectedAcceptedDelegationsExt);

    const committedDelegationsAfter = resultAfterExtend.data.committedDelegations;

    const expectedCommitedDelAfter = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 12,
        end_cycle: 13,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 13,
        end_cycle: 14,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 14,
        end_cycle: 15,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 15,
        end_cycle: 16,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 16,
        end_cycle: 17,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 17,
        end_cycle: 18,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 18,
        end_cycle: 19,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 19,
        end_cycle: 20,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 20,
        end_cycle: 21,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegationsAfter.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelAfter.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegationsAfter).toEqual(expectedCommitedDelAfter);

    expectedTxs = filteredExpectedTxs;
    expectedTxs.push(expectedDelegateStackExtend(1, bob.address));
    expectedTxs.push(expectedDelegateStackExtend(1, alice.address));

    expectedTxs.push(expectedAggCommit(20));
    filteredExpectedTxs = [...expectedTxs];

    for (let height = 48; height < 83; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);
      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);

    // TEST INCREASE
    poxInfo = await client.getPoxInfo();

    // cycle 10
    await waitForNextCycle(poxInfo);

    await client.revokeDelegateStx(bob.key);

    poxInfo = await client.getPoxInfo();
    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 2);

    await client.delegateStx({
      amountMicroStx: 4_000_000_000_000_000,
      delegateTo: pool.address,
      poxAddress: pool.btcAddress,
      privateKey: bob.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(1222, poxInfo),
    });

    await client.delegateStx({
      amountMicroStx: 5_000_000_000_000_000,
      delegateTo: pool.address,
      privateKey: charlie.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(1000, poxInfo),
    });
    await client.delegateStx({
      amountMicroStx: 2_500_000_000_000_000,
      delegateTo: pool.address,
      privateKey: dave.key,
    });

    poxInfo = await client.getPoxInfo();

    // cycle 11
    await waitForNextCycle(poxInfo);

    // CHECK BLOCKS

    const resultIncrease = await axios.get('http://localhost:8080/data');

    const delegationsIncrease = resultIncrease.data.delegations;

    const expectedDelegationIncrease = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: null,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 11,
        end_cycle: 1000,
        pox_address: null,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 11,
        end_cycle: 1222,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
      {
        stacker: dave.address,
        start_cycle: 11,
        end_cycle: null,
        pox_address: null,
        amount_ustx: 2_500_000_000_000_000,
      },
    ];
    delegationsIncrease.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedDelegationIncrease.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(delegationsIncrease).toEqual(expectedDelegationIncrease);

    const previousDelegeationsIncrease = resultIncrease.data.previousDelegations;

    const expectedPreviousDelegationsIncrease = [
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 1111,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];

    expect(previousDelegeationsIncrease).toEqual(expectedPreviousDelegationsIncrease);

    const acceptedDelegationsIncrease = resultIncrease.data.acceptedDelegations;

    const expectedAcceptedDelegationsIncrease = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 22,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 11,
        end_cycle: 23,
        pox_address: pool.btcAddress,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 11,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 11,
        end_cycle: 22,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
      {
        stacker: dave.address,
        start_cycle: 11,
        end_cycle: 23,
        pox_address: pool.btcAddress,
        amount_ustx: 2_500_000_000_000_000,
      },
    ];
    acceptedDelegationsIncrease.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsIncrease.sort((a: any, b: any) =>
      a.stacker.localeCompare(b.stacker)
    );

    expect(acceptedDelegationsIncrease).toEqual(expectedAcceptedDelegationsIncrease);

    const committedDelegationsIncrease = resultIncrease.data.committedDelegations;

    const expectedCommitedDelIncrease = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 12,
        end_cycle: 13,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 13,
        end_cycle: 14,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 14,
        end_cycle: 15,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 15,
        end_cycle: 16,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 16,
        end_cycle: 17,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 17,
        end_cycle: 18,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 18,
        end_cycle: 19,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 19,
        end_cycle: 20,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 20,
        end_cycle: 21,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 21,
        end_cycle: 22,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 22,
        end_cycle: 23,
        amount_ustx: 5_000_000_000_000_000 + 2_500_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegationsIncrease.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelIncrease.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegationsIncrease).toEqual(expectedCommitedDelIncrease);

    expectedTxs = filteredExpectedTxs;
    expectedTxs.push(expectedRevokeDelegateStx(bob.address));
    expectedTxs.push(expectedDelegateStx(4_000_000_000_000_000, bob.address));
    expectedTxs.push(
      expectedDelegateStackIncrease(4_000_000_000_000_000 - 1_500_000_000_000_000, bob.address)
    );

    expectedTxs.push(expectedDelegateStx(5_000_000_000_000_000, charlie.address));
    expectedTxs.push(expectedDelegateStackStx(5_000_000_000_000_000, charlie.address));

    expectedTxs.push(expectedDelegateStx(2_500_000_000_000_000, dave.address));
    expectedTxs.push(expectedDelegateStackStx(2_500_000_000_000_000, dave.address));

    expectedTxs.push(expectedDelegateStackExtend(1, bob.address));
    expectedTxs.push(expectedDelegateStackExtend(1, alice.address));

    for (let i = 11; i <= 21; i++) expectedTxs.push(expectedAggIncrease(i));

    expectedTxs.push(expectedAggCommit(21));
    expectedTxs.push(expectedAggCommit(22));

    filteredExpectedTxs = [...expectedTxs];
    for (let height = 83; height < 108; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);
      console.log(filteredApiTxs);

      expect(filteredApiTxs.length).toEqual(0);

      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    console.log(filteredExpectedTxs);

    expect(filteredExpectedTxs.length).toEqual(0);

    await waitForCycle(poxInfo, 25);

    poxInfo = await client.getPoxInfo();

    const resultEnd = await axios.get('http://localhost:8080/data');

    const delegationsEnd = resultEnd.data.delegations;

    const expectedDelegationEnd = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: null,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 11,
        end_cycle: 1000,
        pox_address: null,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 11,
        end_cycle: 1222,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
      {
        stacker: dave.address,
        start_cycle: 11,
        end_cycle: null,
        pox_address: null,
        amount_ustx: 2_500_000_000_000_000,
      },
    ];
    delegationsEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedDelegationEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(delegationsEnd).toEqual(expectedDelegationEnd);

    const previousDelegeationsEnd = resultEnd.data.previousDelegations;

    const expectedPreviousDelegationsEnd = [
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 1111,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];

    expect(previousDelegeationsEnd).toEqual(expectedPreviousDelegationsEnd);

    const acceptedDelegationsEnd = resultEnd.data.acceptedDelegations;

    const expectedAcceptedDelegationsEnd = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 36,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 11,
        end_cycle: 36,
        pox_address: pool.btcAddress,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 11,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 11,
        end_cycle: 36,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
      {
        stacker: dave.address,
        start_cycle: 11,
        end_cycle: 36,
        pox_address: pool.btcAddress,
        amount_ustx: 2_500_000_000_000_000,
      },
    ];
    acceptedDelegationsEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(acceptedDelegationsEnd).toEqual(expectedAcceptedDelegationsEnd);

    const committedDelegationsEnd = resultEnd.data.committedDelegations;

    const expectedCommitedDelEnd = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 12,
        end_cycle: 13,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 13,
        end_cycle: 14,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 14,
        end_cycle: 15,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 15,
        end_cycle: 16,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 16,
        end_cycle: 17,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 17,
        end_cycle: 18,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 18,
        end_cycle: 19,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 19,
        end_cycle: 20,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 20,
        end_cycle: 21,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 21,
        end_cycle: 22,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 22,
        end_cycle: 23,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 23,
        end_cycle: 24,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 24,
        end_cycle: 25,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 25,
        end_cycle: 26,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 26,
        end_cycle: 27,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 27,
        end_cycle: 28,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 28,
        end_cycle: 29,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 29,
        end_cycle: 30,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 30,
        end_cycle: 31,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 31,
        end_cycle: 32,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 32,
        end_cycle: 33,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 33,
        end_cycle: 34,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 34,
        end_cycle: 35,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 35,
        end_cycle: 36,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegationsEnd.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelEnd.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegationsEnd).toEqual(expectedCommitedDelEnd);

    expectedTxs = filteredExpectedTxs;
    for (let i = 1; i <= 14; i++) expectedTxs.push(expectedDelegateStackExtend(1, bob.address));
    for (let i = 1; i <= 14; i++) expectedTxs.push(expectedDelegateStackExtend(1, alice.address));
    for (let i = 1; i <= 13; i++) expectedTxs.push(expectedDelegateStackExtend(1, charlie.address));
    for (let i = 1; i <= 13; i++) expectedTxs.push(expectedDelegateStackExtend(1, dave.address));

    expectedTxs.push(expectedAggIncrease(22));
    for (let i = 23; i <= 35; i++) expectedTxs.push(expectedAggCommit(i));

    filteredExpectedTxs = [...expectedTxs];

    for (let height = 108; height < 397; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);
      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);

    expectedTxs = filteredExpectedTxs;
  });

  test('automation for MAX_CYCLES_FOR_OPERATIONS = 4 with long delegations', async () => {
    updateEnvValue(envFilePath, keyToUpdate, '4');

    poxInfo = await client.getPoxInfo();

    await waitForCycle(poxInfo, 7);

    poxInfo = await client.getPoxInfo();

    // TEST DELEGATE STX

    await client.delegateStx({
      amountMicroStx: 2_000_000_000_000_000,
      delegateTo: pool.address,
      poxAddress: pool.btcAddress,
      privateKey: alice.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(3000, poxInfo),
    });

    await client.delegateStx({
      amountMicroStx: 1_500_000_000_000_000,
      delegateTo: pool.address,
      poxAddress: pool.btcAddress,
      privateKey: bob.key,
    });

    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 10);

    const resultBeforeExtend = await axios.get('http://localhost:8080/data');

    const delegations = resultBeforeExtend.data.delegations;

    const expectedDelegationDel = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 3000,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: null,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];
    delegations.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedDelegationDel.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(delegations).toEqual(expectedDelegationDel);

    const acceptedDelegations = resultBeforeExtend.data.acceptedDelegations;

    const expectedAcceptedDelegationsDel = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 12,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 12,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];
    acceptedDelegations.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsDel.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(acceptedDelegations).toEqual(expectedAcceptedDelegationsDel);

    const committedDelegations = resultBeforeExtend.data.committedDelegations;

    const expectedCommitedDelDel = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegations.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelDel.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegations).toEqual(expectedCommitedDelDel);

    // CHECK BLOCKS

    expectedTxs.push(expectedDelegateStx(1_500_000_000_000_000, bob.address));
    expectedTxs.push(expectedDelegateStackStx(1_500_000_000_000_000, bob.address));

    expectedTxs.push(expectedDelegateStx(2_000_000_000_000_000, alice.address));
    expectedTxs.push(expectedDelegateStackStx(2_000_000_000_000_000, alice.address));

    for (let i = 8; i <= 11; i++) expectedTxs.push(expectedAggCommit(i));

    let filteredExpectedTxs = [...expectedTxs];

    for (let height = 38; height < 48; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);
      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);

    // TEST IF DELEGATION IS EXTENDED IF POSSIBLE

    poxInfo = await client.getPoxInfo();

    await waitForCycle(poxInfo, 8);

    poxInfo = await client.getPoxInfo();

    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 5);

    const resultAfterExtend = await axios.get('http://localhost:8080/data');

    const acceptedDelegationsAfter = resultAfterExtend.data.acceptedDelegations;

    const expectedAcceptedDelegationsExt = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 13,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 13,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];
    acceptedDelegationsAfter.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsExt.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(acceptedDelegationsAfter).toEqual(expectedAcceptedDelegationsExt);

    const committedDelegationsAfter = resultAfterExtend.data.committedDelegations;

    const expectedCommitedDelAfter = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 12,
        end_cycle: 13,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegationsAfter.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelAfter.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegationsAfter).toEqual(expectedCommitedDelAfter);

    // CHECK BLOCKS

    expectedTxs = filteredExpectedTxs;

    expectedTxs.push(expectedDelegateStackExtend(1, alice.address));
    expectedTxs.push(expectedDelegateStackExtend(1, bob.address));
    expectedTxs.push(expectedAggCommit(12));

    filteredExpectedTxs = [...expectedTxs];

    for (let height = 58; height < 63; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);
      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);

    // TEST INCREASE
    poxInfo = await client.getPoxInfo();

    // cycle 9
    await waitForNextCycle(poxInfo);

    poxInfo = await client.getPoxInfo();
    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 2);

    await client.revokeDelegateStx(bob.key);

    poxInfo = await client.getPoxInfo();
    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 5);

    await client.delegateStx({
      amountMicroStx: 4_000_000_000_000_000,
      delegateTo: pool.address,
      poxAddress: pool.btcAddress,
      privateKey: bob.key,
    });

    await client.delegateStx({
      amountMicroStx: 5_000_000_000_000_000,
      delegateTo: pool.address,
      privateKey: charlie.key,
      untilBurnBlockHeight: rewardCycleToBurnHeight(2000, poxInfo),
    });

    await client.delegateStx({
      amountMicroStx: 2_500_000_000_000_000,
      delegateTo: pool.address,
      privateKey: dave.key,
    });

    poxInfo = await client.getPoxInfo();
    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 10);

    const resultIncrease = await axios.get('http://localhost:8080/data');

    const delegationsIncrease = resultIncrease.data.delegations;

    const expectedDelegationIncrease = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 3000,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 10,
        end_cycle: 2000,
        pox_address: null,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 10,
        end_cycle: null,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
      {
        stacker: dave.address,
        start_cycle: 10,
        end_cycle: null,
        pox_address: null,
        amount_ustx: 2_500_000_000_000_000,
      },
    ];
    delegationsIncrease.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedDelegationIncrease.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(delegationsIncrease).toEqual(expectedDelegationIncrease);

    const previousDelegeationsIncrease = resultIncrease.data.previousDelegations;

    const expectedPreviousDelegationsIncrease = [
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: null,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];

    expect(previousDelegeationsIncrease).toEqual(expectedPreviousDelegationsIncrease);

    const acceptedDelegationsIncrease = resultIncrease.data.acceptedDelegations;

    const expectedAcceptedDelegationsIncrease = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 14,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 10,
        end_cycle: 14,
        pox_address: pool.btcAddress,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 10,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 10,
        end_cycle: 14,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
      {
        stacker: dave.address,
        start_cycle: 10,
        end_cycle: 14,
        pox_address: pool.btcAddress,
        amount_ustx: 2_500_000_000_000_000,
      },
    ];
    acceptedDelegationsIncrease.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsIncrease.sort((a: any, b: any) =>
      a.stacker.localeCompare(b.stacker)
    );

    expect(acceptedDelegationsIncrease).toEqual(expectedAcceptedDelegationsIncrease);

    const committedDelegationsIncrease = resultIncrease.data.committedDelegations;

    const expectedCommitedDelIncrease = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 12,
        end_cycle: 13,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 13,
        end_cycle: 14,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
    ];
    committedDelegationsIncrease.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelIncrease.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegationsIncrease).toEqual(expectedCommitedDelIncrease);

    // CHECK BLOCKS

    expectedTxs = filteredExpectedTxs;

    expectedTxs.push(expectedRevokeDelegateStx(bob.address));
    expectedTxs.push(expectedDelegateStx(4_000_000_000_000_000, bob.address));
    expectedTxs.push(
      expectedDelegateStackIncrease(4_000_000_000_000_000 - 1_500_000_000_000_000, bob.address)
    );
    expectedTxs.push(expectedDelegateStackExtend(1, alice.address));
    expectedTxs.push(expectedDelegateStackExtend(1, bob.address));

    expectedTxs.push(expectedDelegateStx(5_000_000_000_000_000, charlie.address));
    expectedTxs.push(expectedDelegateStackStx(5_000_000_000_000_000, charlie.address));

    expectedTxs.push(expectedDelegateStx(2_500_000_000_000_000, dave.address));
    expectedTxs.push(expectedDelegateStackStx(2_500_000_000_000_000, dave.address));

    for (let i = 10; i <= 13; i++) expectedTxs.push(expectedAggIncrease(i));
    expectedTxs.push(expectedAggCommit(13));

    filteredExpectedTxs = [...expectedTxs];
    for (let height = 78; height < 93; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);

      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    console.log(filteredExpectedTxs);
    expect(filteredExpectedTxs.length).toEqual(0);

    await waitForCycle(poxInfo, 20);

    poxInfo = await client.getPoxInfo();
    await waitForBurnBlockHeight(poxInfo.current_burnchain_block_height! + 7);

    const resultEnd = await axios.get('http://localhost:8080/data');

    const delegationsEnd = resultEnd.data.delegations;

    const expectedDelegationEnd = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 3000,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 10,
        end_cycle: 2000,
        pox_address: null,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 10,
        end_cycle: null,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
      {
        stacker: dave.address,
        start_cycle: 10,
        end_cycle: null,
        pox_address: null,
        amount_ustx: 2_500_000_000_000_000,
      },
    ];
    delegationsEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedDelegationEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(delegationsEnd).toEqual(expectedDelegationEnd);

    const previousDelegeationsEnd = resultEnd.data.previousDelegations;

    const expectedPreviousDelegationsEnd = [
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: null,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
    ];

    expect(previousDelegeationsEnd).toEqual(expectedPreviousDelegationsEnd);

    const acceptedDelegationsEnd = resultEnd.data.acceptedDelegations;

    const expectedAcceptedDelegationsEnd = [
      {
        stacker: alice.address,
        start_cycle: 8,
        end_cycle: 25,
        pox_address: pool.btcAddress,
        amount_ustx: 2_000_000_000_000_000,
      },
      {
        stacker: charlie.address,
        start_cycle: 10,
        end_cycle: 25,
        pox_address: pool.btcAddress,
        amount_ustx: 5_000_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 8,
        end_cycle: 10,
        pox_address: pool.btcAddress,
        amount_ustx: 1_500_000_000_000_000,
      },
      {
        stacker: bob.address,
        start_cycle: 10,
        end_cycle: 25,
        pox_address: pool.btcAddress,
        amount_ustx: 4_000_000_000_000_000,
      },
      {
        stacker: dave.address,
        start_cycle: 10,
        end_cycle: 25,
        pox_address: pool.btcAddress,
        amount_ustx: 2_500_000_000_000_000,
      },
    ];
    acceptedDelegationsEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));
    expectedAcceptedDelegationsEnd.sort((a: any, b: any) => a.stacker.localeCompare(b.stacker));

    expect(acceptedDelegationsEnd).toEqual(expectedAcceptedDelegationsEnd);

    const committedDelegationsEnd = resultEnd.data.committedDelegations;

    const expectedCommitedDelEnd = [
      {
        pox_address: pool.btcAddress,
        start_cycle: 8,
        end_cycle: 9,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 3,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 9,
        end_cycle: 10,
        amount_ustx: 2_000_000_000_000_000 + 1_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 10,
        end_cycle: 11,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 11,
        end_cycle: 12,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 12,
        end_cycle: 13,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 13,
        end_cycle: 14,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 14,
        end_cycle: 15,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 15,
        end_cycle: 16,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 16,
        end_cycle: 17,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 17,
        end_cycle: 18,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 18,
        end_cycle: 19,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 19,
        end_cycle: 20,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 20,
        end_cycle: 21,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 21,
        end_cycle: 22,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 22,
        end_cycle: 23,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 23,
        end_cycle: 24,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
      {
        pox_address: pool.btcAddress,
        start_cycle: 24,
        end_cycle: 25,
        amount_ustx:
          2_000_000_000_000_000 +
          4_000_000_000_000_000 +
          5_000_000_000_000_000 +
          2_500_000_000_000_000,
        reward_index: 0,
      },
    ];

    committedDelegationsEnd.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));
    expectedCommitedDelEnd.sort((a: any, b: any) => a.pox_address.localeCompare(b.pox_address));

    expect(committedDelegationsEnd).toEqual(expectedCommitedDelEnd);

    // CHECK BLOCKS

    expectedTxs = filteredExpectedTxs;

    for (let i = 1; i <= 11; i++) expectedTxs.push(expectedDelegateStackExtend(1, alice.address));
    for (let i = 1; i <= 11; i++) expectedTxs.push(expectedDelegateStackExtend(1, bob.address));
    for (let i = 1; i <= 11; i++) expectedTxs.push(expectedDelegateStackExtend(1, charlie.address));
    for (let i = 1; i <= 11; i++) expectedTxs.push(expectedDelegateStackExtend(1, dave.address));

    for (let i = 14; i <= 24; i++) expectedTxs.push(expectedAggCommit(i));

    filteredExpectedTxs = [...expectedTxs];

    for (let height = 93; height < 304; height++) {
      const { filteredApiTxs, filteredExpectedTxs: remainingFilteredExpectedTxs } =
        await filterMyTransactions(filteredExpectedTxs, height);

      expect(filteredApiTxs.length).toEqual(0);
      filteredExpectedTxs = remainingFilteredExpectedTxs;
    }
    expect(filteredExpectedTxs.length).toEqual(0);

    expectedTxs = filteredExpectedTxs;
  });
});
