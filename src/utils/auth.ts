import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'another-super-secret-key';
const JWT_ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const JWT_REFRESH_TTL = process.env.JWT_REFRESH_TTL || '7d';

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
 * Generate Refresh Token
 */
export function generateRefreshToken(userId: string): string {
    return jwt.sign({ sub: userId }, JWT_REFRESH_SECRET as jwt.Secret, { expiresIn: JWT_REFRESH_TTL as any });
}

/**
 * Verify Access Token
 */
export function verifyAccessToken(token: string): TokenPayload {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
}

/**
 * Verify Refresh Token
 */
export function verifyRefreshToken(token: string): { sub: string } {
    return jwt.verify(token, JWT_REFRESH_SECRET) as { sub: string };
}
