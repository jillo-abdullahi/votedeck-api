import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key';
const JWT_ACCESS_TTL = process.env.JWT_ACCESS_TTL || '7d';

export interface TokenPayload {
    sub: string;
    role: 'host' | 'participant';
    roomId?: string;
}

/**
 * Generate Access Token
 */
export function generateAccessToken(payload: TokenPayload): string {
    return jwt.sign(payload, JWT_SECRET as jwt.Secret, { expiresIn: JWT_ACCESS_TTL as any });
}


/**
 * Verify Access Token
 */
export function verifyAccessToken(token: string): TokenPayload {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
}

/**
 * Get Cookie Options based on environment
 */
export function getCookieOptions(maxAgeSeconds: number = 7 * 24 * 60 * 60) {
    const isProd = process.env.NODE_ENV === 'production';
    return {
        path: '/',
        httpOnly: true,
        // Prod: Needs Secure + SameSite=None for cross-domain
        // Dev: Needs Secure=false + SameSite=Lax for local IP/localhost
        secure: isProd,
        sameSite: isProd ? 'none' as const : 'lax' as const,
        maxAge: maxAgeSeconds
    };
}
