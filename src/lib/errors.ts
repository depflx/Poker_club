export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'conflict'
  | 'throttled'
  | 'blocked_card'
  | 'unknown_card'
  | 'duplicate_card'
  | 'low_balance'
  | 'table_full'
  | 'already_seated'
  | 'payment_pending'
  | 'not_configured';

/** Messages the PRD requires verbatim (section 14). */
export const MESSAGES = {
  low_balance: 'Low balance. Please visit the counter to recharge.',
  blocked_card: 'This card is blocked. Please visit the counter.',
  unknown_card: 'Card not recognized. Verify the card or contact the counter.',
  duplicate_card: 'This card is already registered. No changes were made.',
  table_full: 'This table has reached its 8-player limit.',
  already_seated: 'This player is already active at a table.',
  payment_pending: 'Payment is pending confirmation. Wallet has not been credited yet.',
  not_configured: 'Guest charge is not configured. Ask the owner to set the guest food policy.',
} as const;

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message?: string,
  ) {
    super(message ?? (MESSAGES as Record<string, string>)[code] ?? code);
    this.name = 'AppError';
  }
}

export const fail = (code: ErrorCode, message?: string): never => {
  throw new AppError(code, message);
};
