# Data Unification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Normalize and unify all Firestore collections, eliminate duplicate writes, standardize field naming to camelCase, and remove all dual-field fallback logic across backend and frontend.

**Architecture:** Backend standardizes all Firestore writes to camelCase with single canonical fields. Flutter models get a clean `fromFirestore()` conversion layer expecting camelCase. Redundant collections (`male_users_admin`, global `transactions`) are removed. Female earnings read exclusively from `female_earnings` collection.

**Tech Stack:** Node.js (ES modules), Firebase Admin SDK, Flutter/Dart, Firestore

---

### Task 1: Create Shared Schema Constants (Backend)

**Files:**
- Create: `src/shared/schema.js`

**Step 1: Create the schema constants file**

```javascript
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
```

**Step 2: Commit**

```bash
git add src/shared/schema.js
git commit -m "feat: add shared schema constants for canonical Firestore field names"
```

---

### Task 2: Standardize Calls Feature — Field Names & Remove Duplicates (Backend)

**Files:**
- Modify: `src/features/calls/calls.routes.js:122,356,376,455`

**Step 1: Fix coin balance reads (remove coinBalance fallback)**

In `src/features/calls/calls.routes.js`, find all three locations:
- Line 122: `const callerBalance = userData.coins ?? userData.coinBalance ?? 0;`
- Line 356: `const currentBalance = data.coins ?? data.coinBalance ?? 0;`
- Line 376: `return d.coins ?? d.coinBalance ?? 0;`

Replace each with:
```javascript
// Line 122:
const callerBalance = userData.coins ?? 0;
// Line 356:
const currentBalance = data.coins ?? 0;
// Line 376:
return d.coins ?? 0;
```

**Step 2: Remove global transactions collection write**

Find the line near 455:
```javascript
batch.set(db.collection('transactions').doc(spendTxnId), spendTxnData);
```
Delete this line entirely. The `users/{uid}/transactions/{txnId}` write (which should already exist nearby) is the sole write.

**Step 3: Ensure user doc writes use `totalCalls` not `totalCallsReceived`**

Search for any `totalCallsReceived` in this file. If found, replace with `totalCalls`.

**Step 4: Commit**

```bash
git add src/features/calls/calls.routes.js
git commit -m "fix: standardize calls feature to canonical field names, remove global transactions write"
```

---

### Task 3: Standardize Payments Feature — Remove Duplicates (Backend)

**Files:**
- Modify: `src/features/payments/payments.routes.js:220,245-250`

**Step 1: Remove global transactions collection write**

Find near line 220:
```javascript
t.set(db.collection('transactions').doc(transactionId), { ... });
```
Delete this line. The `users/{uid}/transactions/{transactionId}` write is the sole write.

**Step 2: Remove male_users_admin write**

Find near lines 245-250:
```javascript
await db.collection('male_users_admin').doc(userId).set({
  totalCoinsPurchased: FieldValue.increment(package.coins),
  totalPurchaseCount: FieldValue.increment(1),
  totalSpentINR: FieldValue.increment(package.price),
  lastPurchaseAt: FieldValue.serverTimestamp(),
}, { merge: true });
```
Delete this entire block. These fields already exist in `users/{userId}` doc and are updated there.

**Step 3: Commit**

```bash
git add src/features/payments/payments.routes.js
git commit -m "fix: remove duplicate transaction and admin writes from payments"
```

---

### Task 4: Standardize Rewards Feature — Remove Duplicates (Backend)

**Files:**
- Modify: `src/features/rewards/rewards.routes.js:133`

**Step 1: Remove global transactions collection write**

Find near line 133:
```javascript
t.set(db.collection('transactions').doc(transactionId), { ... });
```
Delete this line. Keep only the `users/{uid}/transactions/{transactionId}` write.

**Step 2: Commit**

```bash
git add src/features/rewards/rewards.routes.js
git commit -m "fix: remove duplicate transaction write from rewards"
```

---

### Task 5: Standardize Availability Feature — Field Names (Backend)

**Files:**
- Modify: `src/features/availability/availability.routes.js:379,386,393`

**Step 1: Fix totalCallsReceived → totalCalls**

Find near lines 379 and 386:
```javascript
totalCalls: userData.totalCallsReceived || 0,
```
Replace with:
```javascript
totalCalls: userData.totalCalls || 0,
```

**Step 2: Fix name → displayName**

Find near line 393:
```javascript
name: userData.name || 'Unknown',
```
Replace with:
```javascript
name: userData.displayName || userData.name || 'Unknown',
```
Keep `name` as fallback here since existing user docs may still have `name` field.

**Step 3: Commit**

```bash
git add src/features/availability/availability.routes.js
git commit -m "fix: use canonical field names totalCalls and displayName in availability"
```

---

### Task 6: Standardize Socket Connection Handler (Backend)

**Files:**
- Modify: `src/socket/handlers/connection.handler.js:179`

**Step 1: Fix coinBalance fallback**

Find near line 179:
```javascript
const currentBalance = data.coins ?? data.coinBalance ?? 0;
```
Replace with:
```javascript
const currentBalance = data.coins ?? 0;
```

**Step 2: Commit**

```bash
git add src/socket/handlers/connection.handler.js
git commit -m "fix: remove coinBalance fallback from socket connection handler"
```

---

### Task 7: Update CoinTransaction Model (Flutter)

**Files:**
- Modify: `D:\welbuilt\TingaTalk\lib\models\coin_transaction.dart:50-90`

**Step 1: Update fromJson to expect camelCase from Firestore**

Replace the `fromJson` factory (lines 50-72) with:
```dart
factory CoinTransaction.fromJson(Map<String, dynamic> json) {
  return CoinTransaction(
    id: json['id'] as String,
    userId: json['userId'] as String,
    type: TransactionType.values.firstWhere(
      (e) => e.name == json['type'],
      orElse: () => TransactionType.bonus,
    ),
    status: TransactionStatus.values.firstWhere(
      (e) => e.name == json['status'],
      orElse: () => TransactionStatus.success,
    ),
    coinAmount: json['coinAmount'] as int,
    priceInRupees: (json['priceInRupees'] as num?)?.toDouble(),
    packageId: json['packageId'] as String?,
    paymentGatewayId: json['paymentGatewayId'] as String?,
    paymentMethod: json['paymentMethod'] as String?,
    description: json['description'] as String? ?? '',
    createdAt: DateTime.parse(json['createdAt'] as String),
    updatedAt: DateTime.parse(json['updatedAt'] as String),
    metadata: json['metadata'] as Map<String, dynamic>?,
  );
}
```

**Step 2: Update toJson to output camelCase**

Replace the `toJson` method (lines 74-90) with:
```dart
Map<String, dynamic> toJson() {
  return {
    'id': id,
    'userId': userId,
    'type': type.name,
    'status': status.name,
    'coinAmount': coinAmount,
    'priceInRupees': priceInRupees,
    'packageId': packageId,
    'paymentGatewayId': paymentGatewayId,
    'paymentMethod': paymentMethod,
    'description': description,
    'createdAt': createdAt.toIso8601String(),
    'updatedAt': updatedAt.toIso8601String(),
    'metadata': metadata,
  };
}
```

**Step 3: Add a fromFirestore factory for safe parsing from Firestore docs**

Add after toJson:
```dart
/// Parse from Firestore document data. Expects camelCase fields (backend canonical format).
factory CoinTransaction.fromFirestore(Map<String, dynamic> data, String docId) {
  final typeStr = data['type'] as String? ?? 'bonus';
  final statusStr = data['status'] as String? ?? 'success';

  final type = TransactionType.values.firstWhere(
    (e) => e.name == typeStr,
    orElse: () => TransactionType.bonus,
  );
  final status = TransactionStatus.values.firstWhere(
    (e) => e.name == statusStr,
    orElse: () => TransactionStatus.success,
  );

  DateTime createdAt;
  try {
    createdAt = DateTime.parse(data['createdAt'] as String? ?? '');
  } catch (_) {
    createdAt = DateTime.now();
  }

  DateTime updatedAt;
  try {
    updatedAt = DateTime.parse(data['updatedAt'] as String? ?? '');
  } catch (_) {
    updatedAt = createdAt;
  }

  return CoinTransaction(
    id: data['id'] as String? ?? docId,
    userId: data['userId'] as String? ?? '',
    type: type,
    status: status,
    coinAmount: data['coinAmount'] as int? ?? 0,
    priceInRupees: (data['priceInRupees'] as num?)?.toDouble(),
    packageId: data['packageId'] as String?,
    paymentGatewayId: data['paymentGatewayId'] as String?,
    paymentMethod: data['paymentMethod'] as String?,
    description: data['description'] as String? ?? 'Transaction',
    createdAt: createdAt,
    updatedAt: updatedAt,
    metadata: data['metadata'] as Map<String, dynamic>?,
  );
}
```

**Step 4: Commit**

```bash
git add lib/models/coin_transaction.dart
git commit -m "fix: update CoinTransaction model to use camelCase, add fromFirestore factory"
```

---

### Task 8: Update CoinPackage Model (Flutter)

**Files:**
- Modify: `D:\welbuilt\TingaTalk\lib\models\coin_package.dart:27,40`

**Step 1: Update fromJson to expect camelCase**

Replace near line 27:
```dart
coinAmount: json['coin_amount'] as int,
```
with:
```dart
coinAmount: json['coinAmount'] as int? ?? json['coin_amount'] as int? ?? 0,
```
Note: Keep snake_case fallback here because packages are server constants that may still use snake_case.

**Step 2: Update toJson to output camelCase**

Replace near line 40:
```dart
'coin_amount': coinAmount,
```
with:
```dart
'coinAmount': coinAmount,
```

**Step 3: Commit**

```bash
git add lib/models/coin_package.dart
git commit -m "fix: update CoinPackage model to prefer camelCase fields"
```

---

### Task 9: Remove _parseTransactionFromFirestore & Use Model (Flutter)

**Files:**
- Modify: `D:\welbuilt\TingaTalk\lib\screens\male\male_transactions_screen.dart:84-95,843-927`

**Step 1: Replace custom parsing with CoinTransaction.fromFirestore**

Find the transaction parsing loop (near lines 84-95) that calls `_parseTransactionFromFirestore`. Replace the body with:
```dart
for (final doc in transactionsSnapshot.docs) {
  try {
    final data = doc.data();
    final transaction = CoinTransaction.fromFirestore(data, doc.id);
    transactions.add(transaction);
  } catch (e) {
    if (kDebugMode) print('Error parsing transaction ${doc.id}: $e');
  }
}
```

**Step 2: Delete the entire `_parseTransactionFromFirestore` method**

Delete lines 843-927 (the entire method).

**Step 3: Commit**

```bash
git add lib/screens/male/male_transactions_screen.dart
git commit -m "fix: use CoinTransaction.fromFirestore, remove duplicate parsing method"
```

---

### Task 10: Update ProductionCoinService — Remove snake_case References (Flutter)

**Files:**
- Modify: `D:\welbuilt\TingaTalk\lib\services\production_coin_service.dart:193,268,274`

**Step 1: Update Firestore queries to use camelCase field names**

Find near line 193:
```dart
.where('payment_gateway_id', isEqualTo: paymentGatewayId)
```
Replace with:
```dart
.where('paymentGatewayId', isEqualTo: paymentGatewayId)
```

Find near lines 268 and 274, any snake_case field writes like:
```dart
'payment_gateway_id': paymentGatewayId,
```
Replace with:
```dart
'paymentGatewayId': paymentGatewayId,
```

Do the same for any other snake_case fields in Firestore write maps in this file.

**Step 2: Commit**

```bash
git add lib/services/production_coin_service.dart
git commit -m "fix: use camelCase field names in ProductionCoinService Firestore operations"
```

---

### Task 11: Update NewFemaleEarningsService — Remove Fallbacks & daily_stats (Flutter)

**Files:**
- Modify: `D:\welbuilt\TingaTalk\lib\services\new_female_earnings_service.dart:144,154,590`

**Step 1: Fix totalCallsReceived → totalCalls**

Find near line 144:
```dart
'totalCallsReceived': FieldValue.increment(1),
```
Replace with:
```dart
'totalCalls': FieldValue.increment(1),
```

**Step 2: Remove or redirect daily_stats subcollection write**

Find near line 154 the write to `.collection('daily_stats')`. Either:
- Remove it entirely (if `female_earnings/{id}/daily` covers the same data), OR
- Redirect to write to `female_earnings/{id}/daily` instead

Verify by reading the surrounding context which is correct.

**Step 3: Remove earnings fallback pattern**

Find near line 590:
```dart
final availableBalance = (summary['availableBalanceINR'] ?? summary['availableBalance'] ?? 0.0).toDouble();
```
Replace with:
```dart
final availableBalance = (summary['availableBalanceINR'] ?? 0.0).toDouble();
```

**Step 4: Commit**

```bash
git add lib/services/new_female_earnings_service.dart
git commit -m "fix: use canonical field names, remove fallback patterns in female earnings service"
```

---

### Task 12: Update User Stats & Rankings Services — totalCallsReceived → totalCalls (Flutter)

**Files:**
- Modify: `D:\welbuilt\TingaTalk\lib\services\user_stats_service.dart:63,169,227`
- Modify: `D:\welbuilt\TingaTalk\lib\services\rankings_service.dart:54,98,142`

**Step 1: Update user_stats_service.dart**

Find and replace all three locations:
- Line 63: `totalCalls: userData['totalCallsReceived'] ?? 0,` → `totalCalls: userData['totalCalls'] ?? 0,`
- Line 169: `'totalCallsReceived': stats.totalCalls,` → `'totalCalls': stats.totalCalls,`
- Line 227: `totalCalls: data['totalCallsReceived'] ?? 0,` → `totalCalls: data['totalCalls'] ?? 0,`

**Step 2: Update rankings_service.dart**

Find and replace all three locations:
- Line 54: `'totalCalls': data['totalCallsReceived'] ?? 0,` → `'totalCalls': data['totalCalls'] ?? 0,`
- Line 98: `'totalCalls': data['totalCallsReceived'] ?? 0,` → `'totalCalls': data['totalCalls'] ?? 0,`
- Line 142: `'totalCalls': data['totalCallsReceived'] ?? 0,` → `'totalCalls': data['totalCalls'] ?? 0,`

**Step 3: Commit**

```bash
git add lib/services/user_stats_service.dart lib/services/rankings_service.dart
git commit -m "fix: use totalCalls instead of totalCallsReceived in stats and rankings"
```

---

### Task 13: Remove Admin Tracking Services & References (Flutter)

**Files:**
- Modify: `D:\welbuilt\TingaTalk\lib\services\admin_user_sync_service.dart:14,66,88`
- Modify: `D:\welbuilt\TingaTalk\lib\services\male_user_tracking_service.dart:49-107`
- Modify: `D:\welbuilt\TingaTalk\lib\services\user_service.dart:405`

**Step 1: Remove male_users_admin writes from admin_user_sync_service.dart**

Find the write to `.collection('male_users_admin')` near line 14 and the write to `.collection('female_users_admin')` near line 66. Remove these writes entirely — the data is already in `users` and `female_earnings` collections.

Also fix line 88:
```dart
'totalCallsReceived': userData['totalCallsReceived'] ?? 0,
```
If this is part of the removed admin sync, delete it. If it writes to `users`, change to `'totalCalls'`.

**Step 2: Remove or gut male_user_tracking_service.dart**

Lines 49-107 contain writes to `male_users_admin`. Remove all writes to this collection. If the service has no other purpose, mark it for deletion or remove the file entirely.

**Step 3: Fix user_service.dart**

Find near line 405:
```dart
'totalCallsReceived': 0,
```
Replace with:
```dart
'totalCalls': 0,
```

**Step 4: Commit**

```bash
git add lib/services/admin_user_sync_service.dart lib/services/male_user_tracking_service.dart lib/services/user_service.dart
git commit -m "fix: remove redundant admin collection writes, use canonical field names"
```

---

### Task 14: Update Firestore Indexes (Flutter)

**Files:**
- Modify: `D:\welbuilt\TingaTalk\firestore.indexes.json:90`

**Step 1: Update index for totalCallsReceived → totalCalls**

Find near line 90 the index definition referencing `totalCallsReceived`. Change the field name to `totalCalls`.

**Step 2: Commit**

```bash
git add firestore.indexes.json
git commit -m "fix: update Firestore index from totalCallsReceived to totalCalls"
```

---

### Task 15: End-to-End Verification

**Step 1: Verify backend starts without errors**

```bash
cd D:\welbuilt\tingatalk-backend
npm start
```
Expected: Server starts, no import errors or missing references.

**Step 2: Search for any remaining deprecated patterns in backend**

Search for: `coinBalance`, `totalCallsReceived`, `male_users_admin`, `db.collection('transactions').doc` (global writes)
Expected: Zero matches (except in schema.js DEPRECATED_COLLECTIONS constant).

**Step 3: Search for any remaining deprecated patterns in frontend**

Search for: `coin_amount`, `price_in_rupees`, `payment_gateway_id`, `created_at` (as Firestore fields), `totalCallsReceived`, `male_users_admin`, `female_users_admin`, `coinBalance`, `daily_stats`
Expected: Zero matches in active code (comments/docs are OK).

**Step 4: Verify Flutter app builds**

```bash
cd D:\welbuilt\TingaTalk
flutter analyze
flutter build apk --debug
```
Expected: No analysis errors related to changed files, build succeeds.

**Step 5: Commit verification notes**

```bash
git commit --allow-empty -m "chore: data unification verified — all collections normalized"
```

---

## Summary of All Changes

| Task | Scope | What Changes |
|------|-------|-------------|
| 1 | Backend | Create shared schema constants |
| 2 | Backend | Calls: remove coinBalance fallback, remove global txn write |
| 3 | Backend | Payments: remove global txn write, remove male_users_admin write |
| 4 | Backend | Rewards: remove global txn write |
| 5 | Backend | Availability: totalCalls, displayName |
| 6 | Backend | Socket: remove coinBalance fallback |
| 7 | Flutter | CoinTransaction model: camelCase + fromFirestore |
| 8 | Flutter | CoinPackage model: camelCase |
| 9 | Flutter | Male transactions screen: use fromFirestore, delete old parser |
| 10 | Flutter | ProductionCoinService: camelCase queries |
| 11 | Flutter | FemaleEarningsService: remove fallbacks, fix daily_stats |
| 12 | Flutter | Stats + Rankings: totalCalls |
| 13 | Flutter | Remove admin tracking writes |
| 14 | Flutter | Update Firestore indexes |
| 15 | Both | End-to-end verification |
