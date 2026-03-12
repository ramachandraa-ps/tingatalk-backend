// src/shared/schema.js
// Canonical field names for all Firestore collections.
// Every feature module must reference these constants instead of hardcoding strings.

export const COLLECTIONS = {
  USERS: 'users',
  CALLS: 'calls',
  FEMALE_EARNINGS: 'female_earnings',
  PAYMENT_VERIFICATIONS: 'payment_verifications',
  ADMIN_ANALYTICS: 'admin_analytics',
};

// Subcollections
export const SUBCOLLECTIONS = {
  USER_TRANSACTIONS: 'transactions',       // users/{uid}/transactions
  FEMALE_DAILY: 'daily',                   // female_earnings/{uid}/daily
  FEMALE_TRANSACTIONS: 'transactions',     // female_earnings/{uid}/transactions
};

// Canonical user document fields (camelCase only)
export const USER_FIELDS = {
  COINS: 'coins',                          // NOT coinBalance
  DISPLAY_NAME: 'displayName',             // NOT name
  TOTAL_CALLS: 'totalCalls',              // NOT totalCallsReceived
  TOTAL_COINS_SPENT: 'totalCoinsSpent',
  TOTAL_COINS_ACQUIRED: 'totalCoinsAcquired',
  TOTAL_COINS_PURCHASED: 'totalCoinsPurchased',
  TOTAL_PURCHASE_COUNT: 'totalPurchaseCount',
};

// Collections that are REMOVED (do not write to these)
export const DEPRECATED_COLLECTIONS = {
  GLOBAL_TRANSACTIONS: 'transactions',     // Use users/{uid}/transactions instead
  MALE_USERS_ADMIN: 'male_users_admin',    // Data lives in users collection
};
