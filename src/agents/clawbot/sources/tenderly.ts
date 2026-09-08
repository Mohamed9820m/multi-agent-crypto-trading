import axios from 'axios';
import config from '../../../shared/config';
import logger from '../../../shared/logger';

export interface TenderlySimulationResult {
  success: boolean;
  gasUsed?: number;
  status?: boolean;
  logs?: unknown[];
  error?: string;
}

/**
 * Simulate a raw EVM transaction via Tenderly.
 * Requires TENDERLY_ACCOUNT, TENDERLY_PROJECT, and TENDERLY_API_KEY.
 */
export async function simulateTransaction(
  networkId: string,
  from: string,
  to: string,
  input: string,
  value = '0'
): Promise<TenderlySimulationResult | undefined> {
  if (!config.tenderlyAccount || !config.tenderlyProject || !config.tenderlyApiKey) {
    return undefined;
  }

  try {
    const url = `https://api.tenderly.co/api/v1/account/${config.tenderlyAccount}/project/${config.tenderlyProject}/simulate`;
    const { data } = await axios.post(
      url,
      {
        network_id: networkId,
        from,
        to,
        input,
        value,
        save: false,
        simulation_type: 'full',
      },
      {
        headers: {
          'X-Access-Key': config.tenderlyApiKey,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );

    return {
      success: data?.transaction?.status === true,
      gasUsed: data?.transaction?.gas_used,
      status: data?.transaction?.status,
      logs: data?.transaction?.logs,
      error: data?.transaction?.error_message,
    };
  } catch (err) {
    logger.warn('Tenderly simulation failed', { to, err: (err as Error).message });
    return undefined;
  }
}
