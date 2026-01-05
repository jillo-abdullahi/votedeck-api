import type { Room, RoomState, User, VotingSystemId } from '../types/index.js';
import { generateRoomId } from '../utils/roomId.js';
import { redis } from '../db/redis.js';
import { prisma } from '../db/prisma.js';

const ROOM_TTL = 24 * 60 * 60; // 24 hours

export const roomStore = {
    /**
     * Create a new room
     */
    async createRoom(name: string, votingSystem: VotingSystemId, adminId: string): Promise<Room> {
        const roomId = generateRoomId();

        // Persist in Postgres
        console.log(`[createRoom] Creating room ${roomId} in Postgres...`);
        const pgRoom = await (prisma.room as any).create({
            data: {
                id: roomId,
                name,
                adminId,
                votingSystem,
                revealed: false,
            }
        });
        console.log(`[createRoom] Postgres room created. Saving to Redis...`);

        // Persist in Redis
        const roomMeta = {
            id: roomId,
            name,
            adminId,
            votingSystem,
            revealPolicy: 'everyone',
            revealed: 'false',
            createdAt: pgRoom.createdAt.toISOString(),
        };

        try {
            await redis.hset(`room:${roomId}:meta`, roomMeta);
            // ioredis syntax
            await redis.expire(`room:${roomId}:meta`, ROOM_TTL);
            console.log(`[createRoom] Redis save successful.`);
        } catch (err) {
            console.error(`[createRoom] Redis save failed:`, err);
            // Don't throw, let it return (Postgres is source of truth)
        }

        return {
            ...roomMeta,
            revealed: false,
            createdAt: pgRoom.createdAt,
            users: new Map(),
            votes: new Map(),
        } as unknown as Room;
    },

    /**
     * Get room by ID
     */
    async getRoom(roomId: string): Promise<any | undefined> {
        let meta: any = null;
        try {
            meta = await redis.hgetall(`room:${roomId}:meta`);
        } catch (err) {
            console.warn(`[getRoom] Redis lookup failed for ${roomId}, falling back to DB:`, err);
            // Fallthrough to Postgres
        }

        // Fallback to Postgres if not in Redis
        if (!meta || Object.keys(meta).length === 0) {
            const pgRoom = await prisma.room.findUnique({
                where: { id: roomId }
            });

            if (!pgRoom) return undefined;

            // Re-populate Redis
            meta = {
                id: pgRoom.id,
                name: pgRoom.name,
                adminId: pgRoom.adminId,
                votingSystem: pgRoom.votingSystem,
                revealPolicy: 'everyone', // Default
                revealed: String((pgRoom as any).revealed),
                createdAt: pgRoom.createdAt.toISOString(),
            };

            try {
                await redis.hset(`room:${roomId}:meta`, meta);
                await redis.expire(`room:${roomId}:meta`, ROOM_TTL);
            } catch (err) {
                console.warn(`[getRoom] Failed to repopulate Redis for ${roomId}:`, err);
                // Continue, returning the room from Postgres data
            }
        }

        return {
            ...meta,
            // Cast strictly to string to handle both "true" string and true boolean
            revealed: String((meta as any).revealed) === 'true',
            createdAt: new Date((meta as any).createdAt),
        };
    },

    /**
     * Add user to room
     */
    async addUser(roomId: string, user: User): Promise<boolean> {
        const exists = await redis.exists(`room:${roomId}:meta`);
        if (!exists) {
            // If room doesn't exist in Redis, try to restore it first
            const room = await this.getRoom(roomId);
            if (!room) return false;
        }

        // Persist in Postgres
        await prisma.user.upsert({
            where: { id: user.id },
            update: { name: user.name },
            create: { id: user.id, name: user.name },
        });

        const multi = redis.pipeline();
        multi.sadd(`room:${roomId}:users`, user.id);
        multi.hset(`room:${roomId}:user_data`, { [user.id]: JSON.stringify(user) });

        // Track participation in Postgres
        await (prisma as any).participant.upsert({
            where: { roomId_userId: { roomId, userId: user.id } },
            update: { joinedAt: new Date() }, // Update joinedAt on re-join
            create: { roomId, userId: user.id }
        });

        // REMOVED: multi.hdel(`room:${roomId}:votes`, user.id); -- Keep votes for reloads

        multi.sadd(`room:${roomId}:user:${user.id}:sockets`, user.socketId || '');
        multi.expire(`room:${roomId}:user:${user.id}:sockets`, ROOM_TTL);

        multi.expire(`room:${roomId}:users`, ROOM_TTL);
        multi.expire(`room:${roomId}:user_data`, ROOM_TTL);
        multi.expire(`room:${roomId}:votes`, ROOM_TTL);

        await multi.exec();
        return true;
    },

    /**
     * Remove user from room
     */
    async removeUser(roomId: string, userId: string): Promise<boolean> {
        const meta = await this.getRoom(roomId);
        if (!meta) return false;

        const multi = redis.pipeline();
        multi.srem(`room:${roomId}:users`, userId);
        // Clean up sockets set just in case
        multi.del(`room:${roomId}:user:${userId}:sockets`);

        await multi.exec();

        return true;
    },

    /**
     * Remove a specific socket for a user.
     * Only removes the user from the room if they have no other sockets connected.
     */
    async removeSocketFromUser(roomId: string, userId: string, socketId: string): Promise<boolean> {
        const socketSetKey = `room:${roomId}:user:${userId}:sockets`;

        // Remove this specific socket
        await redis.srem(socketSetKey, socketId);

        // Check how many are left
        const remainingSockets = await redis.scard(socketSetKey);

        if (remainingSockets > 0) {
            // User still has other tabs open, don't remove them from the room
            return false;
        }

        // No sockets left, remove user completely
        return await this.removeUser(roomId, userId);
    },

    /**
     * Update user information
     */
    async updateUser(roomId: string, userId: string, updates: Partial<User>): Promise<boolean> {
        const userData = await redis.hget(`room:${roomId}:user_data`, userId);
        if (!userData) return false;

        const user = typeof userData === 'string'
            ? JSON.parse(userData)
            : (userData as unknown as User);
        const updatedUser = { ...user, ...updates };

        // Update Postgres
        if (updates.name) {
            await prisma.user.update({
                where: { id: userId },
                data: { name: updates.name },
            });
        }

        await redis.hset(`room:${roomId}:user_data`, { [userId]: JSON.stringify(updatedUser) });
        return true;
    },

    /**
     * Update room settings
     */
    async updateSettings(roomId: string, updates: Partial<Pick<Room, 'name' | 'votingSystem' | 'revealPolicy'>>): Promise<boolean> {
        const exists = await redis.exists(`room:${roomId}:meta`);
        if (!exists) return false;

        if (updates.name !== undefined) {
            await redis.hset(`room:${roomId}:meta`, { name: updates.name });
            await (prisma.room as any).update({
                where: { id: roomId },
                data: { name: updates.name },
            });
        }
        if (updates.votingSystem !== undefined) {
            await redis.hset(`room:${roomId}:meta`, { votingSystem: updates.votingSystem });
            await (prisma.room as any).update({
                where: { id: roomId },
                data: { votingSystem: updates.votingSystem },
            });
        }
        if (updates.revealPolicy !== undefined) {
            await redis.hset(`room:${roomId}:meta`, { revealPolicy: updates.revealPolicy });
        }

        return true;
    },

    /**
     * Get user by socket ID
     */
    async getUserBySocketId(socketId: string): Promise<{ user: User; roomId: string } | undefined> {
        const mapping = await redis.get(`socket:${socketId}`);
        if (!mapping) return undefined;

        const { userId, roomId } = typeof mapping === 'string'
            ? JSON.parse(mapping)
            : (mapping as unknown as { userId: string; roomId: string });
        const userData = await redis.hget(`room:${roomId}:user_data`, userId) as string;
        if (!userData) return undefined;

        const user = typeof userData === 'string'
            ? JSON.parse(userData)
            : (userData as unknown as User);

        return { user, roomId };
    },

    /**
     * Map socket ID to user and room
     */
    async mapSocket(socketId: string, userId: string, roomId: string) {
        try {
            await redis.set(`socket:${socketId}`, JSON.stringify({ userId, roomId }), 'EX', ROOM_TTL);
        } catch (err) {
            console.error(`[mapSocket] Redis set failed for ${socketId}:`, err);
        }
    },

    /**
     * Unmap socket ID
     */
    async unmapSocket(socketId: string) {
        await redis.del(`socket:${socketId}`);
    },

    /**
     * Cast a vote
     */
    async castVote(roomId: string, userId: string, value: string): Promise<boolean> {
        const meta = await this.getRoom(roomId);
        if (!meta || meta.revealed) return false;

        const voteValue = (value === null || value === "") ? "" : value;

        if (voteValue === "") {
            await redis.hdel(`room:${roomId}:votes`, userId);
            await (prisma as any).vote.deleteMany({
                where: { roomId, userId }
            });
        } else {
            await redis.hset(`room:${roomId}:votes`, { [userId]: voteValue });
            await (prisma as any).vote.upsert({
                where: { roomId_userId: { roomId, userId } },
                update: { value: voteValue },
                create: { roomId, userId, value: voteValue }
            });
        }
        return true;
    },

    /**
     * Reveal all votes
     */
    async revealVotes(roomId: string): Promise<boolean> {
        const exists = await redis.exists(`room:${roomId}:meta`);
        if (!exists) return false;

        if (!exists) return false;

        await redis.hset(`room:${roomId}:meta`, { revealed: 'true' });
        await (prisma.room as any).update({
            where: { id: roomId },
            data: { revealed: true }
        });
        return true;
    },

    /**
     * Reset votes
     */
    async resetVotes(roomId: string): Promise<boolean> {
        const exists = await redis.exists(`room:${roomId}:meta`);
        if (!exists) return false;

        const multi = redis.pipeline();
        // Upstash might serialize 'false' as boolean false, so we handle that in getRoom
        multi.hset(`room:${roomId}:meta`, { revealed: 'false' });
        multi.del(`room:${roomId}:votes`);
        await multi.exec();

        await (prisma.room as any).update({
            where: { id: roomId },
            data: { revealed: false }
        });
        await (prisma as any).vote.deleteMany({
            where: { roomId }
        });

        return true;
    },

    /**
     * Get room state for broadcasting
     */
    async getRoomState(roomId: string, forUserId?: string): Promise<RoomState | undefined> {
        const meta = await this.getRoom(roomId);
        if (!meta) return undefined;

        let userIds = await redis.smembers(`room:${roomId}:users`);
        let userDataMap = await redis.hgetall(`room:${roomId}:user_data`) || {};
        let voteMap = await redis.hgetall(`room:${roomId}:votes`) || {};

        // RESTORE FROM POSTGRES if Redis is empty but metadata exists
        // This handles cases where room expired from Redis but we want to view history
        if (userIds.length === 0) {
            const participants = await (prisma as any).participant.findMany({ where: { roomId } });
            if (participants.length > 0) {
                const pUserIds = participants.map((p: any) => p.userId);

                // Fetch users details
                const users = await prisma.user.findMany({ where: { id: { in: pUserIds } } });

                // Fetch votes
                const votes = await (prisma as any).vote.findMany({ where: { roomId } });

                if (users.length > 0) {
                    const multi = redis.pipeline();

                    // Repopulate Users
                    users.forEach((u: any) => {
                        multi.sadd(`room:${roomId}:users`, u.id);
                        multi.hset(`room:${roomId}:user_data`, { [u.id]: JSON.stringify({ id: u.id, name: u.name }) });
                        // Update local vars for this response
                        userIds.push(u.id);
                        if (userDataMap) userDataMap[u.id] = JSON.stringify({ id: u.id, name: u.name });
                    });

                    // Repopulate Votes
                    votes.forEach((v: any) => {
                        multi.hset(`room:${roomId}:votes`, { [v.userId]: v.value });
                        if (voteMap) voteMap[v.userId] = v.value;
                    });

                    // Set expiry
                    multi.expire(`room:${roomId}:users`, ROOM_TTL);
                    multi.expire(`room:${roomId}:user_data`, ROOM_TTL);
                    multi.expire(`room:${roomId}:votes`, ROOM_TTL);

                    await multi.exec();
                }
            }
        } else {
            // Fallback for missing votes if users exist (existing logic)
            const missingVotes = userIds.some(id => !voteMap[id]);
            if (missingVotes) {
                const pgVotes = await (prisma as any).vote.findMany({ where: { roomId } });
                if (pgVotes.length > 0) {
                    const multi = redis.pipeline();
                    pgVotes.forEach((v: any) => {
                        multi.hset(`room:${roomId}:votes`, { [v.userId]: v.value });
                        if (voteMap) voteMap[v.userId] = v.value;
                    });
                    await multi.exec();
                }
            }
        }

        const users = userIds.map((id: string) => {
            const rawData = userDataMap ? userDataMap[id] : null;
            let data: User;

            if (typeof rawData === 'string') {
                try {
                    data = JSON.parse(rawData);
                } catch (e) {
                    console.error('Failed to parse user data:', rawData, e);
                    data = { id, name: 'Unknown', socketId: '' };
                }
            } else if (typeof rawData === 'object' && rawData !== null) {
                data = rawData as User;
            } else {
                data = { id, name: 'Unknown', socketId: '' };
            }

            return {
                id,
                name: data.name || 'Unknown',
                hasVoted: !!(voteMap && voteMap[id]),
            };
        });

        const votes: Record<string, string | null> = {};
        if (meta.revealed) {
            for (const id of userIds) {
                votes[id] = voteMap ? (voteMap[id] as string) : null;
            }
        } else if (forUserId) {
            const myVote = voteMap ? (voteMap[forUserId] as string) : null;
            if (myVote) {
                votes[forUserId] = myVote;
            }
        }

        return {
            id: meta.id,
            name: meta.name,
            adminId: meta.adminId,
            votingSystem: meta.votingSystem,
            revealPolicy: meta.revealPolicy,
            users,
            votes,
            revealed: meta.revealed,
        };
    },

    /**
     * Get all rooms for a user (created or joined)
     */
    async getUserRooms(userId: string, limit: number = 20, offset: number = 0): Promise<{ rooms: any[], total: number }> {
        // 1. Get rooms where user is admin
        const adminRooms = await prisma.room.findMany({
            where: { adminId: userId },
            orderBy: { createdAt: 'desc' },
            select: { id: true, name: true, createdAt: true, adminId: true }
        });

        // 2. Get rooms where user is a participant
        const participated = await (prisma as any).participant.findMany({
            where: { userId },
            orderBy: { joinedAt: 'desc' },
        });

        const participantRoomIds = participated.map((p: any) => p.roomId);

        // Fetch room details for joined rooms, excluding ones where user is admin (deduplication)
        const participantRooms = await prisma.room.findMany({
            where: {
                id: { in: participantRoomIds },
                adminId: { not: userId }
            },
            orderBy: { createdAt: 'desc' },
            select: { id: true, name: true, createdAt: true, adminId: true }
        });

        // Combine and sort
        const allRooms = [...adminRooms, ...participantRooms];
        allRooms.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        // Apply pagination in memory (since we combined two lists)
        const paginated = allRooms.slice(offset, offset + limit);

        // Fetch active user IDs for these rooms
        const multi = redis.pipeline();
        paginated.forEach(room => {
            multi.smembers(`room:${room.id}:users`);
        });
        const results = await multi.exec();

        const roomsWithCounts = paginated.map((room, index) => {
            const result = results?.[index];
            // ioredis pipeline returns [error, result]
            const members = (result?.[1] as string[]) || [];

            // Count active users excluding the admin
            const activeUsers = members.filter(id => id !== room.adminId).length;

            return {
                ...room,
                activeUsers
            };
        });

        return {
            rooms: roomsWithCounts,
            total: allRooms.length
        };
    },

    /**
     * Delete room completely
     */
    async deleteRoom(roomId: string): Promise<boolean> {
        // Collect all keys to delete from Redis
        const keys = [
            `room:${roomId}:meta`,
            `room:${roomId}:users`,
            `room:${roomId}:user_data`,
            `room:${roomId}:votes`
        ];

        // Find all socket keys related to this room to clean them up?
        // It's expensive to iterate all "room:{roomId}:user:*:sockets".
        // Instead, rely on TTL or just leave them (they won't be accessible without room meta).
        // Best effort: Get users and try to clean their socket sets.
        const userIds = await redis.smembers(`room:${roomId}:users`);
        for (const uid of userIds) {
            keys.push(`room:${roomId}:user:${uid}:sockets`);
        }

        await redis.del(...keys);

        // Delete from Postgres
        // Due to cascade or manual delete?
        // Votes and Participants should cascade delete if set up, 
        // but for safety let's delete explicitly if needed.
        // Assuming cascade delete is NOT set up in schema yet based on previous code doing manual deletes.

        try {
            await (prisma as any).participant.deleteMany({ where: { roomId } });
            await (prisma as any).vote.deleteMany({ where: { roomId } });
            await (prisma.room as any).delete({ where: { id: roomId } });
            return true;
        } catch (error) {
            console.error('Failed to delete room from DB:', error);
            return false;
        }
    },

    /**
     * Get active user count for a room (excluding admin)
     */
    async getActiveUserCount(roomId: string): Promise<number> {
        const room = await this.getRoom(roomId);
        if (!room) return 0;

        const members = await redis.smembers(`room:${roomId}:users`);
        return members.filter(id => id !== room.adminId).length;
    }
};
