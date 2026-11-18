import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { UserProfile } from '../types';

function sanitizeId(raw: string, fallback: string): string {
  const cleaned = String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Sincronizza ESCLUSIVAMENTE metadati di profilo non finanziari su Firestore.
 * Saldi, punti, transazioni e prelievi risiedono esclusivamente su PostgreSQL.
 */
export async function upsertUserAccountInCloud(
  uid: string,
  profile: UserProfile
): Promise<void> {
  const safeUid = sanitizeId(uid, 'user_default');
  const path = `users/${safeUid}`;
  const ref = doc(db, 'users', safeUid);

  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        uid: safeUid,
        telegramId: Number(profile.telegramId) || 0,
        username: String(profile.username || '').slice(0, 64),
        firstName: String(profile.firstName || '').slice(0, 64),
        points: 0,
        completedTasksCount: 0,
        walletAddress: String(profile.walletAddress || '').slice(0, 128),
        tier: 'TIER 1',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        username: String(profile.username || '').slice(0, 64),
        firstName: String(profile.firstName || '').slice(0, 64),
        walletAddress: String(profile.walletAddress || '').slice(0, 128),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function fetchUserCloudData(uid: string): Promise<{
  username?: string;
  firstName?: string;
  walletAddress?: string;
}> {
  const safeUid = sanitizeId(uid, 'user_default');
  const userPath = `users/${safeUid}`;

  let username: string | undefined;
  let firstName: string | undefined;
  let walletAddress: string | undefined;

  try {
    const userSnap = await getDoc(doc(db, 'users', safeUid));
    if (userSnap.exists()) {
      const data = userSnap.data();
      if (typeof data.username === 'string') username = data.username;
      if (typeof data.firstName === 'string') firstName = data.firstName;
      if (typeof data.walletAddress === 'string') walletAddress = data.walletAddress;
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, userPath);
  }

  return { username, firstName, walletAddress };
}
