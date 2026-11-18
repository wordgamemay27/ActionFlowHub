export interface WalletConfig {
  receiveAddress: string;
  payoutAddresses: string[];
  privateKey: string;
  network: string;
}

export const WALLET_CONFIG: Record<string, WalletConfig> = {
  TON: {
    receiveAddress: process.env.TON_RECEIVE_ADDRESS || 'UQCJoPeBgp-vRgm5i9cvCxKhdwEnup8y7zr2rYDp2_RYTNvD',
    payoutAddresses: [
      process.env.TON_PAYOUT_ADDRESS_1 || 'UQArcaLwWBTXqOfyJCy3mjPSEuD80p66jzF_95HyXRShBOo-',
      process.env.TON_PAYOUT_ADDRESS_2 || '',
    ].filter(Boolean),
    privateKey: process.env.TON_WALLET_PRIVATE_KEY || '',
    network: process.env.TON_NETWORK || 'mainnet',
  },
  SOL: {
    receiveAddress: process.env.SOL_RECEIVE_ADDRESS || 'ASbti3qd3EpJ57Aa7z9QDegWr8ub8UzmxHJZaPx9aMQo',
    payoutAddresses: [
      process.env.SOL_PAYOUT_ADDRESS_1 || 'FCiSaZcMYYPyzkJQkfNXdnw4v2PjiR241KYpEm2FeqdT',
      process.env.SOL_PAYOUT_ADDRESS_2 || '',
    ].filter(Boolean),
    privateKey: process.env.SOL_WALLET_PRIVATE_KEY || '',
    network: process.env.SOL_NETWORK || 'mainnet',
  },
  PI: {
    receiveAddress: process.env.PI_RECEIVE_ADDRESS || 'GBUSXBXUBHPUXKGZYAGFSPU4LRZGIWB62L5PPIG2RGUXMMIP66KABTVE',
    payoutAddresses: [
      process.env.PI_PAYOUT_ADDRESS_1 || 'GBUSXBXUBHPUXKGZYAGFSPU4LRZGIWB62L5PPIG2RGUXMMIP66KABTVE',
      process.env.PI_PAYOUT_ADDRESS_2 || '',
    ].filter(Boolean),
    privateKey: process.env.PI_WALLET_PRIVATE_KEY || '',
    network: process.env.PI_NETWORK || 'mainnet',
  },
};

export function getWalletConfig(token: 'TON' | 'SOL' | 'PI') {
  return WALLET_CONFIG[token];
}
