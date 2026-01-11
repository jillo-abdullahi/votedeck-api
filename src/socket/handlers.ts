import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { JoinRoomPayload, CastVotePayload, UpdateNamePayload, UpdateSettingsPayload } from '../types/index.js';
import { roomStore } from '../store/roomStore.js';

/**
 * Helper to broadcast personalized room states to all users in a room
 */
async function broadcastRoomState(io: SocketIOServer, roomId: string) {
    const room = await roomStore.getRoom(roomId);
    if (!room) return;

    // Fetch all active sockets in this room
    const sockets = await io.in(roomId).fetchSockets();

    // Send personalized state to each socket
    for (const socket of sockets) {
        const userId = (socket as any).userId;
        const personalizedState = await roomStore.getRoomState(roomId, userId);
        if (personalizedState) {
            socket.emit('ROOM_STATE', personalizedState);
        }
    }
}

async function notifyRoomAdmin(io: SocketIOServer, roomId: string) {
    const room = await roomStore.getRoom(roomId);
    if (!room) return;

    const activeUsers = await roomStore.getActiveUserCount(roomId);

    io.to(`user:${room.adminId}`).emit('MY_ROOM_UPDATE', {
        roomId,
        activeUsers
    });
}

export function setupSocketHandlers(io: SocketIOServer) {
    io.on('connection', (socket: Socket) => {
        console.log(`Socket connected: ${socket.id}`);

        // Log all incoming events for debugging
        socket.onAny((eventName, ...args) => {
            console.log(`[Socket] Received event: ${eventName}`, args);
        });

        // Join user-specific channel for personal updates (like dashboard)
        const userId = (socket as any).userId;
        if (userId) {
            socket.join(`user:${userId}`);
        }

        /**
         * JOIN_ROOM
         */
        socket.on('JOIN_ROOM', async (payload: JoinRoomPayload) => {
            const { roomId, userId, name } = payload;
            console.log(`[JOIN_ROOM] Start: roomId=${roomId}, userId=${userId}, name=${name}`);

            try {
                const room = await roomStore.getRoom(roomId);
                if (!room) {
                    console.warn(`[JOIN_ROOM] Room not found: ${roomId}`);
                    socket.emit('ERROR', { message: 'Room not found' });
                    return;
                }
                console.log(`[JOIN_ROOM] Room found. Mapping socket ${socket.id}...`);

                // Map socket to user/room for disconnection handling
                await roomStore.mapSocket(socket.id, userId, roomId);

                console.log(`[JOIN_ROOM] Adding user to room...`);

                // Add user to room
                const success = await roomStore.addUser(roomId, {
                    id: userId,
                    name,
                    socketId: socket.id,
                });

                if (!success) {
                    console.error(`[JOIN_ROOM] Failed to add user to room store`);
                    socket.emit('ERROR', { message: 'Failed to join room' });
                    return;
                }

                console.log(`[JOIN_ROOM] Joining socket.io room...`);

                // Join socket room
                socket.join(roomId);

                // Broadcast updated room state
                await broadcastRoomState(io, roomId);

                // Notify admin's dashboard
                await notifyRoomAdmin(io, roomId);

                console.log(`[JOIN_ROOM] Success: User ${name} (${userId}) joined room ${roomId}`);
            } catch (err) {
                console.error(`[JOIN_ROOM] CRITICAL ERROR for room ${roomId}:`, err);
                // Log full error details including stack trace
                if (err instanceof Error) {
                    console.error(err.stack);
                }
                socket.emit('ERROR', { message: 'Internal server error while joining room' });
            }
        });

        // ... existing CAST_VOTE, REVEAL, RESET, UPDATE_NAME, UPDATE_SETTINGS handlers ...

        /**
         * CAST_VOTE
         */
        socket.on('CAST_VOTE', async (payload: CastVotePayload) => {
            const userInfo = await roomStore.getUserBySocketId(socket.id);
            if (!userInfo) {
                socket.emit('ERROR', { message: 'User not found in any room' });
                return;
            }

            const { user, roomId } = userInfo;
            const { value } = payload;

            const success = await roomStore.castVote(roomId, user.id, value);
            if (!success) {
                socket.emit('ERROR', { message: 'Failed to cast vote' });
                return;
            }

            await broadcastRoomState(io, roomId);
        });

        /**
         * REVEAL
         */
        socket.on('REVEAL', async () => {
            const userId = (socket as any).userId;

            const userInfo = await roomStore.getUserBySocketId(socket.id);
            if (!userInfo) {
                socket.emit('ERROR', { message: 'User not found' });
                return;
            }

            const { roomId } = userInfo;
            const room = await roomStore.getRoom(roomId);

            if (!room) {
                socket.emit('ERROR', { message: 'Room not found' });
                return;
            }

            // Role check
            if (room.adminId !== userId && room.revealPolicy !== 'everyone') {
                socket.emit('ERROR', { message: 'Only the host can reveal votes' });
                return;
            }

            const doReveal = async () => {
                const success = await roomStore.revealVotes(roomId);
                if (!success) {
                    socket.emit('ERROR', { message: 'Failed to reveal votes' });
                    return;
                }
                await broadcastRoomState(io, roomId);
            };

            if (room.enableCountdown) {
                // 1. Broadcast Countdown (3s duration for frontend animation)
                io.to(roomId).emit('COUNTDOWN_START', { duration: 3 });

                // 2. Wait 3.5s (3s + 500ms buffer) to ensure frontend animation finishes
                setTimeout(async () => {
                    // Re-fetch room to ensure it still exists and isn't already revealed
                    const currentRoom = await roomStore.getRoom(roomId);
                    if (currentRoom && !currentRoom.revealed) {
                        await doReveal();
                    }
                }, 3500);
            } else {
                // Immediate reveal
                await doReveal();
            }
        });

        /**
         * RESET
         */
        socket.on('RESET', async () => {
            const userId = (socket as any).userId;

            const userInfo = await roomStore.getUserBySocketId(socket.id);
            if (!userInfo) {
                socket.emit('ERROR', { message: 'User not found' });
                return;
            }

            const { roomId } = userInfo;
            const room = await roomStore.getRoom(roomId);

            if (!room) {
                socket.emit('ERROR', { message: 'Room not found' });
                return;
            }

            // Role check
            if (room.adminId !== userId && room.revealPolicy !== 'everyone') {
                socket.emit('ERROR', { message: 'Only the host can reset the vote' });
                return;
            }

            const success = await roomStore.resetVotes(roomId);
            if (!success) {
                socket.emit('ERROR', { message: 'Failed to reset votes' });
                return;
            }

            await broadcastRoomState(io, roomId);
        });

        /**
         * UPDATE_NAME
         */
        socket.on('UPDATE_NAME', async (payload: UpdateNamePayload) => {
            const userInfo = await roomStore.getUserBySocketId(socket.id);
            if (!userInfo) return;

            const { user, roomId } = userInfo;
            const { name } = payload;

            await roomStore.updateUser(roomId, user.id, { name });
            await broadcastRoomState(io, roomId);
        });

        /**
         * UPDATE_SETTINGS
         */
        socket.on('UPDATE_SETTINGS', async (payload: UpdateSettingsPayload) => {
            const userId = (socket as any).userId;

            const userInfo = await roomStore.getUserBySocketId(socket.id);
            if (!userInfo) return;

            const { roomId } = userInfo;
            const room = await roomStore.getRoom(roomId);

            if (!room || room.adminId !== userId) return;

            await roomStore.updateSettings(roomId, payload);
            await broadcastRoomState(io, roomId);
        });

        /**
         * LEAVE_ROOM
         */
        socket.on('LEAVE_ROOM', async () => {
            const userInfo = await roomStore.getUserBySocketId(socket.id);
            if (!userInfo) return;

            const { user, roomId } = userInfo;

            const wasRemoved = await roomStore.removeSocketFromUser(roomId, user.id, socket.id);
            await roomStore.unmapSocket(socket.id);
            socket.leave(roomId);

            if (wasRemoved) {
                await broadcastRoomState(io, roomId);
                await notifyRoomAdmin(io, roomId);
            }
        });

        /**
         * disconnect
         */
        socket.on('disconnect', async () => {
            const userInfo = await roomStore.getUserBySocketId(socket.id);
            if (userInfo) {
                const { user, roomId } = userInfo;

                const wasRemoved = await roomStore.removeSocketFromUser(roomId, user.id, socket.id);
                await roomStore.unmapSocket(socket.id);

                if (wasRemoved) {
                    await broadcastRoomState(io, roomId);
                    await notifyRoomAdmin(io, roomId);
                }
            }
        });
    });
}
