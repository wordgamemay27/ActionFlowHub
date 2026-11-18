# Security Specification — Firestore Zero-Trust Rules (Non-Financial Profile Only)

## 1. Data Invariants
1. PostgreSQL is the sole authoritative ledger for points, balances, credits, settlements, reserves, and withdrawals.
2. A `UserAccount` document at `/users/{userId}` can only be created by the verified owner (`request.auth.uid == userId`, `email_verified == true`) with `points == 0`, `completedTasksCount == 0`, and `tier == 'TIER 1'`.
3. Subsequent client updates to `/users/{userId}` may modify ONLY non-financial profile attributes (`username`, `firstName`, `walletAddress`, `updatedAt`) and must keep `points`, `completedTasksCount`, `tier`, `uid`, `telegramId`, and `createdAt` unchanged.
4. Client writes (`create`, `update`, `delete`) to `/users/{userId}/transactions/{txId}` are unconditionally denied (`allow create, update, delete: if false`).
5. `/admins/*` is strictly read-only (`allow write: if false`).

## 2. Adversarial Payloads Blocked
1. Unauthenticated read/write to `/users/uid1`.
2. Unverified email user (`email_verified: false`) writing to `/users/uid1`.
3. Cross-user write (`auth.uid = uid2` writing to `/users/uid1`).
4. Creating a user document with non-zero `points` or elevated `tier`.
5. Updating `points`, `completedTasksCount`, or `tier` on `/users/uid1`.
6. Client creating or updating any document in `/users/uid1/transactions/{txId}`.
7. Ghost field injection (`isAdmin: true` or `role: 'admin'` in `/users/uid1`).
8. Oversized ID or string fields (> 128 / 64 chars).
9. Timestamp manipulation (`createdAt != request.time` or `updatedAt != request.time`).
10. Privilege escalation (writing to `/admins/{uid}`).
