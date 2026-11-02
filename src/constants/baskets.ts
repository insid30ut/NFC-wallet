/**
 * Strict BRC-100 Basket Isolation Constants
 *
 * - 'default': Standard BSV satoshis used for payments and transaction fees.
 * - 'bsv21' (BRC-163): BSV-21 fungible tokens (1-satoshi carrier outputs).
 * - '1sat' (BRC-147): 1Sat Ordinals / NFTs (1-satoshi inscription outputs).
 *
 * Fee selection and standard BSV transfers MUST NEVER spend outputs from
 * 'bsv21' or '1sat' baskets unless explicitly executing a token or NFT transfer.
 */
export const BRC100_BASKETS = {
  DEFAULT: 'default',
  BSV21: 'bsv21',
  ONESAT: '1sat',
} as const;

export type BasketName = (typeof BRC100_BASKETS)[keyof typeof BRC100_BASKETS];

export interface BasketSummary {
  id: BasketName;
  label: string;
  standard: string;
  description: string;
  spendableForFees: boolean;
}

export const BASKET_METADATA: Record<BasketName, BasketSummary> = {
  [BRC100_BASKETS.DEFAULT]: {
    id: BRC100_BASKETS.DEFAULT,
    label: 'Standard BSV',
    standard: 'BRC-100 Default',
    description: 'Standard BSV satoshis used for payments and transaction fees.',
    spendableForFees: true,
  },
  [BRC100_BASKETS.BSV21]: {
    id: BRC100_BASKETS.BSV21,
    label: 'BSV-21 Tokens',
    standard: 'BRC-163',
    description: 'Fungible token 1-satoshi carrier outputs (isolated from fee selection).',
    spendableForFees: false,
  },
  [BRC100_BASKETS.ONESAT]: {
    id: BRC100_BASKETS.ONESAT,
    label: '1Sat Ordinals',
    standard: 'BRC-147',
    description: 'NFT 1-satoshi inscription outputs (isolated from fee selection).',
    spendableForFees: false,
  },
};
