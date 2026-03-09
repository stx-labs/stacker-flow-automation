import { createServer } from 'http';
import { fetchPoxInfo, getContractCallFees, getUserUnlockedBalance } from './api-calls';
import { runConfigValidator } from './checks';
import {
  checkAndBroadcastTransactions,
  createTables,
  clearTables,
  getEvents,
  getRewardIndexesMap,
  parseEvents,
  removeAnchoredTransactionsFromDatabase,
  timestampError,
  timestampLog,
} from './helpers';
import {
  getTotalAmounts,
  saveAcceptedDelegations,
  saveCommittedDelegations,
  saveDelegations,
  savePreviousDelegations,
} from './save-data';
import { sleep } from './transactions';
import { Gauge, register } from 'prom-client';
import { DATABASE_CONFIG, DETAILED_LOGS, POOL_OPERATOR, PROMETHEUS_PORT } from './consts';
import { createDatabaseIfNotExists } from './db';

process.on('unhandledRejection', (reason, promise) => {
  timestampError('Unhandled Rejection at:', promise, 'reason:', reason);
});

const totalDelegatedGauge = new Gauge({
  name: 'total_delegated',
  help: 'Total delegated amount in the next cycle',
});
const totalAcceptedGauge = new Gauge({
  name: 'total_accepted',
  help: 'Total accepted amount in the next cycle',
});
const totalCommittedGauge = new Gauge({
  name: 'total_committed',
  help: 'Total committed amount in the next cycle',
});
const cycleGauge = new Gauge({
  name: 'cycle',
  help: 'Next cycle ID',
});
const blocksUntilPreparePhaseGauge = new Gauge({
  name: 'blocks_until_prepare_phase',
  help: 'Blocks until next cycle prepare phase',
});
const poolOperatorUnlockedBalanceGauge = new Gauge({
  name: 'pool_operator_unlocked_balance',
  help: 'Unlocked balance of the pool operator (uSTX)',
});

const startMetricsServer = () => {
  const server = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      try {
        const metrics = await register.metrics();
        res.setHeader('Content-Type', register.contentType);
        res.end(metrics);
      } catch (error) {
        res.writeHead(500);
        res.end('Error collecting metrics');
        timestampError('Error collecting metrics:', error);
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(PROMETHEUS_PORT, () => {
    timestampLog(
      `Prometheus metrics server is running on port ${PROMETHEUS_PORT}`
    );
  });
};

const main = async () => {
  startMetricsServer();
  runConfigValidator();
  await createDatabaseIfNotExists(DATABASE_CONFIG.database);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const fee = await getContractCallFees();
      if (fee === null) {
        await sleep(60_000);
        continue;
      };

      await createTables();
      const poxInfo = await fetchPoxInfo();

      if (poxInfo === null) {
        continue;
      };

      const {
        locked: poolOperatorBalanceLocked,
        total: poolOperatorBalanceTotal,
      } = await getUserUnlockedBalance(POOL_OPERATOR);
      if (
        poolOperatorBalanceTotal === null &&
        poolOperatorBalanceLocked === null
      ) {
        return;
      }

      const currentCycle = poxInfo.current_cycle.id;
      const currentBlock = poxInfo.current_burnchain_block_height;
      const blocksUntilPreparePhase = poxInfo.next_cycle.blocks_until_prepare_phase;

      timestampLog('Current cycle:', currentCycle);

      const totalAmounts = await getTotalAmounts(currentCycle + 1);

      totalDelegatedGauge.set(totalAmounts.totalDelegated);
      totalAcceptedGauge.set(totalAmounts.totalAccepted);
      totalCommittedGauge.set(totalAmounts.totalCommitted);
      cycleGauge.set(totalAmounts.cycle);
      blocksUntilPreparePhaseGauge.set(
        blocksUntilPreparePhase > 0 ? blocksUntilPreparePhase : 0
      );
      poolOperatorUnlockedBalanceGauge.set(
        poolOperatorBalanceTotal - poolOperatorBalanceLocked
      );

      if (blocksUntilPreparePhase > 0) {
        timestampLog(
          "Next cycle's prepare phase starts in",
          blocksUntilPreparePhase,
          'blocks.'
        );

        const dbEntries = await removeAnchoredTransactionsFromDatabase();
        const events = await getEvents();
        if (!events) {
          await sleep(60_000);
          continue;
        };

        const rewardIndexesMap = await getRewardIndexesMap(currentCycle);

        const {
          delegations,
          acceptedDelegations,
          committedDelegations,
          previousDelegations,
        } = await parseEvents(events, rewardIndexesMap);

        if (DETAILED_LOGS) {
          timestampLog('Delegations:', delegations);
          timestampLog('Accepted Delegations:', acceptedDelegations);
          timestampLog('Committed Delegations:', committedDelegations);
          timestampLog('Previous Delegations:', previousDelegations);
        } else {
          timestampLog('Total amount delegated:', totalAmounts.totalDelegated);
          timestampLog('Total amount accepted:', totalAmounts.totalAccepted);
          timestampLog('Total amount committed:', totalAmounts.totalCommitted);
        };

        await clearTables();

        await saveDelegations(delegations);
        await saveAcceptedDelegations(acceptedDelegations);
        await saveCommittedDelegations(committedDelegations);
        await savePreviousDelegations(previousDelegations);

        if (
          blocksUntilPreparePhase <
          parseInt(process.env.BLOCKS_UNTIL_PREPARE_PHASE ?? '100')
        ) {
          await checkAndBroadcastTransactions(
            delegations,
            acceptedDelegations,
            committedDelegations,
            currentCycle,
            currentBlock,
            dbEntries,
            fee,
          );
        };

        timestampLog('Data has been saved successfully.');
        if (
          totalAmounts.totalCommitted > 0 &&
          totalAmounts.totalAccepted == totalAmounts.totalCommitted
        ) {
          timestampLog(
            'All accepted STX has been committed for the next cycle.'
          );
        };
      } else {
        timestampLog(
          "We're in the prepare phase for cycle",
          currentCycle + 1 + '.',
          'Waiting for the next cycle to start in order to resume the operations.'
        );
      }
      await sleep(300_000);
    } catch (error) {
      timestampError('Error:', error);
      await sleep(300_000);
    }
  }
};

main();
