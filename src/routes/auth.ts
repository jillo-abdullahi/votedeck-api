import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { generateAccessToken, generateRefreshToken } from '../utils/auth.js';
import { prisma } from '../db/prisma.js';

export async function authRoutes(fastify: FastifyInstance) {
    /**
     * POST /auth/anonymous
     * Create an anonymous user and return tokens
     */
    fastify.post('/auth/anonymous', async (request, reply) => {
        const userId = nanoid();
        const recoveryCode = nanoid(12);

        // Persist user with recovery code
        await prisma.user.create({
            data: {
                id: userId,
                name: "Anonymous User",
                recoveryCode
            }
        });

        // Generate tokens
        const accessToken = generateAccessToken({
            sub: userId,
            role: 'participant'
        });
        const refreshToken = generateRefreshToken(userId);

        // Set refresh token in cookie
        reply.setCookie('refreshToken', refreshToken, {
            path: '/',
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 // 7 days
        });

        return {
            userId,
            accessToken,
            recoveryCode
        };
    });

    /**
     * POST /auth/restore
     * Restore session via recovery code
     */
    fastify.post('/auth/restore', async (request, reply) => {
        const { recoveryCode } = request.body as { recoveryCode: string };

        if (!recoveryCode) {
            return reply.code(400).send({ error: 'Recovery code required' });
        }

        // Check for new format: [id].[secret]
        const parts = recoveryCode.split('.');
        let user;

        if (parts.length === 2) {
            const [recoveryId, recoverySecret] = parts;
            const bcrypt = await import('bcryptjs');

            user = await prisma.user.findUnique({
                where: { recoveryCode: recoveryId }
            });

            if (user && user.recoveryHash) {
                const isValid = await bcrypt.compare(recoverySecret, user.recoveryHash);
                if (!isValid) user = null;
            } else {
                // Not found or no hash (legacy shouldn't have dot, but just in case)
                user = null;
            }
        } else {
            // Legacy fallback (plain text)
            // Only allow if user does NOT have a hash (so they can't bypass hash with old code)
            user = await prisma.user.findUnique({
                where: { recoveryCode }
            });

            if (user && user.recoveryHash) {
                // If user has a hash, they MUST use the new format.
                user = null;
            }
        }

        if (!user) {
            return reply.code(404).send({ error: 'Invalid recovery code' });
        }

        // Generate new tokens
        const accessToken = generateAccessToken({
            sub: user.id,
            role: 'participant'
        });
        const refreshToken = generateRefreshToken(user.id);

        reply.setCookie('refreshToken', refreshToken, {
            path: '/',
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60
        });

        return {
            userId: user.id,
            accessToken,
            name: user.name,
            recoveryCode
        };
    });

    /**
     * POST /auth/refresh
     * Refresh access token
     */
    fastify.post('/auth/refresh', async (request, reply) => {
        const refreshToken = request.cookies.refreshToken;

        if (!refreshToken) {
            return reply.code(401).send({ error: 'Refresh token missing' });
        }

        try {
            const decoded = fastify.jwt.verify(refreshToken) as { sub: string };
            const accessToken = generateAccessToken({
                sub: decoded.sub,
                role: 'participant'
            });

            return { accessToken };
        } catch (err) {
            return reply.code(401).send({ error: 'Invalid refresh token' });
        }
    });

    /**
     * POST /auth/logout
     * Clear tokens
     */
    fastify.post('/auth/logout', async (request, reply) => {
        reply.clearCookie('refreshToken', { path: '/' });
        return { success: true };
    });
}
