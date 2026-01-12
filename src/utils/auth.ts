import admin from 'firebase-admin';
import dotenv from 'dotenv';
import { prisma } from '../db/prisma.js';

dotenv.config();

// Initialize Firebase Admin
// Ideally, use GOOGLE_APPLICATION_CREDENTIALS env var or serviceAccountKey.json
if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.applicationDefault(), // Looks for GOOGLE_APPLICATION_CREDENTIALS
            projectId: process.env.FIREBASE_PROJECT_ID,
        });
        console.log('[Firebase] Admin initialized');
    } catch (error) {
        console.warn('[Firebase] Warning: Failed to initialize Firebase Admin. Auth verification will fail unless mocked or configured.', error);
    }
}

export interface DecodedUser {
    uid: string;
    email?: string;
    name?: string;
    picture?: string;
}

/**
 * Verify Firebase ID Token
 */
export async function verifyAuthToken(token: string): Promise<DecodedUser> {
    if (process.env.NODE_ENV === 'development' && process.env.MOCK_FIREBASE_AUTH === 'true') {
        // Dev backdoor for testing without valid Firebase tokens
        console.log('[Auth] Using MOCK auth verification');
        return {
            uid: token, // treat token as UID
            name: 'Mock User',
            email: 'mock@example.com'
        };
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        return {
            uid: decodedToken.uid,
            email: decodedToken.email,
            name: decodedToken.name,
            picture: decodedToken.picture
        };
    } catch (error) {
        console.error('[Auth] Token verification failed:', error);
        throw new Error('Invalid token');
    }
}

/**
 * Sync User with Database
 * Ensures the user exists in Postgres. Updates profile if needed.
 */
export async function syncUser(user: DecodedUser) {
    return prisma.user.upsert({
        where: { id: user.uid },
        update: {
            // Update fields if they changed (optional, maybe we only want to update explicit fields)
            name: user.name ?? undefined,
            email: user.email ?? undefined,
            avatarUrl: user.picture ?? undefined,
        },
        create: {
            id: user.uid,
            name: user.name || 'Anonymous User',
            email: user.email,
            avatarUrl: user.picture
        }
    });
}
