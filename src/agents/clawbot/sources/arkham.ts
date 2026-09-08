import axios from 'axios';
import config from '../../../shared/config';
import logger from '../../../shared/logger';

export interface ArkhamEntityInfo {
  address: string;
  entity?: string;
  entityType?: string;
  label?: string;
  riskNotes: string[];
}

/**
 * Fetch Arkham entity labels for a contract/wallet address.
 * Requires ARKHAM_API_KEY.
 */
export async function fetchArkhamEntity(address: string): Promise<ArkhamEntityInfo | undefined> {
  if (!config.arkhamApiKey) return undefined;

  try {
    const { data } = await axios.get(`https://api.arkhamintelligence.com/intelligence/address/${address}`, {
      headers: { 'API-Key': config.arkhamApiKey },
      timeout: 10000,
    });

    const d = data as {
      address?: string;
      entity?: { name?: string; type?: string };
      labels?: { name: string }[];
    };

    const riskNotes: string[] = [];
    const entityName = d.entity?.name;
    if (entityName) {
      const knownBad = ['alameda', 'ftx', '3ac', 'celsius', 'blockfi'];
      if (knownBad.some((b) => entityName.toLowerCase().includes(b))) {
        riskNotes.push(`Address linked to known distressed/insolvent entity: ${entityName}`);
      }
    }

    return {
      address: d.address ?? address,
      entity: entityName,
      entityType: d.entity?.type,
      label: d.labels?.[0]?.name,
      riskNotes,
    };
  } catch (err) {
    logger.warn('Arkham fetch failed', { address, err: (err as Error).message });
    return undefined;
  }
}
