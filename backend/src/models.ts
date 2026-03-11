export const createDelegationsTable = `
  CREATE TABLE IF NOT EXISTS delegations (
    stacker TEXT NOT NULL,
    start_cycle INTEGER,
    end_cycle INTEGER,
    pox_address TEXT,
    amount_ustx BIGINT NOT NULL
  );
`;

export const createPreviousDelegationsTable = `
  CREATE TABLE IF NOT EXISTS previous_delegations (
    stacker TEXT NOT NULL,
    start_cycle INTEGER,
    end_cycle INTEGER,
    pox_address TEXT,
    amount_ustx BIGINT NOT NULL
  );
`;

export const createAcceptedDelegationsTable = `
  CREATE TABLE IF NOT EXISTS accepted_delegations (
    stacker TEXT NOT NULL,
    start_cycle INTEGER,
    end_cycle INTEGER,
    pox_address TEXT,
    amount_ustx BIGINT NOT NULL
  );
`;

export const createCommittedDelegationsTable = `
  CREATE TABLE IF NOT EXISTS committed_delegations (
    pox_address TEXT NOT NULL,
    start_cycle INTEGER,
    end_cycle INTEGER,
    amount_ustx BIGINT NOT NULL,
    reward_index INTEGER
  );
`;

export const createPendingTransactionsTable = `
  CREATE TABLE IF NOT EXISTS pending_transactions (
    txid TEXT NOT NULL,
    function_name TEXT NOT NULL,
    stacker TEXT,
    pox_address TEXT,
    start_cycle INTEGER,
    end_cycle INTEGER,
    reward_cycle INTEGER,
    reward_index INTEGER
  );
`;

export const createEventsTable = `
  CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    event_index INTEGER,
    event_type TEXT,
    tx_id TEXT,
    contract_id TEXT,
    topic TEXT,
    hex TEXT,
    repr TEXT
  );
`;

export const createRewardIndexesTable = `
  CREATE TABLE IF NOT EXISTS reward_indexes (
    cycle INTEGER,
    reward_index INTEGER,
    pox_address TEXT,
    signer TEXT,
    stacker TEXT,
    total_ustx TEXT
  );
`;

export const clearDelegations = `
  DELETE FROM delegations;
`;

export const clearPreviousDelegations = `
  DELETE FROM previous_delegations;
`;

export const clearAcceptedDelegations = `
  DELETE FROM accepted_delegations;
`;

export const clearCommittedDelegations = `
  DELETE FROM committed_delegations;
`;

export const clearPendingTransactionsByTxid = `
  DELETE FROM pending_transactions WHERE txid = $1
`;

export const clearEvents = `
  DELETE FROM events;
`;

export const clearRewardIndexes = `
  DELETE FROM reward_indexes;
`;

export const insertDelegations = `
  INSERT INTO delegations (stacker, start_cycle, end_cycle, pox_address, amount_ustx)
  VALUES ($1, $2, $3, $4, $5);
`;

export const insertPreviousDelegations = `
  INSERT INTO previous_delegations (stacker, start_cycle, end_cycle, pox_address, amount_ustx)
  VALUES ($1, $2, $3, $4, $5);
`;

export const insertAcceptedDelegations = `
  INSERT INTO accepted_delegations (stacker, start_cycle, end_cycle, pox_address, amount_ustx)
  VALUES ($1, $2, $3, $4, $5);
`;

export const insertCommittedDelegations = `
  INSERT INTO committed_delegations (pox_address, start_cycle, end_cycle, amount_ustx, reward_index)
  VALUES ($1, $2, $3, $4, $5);
`;

export const insertPendingTransactions = `
  INSERT INTO pending_transactions (txid, function_name, stacker, pox_address, start_cycle, end_cycle, reward_cycle, reward_index)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
`;

export const insertEvents = `
  INSERT INTO events (event_index, event_type, tx_id, contract_id, topic, hex, repr)
  VALUES ($1, $2, $3, $4, $5, $6, $7);
`;

export const insertRewardIndexes = `
  INSERT INTO reward_indexes (cycle, reward_index, pox_address, signer, stacker, total_ustx)
  VALUES ($1, $2, $3, $4, $5, $6);
`;

export const selectDelegations = `
SELECT * FROM delegations
`;

export const selectPreviousDelegations = `
SELECT * FROM previous_delegations
`;

export const selectAcceptedDelegations = `
SELECT * FROM accepted_delegations
`;

export const selectCommittedDelegations = `
SELECT * FROM committed_delegations
`;

export const selectPendingTransactions = `
  SELECT * FROM pending_transactions
`;

export const selectEvents = `
  SELECT * FROM events ORDER BY id ASC
`;

export const selectRewardIndexes = `
  SELECT * FROM reward_indexes
`;

export const selectTotalAmounts = `
  SELECT
    COALESCE(SUM(CASE WHEN tableType = 'delegations' THEN amount_ustx END), 0) AS total_delegated,
    COALESCE(SUM(CASE WHEN tableType = 'accepted_delegations' THEN amount_ustx END), 0) AS total_accepted,
    COALESCE(SUM(CASE WHEN tableType = 'committed_delegations' THEN amount_ustx END), 0) AS total_committed
  FROM (
    SELECT 'delegations' AS tableType, amount_ustx
    FROM delegations
    WHERE start_cycle <= $1 AND (end_cycle > $1 OR end_cycle IS NULL)

    UNION ALL

    SELECT 'accepted_delegations' AS tableType, amount_ustx
    FROM accepted_delegations
    WHERE start_cycle <= $1 AND (end_cycle > $1 OR end_cycle IS NULL)

    UNION ALL

    SELECT 'committed_delegations' AS tableType, amount_ustx
    FROM committed_delegations
    WHERE start_cycle <= $1 AND (end_cycle > $1 OR end_cycle IS NULL)
  ) AS combined;
`;
