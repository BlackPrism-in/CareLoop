import 'server-only';
import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { loadConfig } from '@careloop/contracts';

/**
 * Admin SDK singletons. On Cloud Run they use the service's own identity;
 * locally FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST route them to
 * the emulators. Browsers never get database access (rules deny all).
 */
let app: App | undefined;
let db: Firestore | undefined;

export function adminApp(): App {
  if (!app) app = getApps()[0] ?? initializeApp({ projectId: loadConfig().GOOGLE_CLOUD_PROJECT });
  return app;
}

export function firestore(): Firestore {
  if (!db) {
    db = getFirestore(adminApp());
    db.settings({ ignoreUndefinedProperties: false });
  }
  return db;
}

export const adminAuth = () => getAuth(adminApp());
