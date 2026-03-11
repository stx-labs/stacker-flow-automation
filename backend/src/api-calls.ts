import axios from 'axios';
import {
  POX_CONTRACT_ADDRESS,
  API_URL,
  LIMIT,
  POX_INFO_URL,
  REWARD_INDEXES_API_URL,
  GET_TRANSACTION_API_URL,
  API_CALLS_TIMEOUT_MS,
  API_CALLS_MAX_RETRIES,
  GET_FEES_URL,
  GET_BALANCE_URL,
} from './consts';
import {
  hexToCV,
  cvToHex,
  cvToJSON,
  tupleCV,
  uintCV,
} from '@stacks/transactions';
import { timestampError } from './helpers';

const instance = axios.create();

instance.defaults.timeout = API_CALLS_TIMEOUT_MS;

const newAbortSignal = (timeoutMs: number) => {
  const abortController = new AbortController();
  setTimeout(() => abortController.abort(), timeoutMs || 0);
  return abortController.signal;
}

export const fetchData = async (offset: number, retry = 0): Promise<any> => {
  try {
    if (retry > API_CALLS_MAX_RETRIES) {
      return null;
    };

    const response = await instance.get(API_URL, {
      params: {
        address: POX_CONTRACT_ADDRESS,
        limit: LIMIT,
        offset: offset,
      },
      signal: newAbortSignal(API_CALLS_TIMEOUT_MS),
    });

    return response.data.events;
  } catch (error: any) {
    if (error.response) {
      if (error.response.status !== 404) {
        await new Promise((resolve) => setTimeout(resolve, 10000));
        return fetchData(offset, retry + 1);
      } else {
        timestampError(`Error: ${error}`);
      }
    } else {
      timestampError(`Error: ${error}`);
    }
    return null;
  }
};

export const getUserUnlockedBalance = async (address: string): Promise<any | null> => {
  for (let retry = 0; retry < API_CALLS_MAX_RETRIES; retry++) {
    try {
      const response = await instance.get(GET_BALANCE_URL(address), { signal: newAbortSignal(API_CALLS_TIMEOUT_MS) });

      return {
        locked: parseInt(response?.data?.locked) || 0,
        total: parseInt(response?.data?.balance) || 0,
      }
    } catch (error: any) {
      if (error.response) {
        if (error.response.status !== 404) {
          await new Promise((resolve) => setTimeout(resolve, API_CALLS_TIMEOUT_MS));
          continue;
        } else {
          timestampError(`Error fetching fees: ${error}`);
        }
      } else {
        timestampError(`Error fetching fees: ${error}`);
      }
      break;
    }
  }

  return {
    locked: null,
    total: null,
  }
}

export const getContractCallFees = async (): Promise<number | null> => {
  for (let retry = 0; retry < API_CALLS_MAX_RETRIES; retry++) {
    try {
      const response = await instance.get(GET_FEES_URL, { signal: newAbortSignal(API_CALLS_TIMEOUT_MS) });

      const fees = (response?.data?.contract_call || response?.data?.all).medium_priority;

      if (fees < 10_000) {
        return 10_000;
      } else if (fees > 100_000) {
        return 100_000;
      } else {
        return fees;
      }
    } catch (error: any) {
      if (error.response) {
        if (error.response.status !== 404) {
          await new Promise((resolve) => setTimeout(resolve, API_CALLS_TIMEOUT_MS));
          continue;
        } else {
          timestampError(`Error fetching fees: ${error}`);
        }
      } else {
        timestampError(`Error fetching fees: ${error}`);
      }
      break;
    };
  };
  return null;
};

export const fetchPoxInfo = async (retry = 0): Promise<any> => {
  try {
    if (retry > API_CALLS_MAX_RETRIES) {
      return null;
    };

    const response = await instance.get(POX_INFO_URL, { signal: newAbortSignal(API_CALLS_TIMEOUT_MS) });

    return response.data;
  } catch (error: any) {
    if (error.response) {
      if (error.response.status !== 404) {
        await new Promise((resolve) => setTimeout(resolve, 10000));
        return fetchPoxInfo(retry + 1);
      } else {
        timestampError(`Error fetching PoX info: ${error}`);
      }
    } else {
      timestampError(`Error fetching PoX info: ${error}`);
    }
    return null;
  }
};

export const fetchRewardCycleIndex = async (
  rewardCycle: number,
  index: number,
  retry = 0,
): Promise<any> => {
  try {
    if (retry > API_CALLS_MAX_RETRIES) {
      return null;
    };

    const data = cvToHex(
      tupleCV({ 'reward-cycle': uintCV(rewardCycle), index: uintCV(index) })
    );

    const response = await instance.post(REWARD_INDEXES_API_URL, data, {
      headers: {
        'Content-Type': 'application/json',
      },
      signal: newAbortSignal(API_CALLS_TIMEOUT_MS),
    });

    return cvToJSON(hexToCV(response.data.data));
  } catch (error: any) {
    if (error.response) {
      if (error.response.status !== 404) {
        await new Promise((resolve) => setTimeout(resolve, 10000));
        return fetchRewardCycleIndex(rewardCycle, index, retry + 1);
      } else {
        timestampError(`Error fetching reward cycle index info: ${error}`);
      }
    } else {
      timestampError(`Error fetching reward cycle index info: ${error}`);
    }
    return null;
  }
};

export const fetchTransactionInfo = async (txid: string, retry = 0): Promise<any> => {
  try {
    if (retry > API_CALLS_MAX_RETRIES) {
      return null;
    };

    const response = await instance.get(GET_TRANSACTION_API_URL(txid.startsWith('0x') ? txid : `0x${txid}`), { signal: newAbortSignal(API_CALLS_TIMEOUT_MS) });

    return response.data;
  } catch (error: any) {
    if (error.response) {
      if (error.response.status !== 404) {
        await new Promise((resolve) => setTimeout(resolve, 10000));
        return fetchTransactionInfo(txid, retry + 1);
      } else if (error.response.status === 404) {
        return null;
      } else {
        timestampError(`Error fetching transaction info: ${error}`);
      }
    } else {
      timestampError(`Error fetching transaction info: ${error}`);
    }
    return null;
  }
};
