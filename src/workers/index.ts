export { TonPayoutWorker, tonPayoutWorker, type TonDispatchInput, type TonDispatchResult } from './tonPayoutWorker';
export {
  MultiAssetPayoutWorker,
  multiAssetPayoutWorker,
  type MultiAssetDispatchInput,
  type MultiAssetDispatchResult,
  type SupportedPayoutAsset,
} from './multiAssetPayoutWorker';
export { SettlementWorker, settlementWorker } from './settlementWorker';
export {
  startBlockchainListener,
  stopBlockchainListener,
  getListenerStatus,
} from './blockchainListener';

import {
  TonPayoutWorker,
  tonPayoutWorker,
  type TonDispatchInput,
} from './tonPayoutWorker';
import {
  multiAssetPayoutWorker,
  type MultiAssetDispatchInput,
} from './multiAssetPayoutWorker';
import { SettlementWorker, SettlementJob } from './settlementWorker';
import {
  startBlockchainListener,
  stopBlockchainListener,
  getListenerStatus,
} from './blockchainListener';

export const workers = {
  tonPayout: {
    start: () => TonPayoutWorker.start(),
    stop: () => TonPayoutWorker.stop(),
    isValidTonAddress: (address: string) => tonPayoutWorker.isValidTonAddress(address),
    executeRealTonPayout: (input: TonDispatchInput) => tonPayoutWorker.executeRealTonPayout(input),
    processApprovedTonPayouts: () => tonPayoutWorker.processApprovedTonPayouts(),
    reconcileUncertainTonPayouts: () => tonPayoutWorker.reconcileUncertainTonPayouts(),
    getMetrics: () => TonPayoutWorker.getMetrics(),
    getStatus: () => tonPayoutWorker.getStatus(),
  },
  multiAssetPayout: {
    dispatchApprovedPayout: (input: MultiAssetDispatchInput) =>
      multiAssetPayoutWorker.dispatchApprovedPayout(input),
    processApprovedPayouts: () => multiAssetPayoutWorker.processApprovedPayouts(),
    reconcileUncertainPayouts: () => multiAssetPayoutWorker.reconcileUncertainPayouts(),
    getStatus: () => multiAssetPayoutWorker.getStatus(),
  },
  settlement: {
    start: () => SettlementWorker.start(),
    stop: () => SettlementWorker.stop(),
    queueSettlement: (job: SettlementJob) => SettlementWorker.queueSettlement(job),
    getStatus: () => SettlementWorker.getQueueStatus(),
  },
  blockchain: {
    start: startBlockchainListener,
    stop: stopBlockchainListener,
    getStatus: getListenerStatus,
  },
};
