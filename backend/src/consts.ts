import {
  StacksDevnet,
  StacksMainnet,
  StacksNetwork,
  StacksNetworkName,
  StacksTestnet,
} from '@stacks/network';
import { Network as BitcoinNetworkName } from 'bitcoin-address-validation';
import dotenv from 'dotenv';
dotenv.config();

export enum NetworkUsed {
  Mainnet = 'mainnet',
  Testnet = 'testnet',
  Devnet = 'devnet',
}

export const NETWORK: NetworkUsed = process.env.NETWORK as NetworkUsed;

// Function to map NetworkUsed to StacksNetworkName
const getStacksNetworkName = (network: NetworkUsed): StacksNetworkName => {
  switch (network) {
    case NetworkUsed.Mainnet:
      return 'mainnet';
    case NetworkUsed.Devnet:
      return 'devnet';
    case NetworkUsed.Testnet:
    default:
      return 'testnet';
  }
};

const getBitcoinNetworkName = (network: NetworkUsed): BitcoinNetworkName => {
  switch (network) {
    case NetworkUsed.Mainnet:
      return BitcoinNetworkName.mainnet;
    case NetworkUsed.Devnet:
    case NetworkUsed.Testnet:
    default:
      return BitcoinNetworkName.testnet;
  }
};

export const STACKS_NETWORK_NAME: StacksNetworkName =
  getStacksNetworkName(NETWORK);

export const BITCOIN_NETWORK_NAME: BitcoinNetworkName =
  getBitcoinNetworkName(NETWORK);

const getStacksNetworkInstance = (network: NetworkUsed): StacksNetwork => {
  switch (network) {
    case NetworkUsed.Mainnet:
      return new StacksMainnet({
        url: process.env.API_URL || 'https://api.mainnet.hiro.so',
      });
    case NetworkUsed.Devnet:
      return new StacksDevnet({
        url: process.env.API_URL || 'http://localhost:3999',
      });
    case NetworkUsed.Testnet:
    default:
      return new StacksTestnet({
        url: process.env.API_URL || 'https://api.testnet.hiro.so',
      });
  }
};

export const STACKS_NETWORK_INSTANCE: StacksNetwork =
  getStacksNetworkInstance(NETWORK);

const API_CONFIG = {
  [NetworkUsed.Mainnet]: {
    API_BASE_URL: process.env.API_URL || 'https://api.mainnet.hiro.so',
    POX_CONTRACT_ADDRESS: 'SP000000000000000000002Q6VF78.pox-4',
    FIRST_POX_4_CYCLE: 84,
  },
  [NetworkUsed.Testnet]: {
    API_BASE_URL: process.env.API_URL || 'https://api.testnet.hiro.so',
    POX_CONTRACT_ADDRESS: 'ST000000000000000000002AMW42H.pox-4',
    FIRST_POX_4_CYCLE: 1,
  },
  [NetworkUsed.Devnet]: {
    API_BASE_URL: process.env.API_URL || 'http://localhost:3999',
    POX_CONTRACT_ADDRESS: 'ST000000000000000000002AMW42H.pox-4',
    FIRST_POX_4_CYCLE: 1,
  },
};

const currentConfig = API_CONFIG[NETWORK];

export const DATABASE_CONFIG = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  database: process.env.POSTGRES_DB || 'stacker_flow_automation',
};

export const API_URL = `${currentConfig.API_BASE_URL}/extended/v1/tx/events`;
export const GET_FEES_URL = `${currentConfig.API_BASE_URL}/extended/v2/mempool/fees`;
export const GET_BALANCE_URL = (address: string) =>
  `${currentConfig.API_BASE_URL}/extended/v1/address/${address}/stx?unanchored=true`;
export const POX_INFO_URL = `${currentConfig.API_BASE_URL}/v2/pox`;
export const REWARD_INDEXES_API_URL = `${
  currentConfig.API_BASE_URL
}/v2/map_entry/${
  currentConfig.POX_CONTRACT_ADDRESS.split('.')[0]
}/pox-4/reward-cycle-pox-address-list`;
export const GET_TRANSACTION_API_URL = (txid: string) =>
  `${currentConfig.API_BASE_URL}/extended/v1/tx/${txid}`;
export const POX_CONTRACT_ADDRESS = currentConfig.POX_CONTRACT_ADDRESS;

export const POOL_OPERATOR = process.env.POOL_OPERATOR || '';
export const POOL_BTC_ADDRESS = process.env.POOL_BTC_ADDRESS || '';
export const POOL_PRIVATE_KEY = process.env.POOL_PRIVATE_KEY;
export const SIGNER_PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY;

export const FIRST_POX_4_CYCLE = currentConfig.FIRST_POX_4_CYCLE;

export const LIMIT = 100;
export const SERVER_PORT = parseInt(process.env.SERVER_PORT || '8080');
export const PROMETHEUS_PORT = process.env.PROMETHEUS_PORT || 9123;
export const API_CALLS_MAX_RETRIES = 7;
export const API_CALLS_TIMEOUT_MS = parseInt(
  process.env.API_CALLS_TIMEOUT_MS || '10000'
);
export const DETAILED_LOGS = process.env.DETAILED_LOGS == 'true' || false;

export const MAX_CYCLES_FOR_OPERATIONS = parseInt(
  process.env.MAX_CYCLES_FOR_OPERATIONS as string || '1'
);
