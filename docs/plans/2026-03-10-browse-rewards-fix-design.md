# Browse Females + Daily Rewards Fix Design

**Date:** 2026-03-10
**Status:** Approved

## Issues

### Issue 2: Browse section empty despite isAvailable=true
**Root Cause:** Missing Firestore composite index for `gender + isVerified + isAvailable`. Query fails with index error, returns 500.
**Fix:** Add composite index to firestore.indexes.json and deploy via Firebase CLI.

### Issue 1 & 3: Stale isOnline data / Lisa shows "online"
**Root Cause:** Normalization script set isAvailable but didn't clean isOnline. Lisa has stale isOnline=true.
**Fix:** Script to set isOnline=false for all females not currently connected.

### Issue 4: Daily reward permission denied
**Root Cause:** Deployed Firestore security rules may not match local permissive rules.
**Fix:** Deploy firestore.rules (`allow read, write: if true`) to Firebase project.

## Implementation
1. Add composite index to firestore.indexes.json
2. Deploy indexes and rules via Firebase CLI
3. Clean stale isOnline data via script
4. Add error logging to get_available_females endpoint
