import { Server as HttpServer } from 'node:http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import Redis from 'ioredis';

export interface UserTokenPayload {
  sub: string;
  sid?: string;
  roles?: string[];
}

export interface RealtimeMessage {
  event: string;
  target?: {
    userIds?: string[];
    roles?: string[];
    rooms?: string[];
  };
  data: Record<string, unknown>;
}

export function setupRealtimeServer(
  httpServer: HttpServer,
  options: {
    redisUrl: string;
    jwtSecret: string;
    webOrigin: string;
  },
) {
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        callback(null, true);
      },
      credentials: true,
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 30000,
    pingInterval: 15000,
  });

  // JWT Authentication Middleware
  io.use((socket: Socket, next) => {
    const rawToken =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');

    if (!rawToken) {
      // Allow unauthenticated connection for guest candidates
      socket.data.isGuest = true;
      return next();
    }

    try {
      const decoded = jwt.verify(rawToken, options.jwtSecret) as UserTokenPayload;
      socket.data.user = {
        id: decoded.sub,
        roles: Array.isArray(decoded.roles) ? decoded.roles : [],
      };
      socket.data.isGuest = false;
      return next();
    } catch {
      // If token is invalid or expired, reject or fallback to guest
      return next(new Error('AUTHENTICATION_ERROR: Invalid or expired token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user;

    if (user?.id) {
      // Join user's personal notification and event room
      socket.join(`user:${user.id}`);

      // Join role rooms
      for (const role of user.roles || []) {
        socket.join(`role:${role}`);
      }
      console.log(`[Socket] User connected: ${user.id} (${(user.roles || []).join(', ')}) [Socket: ${socket.id}]`);
    } else {
      console.log(`[Socket] Guest connected: [Socket: ${socket.id}]`);
    }

    // Allow clients to join specific channels (both exam candidates and invigilators)
    socket.on('join_sitting', (sittingId: string) => {
      if (!user) {
        socket.emit('error', { message: 'Authentication required to join sitting monitor' });
        return;
      }
      if (typeof sittingId === 'string' && sittingId.trim()) {
        const cleanSittingId = sittingId.trim();
        const room = `sitting:${cleanSittingId}`;
        socket.join(room);

        // Staff members also join the privileged staff channel for this sitting
        const isStaff = user.roles?.some((r: string) => ['ADMIN', 'LECTURER'].includes(r));
        if (isStaff) {
          socket.join(`sitting:${cleanSittingId}:staff`);
        }

        console.log(`[Socket] ${socket.id} (${user.id}, ${(user.roles || []).join(',')}) joined room ${room}`);
      }
    });

    socket.on('leave_sitting', (sittingId: string) => {
      if (typeof sittingId === 'string' && sittingId.trim()) {
        const cleanSittingId = sittingId.trim();
        const room = `sitting:${cleanSittingId}`;
        socket.leave(room);
        socket.leave(`sitting:${cleanSittingId}:staff`);
        console.log(`[Socket] ${socket.id} left room ${room}`);
      }
    });

    // Proctor heartbeat relay - directed strictly to invigilators/staff
    socket.on('proctor_event', (payload: { sittingId: string; type: string; data?: any }) => {
      if (payload?.sittingId) {
        socket.to(`sitting:${payload.sittingId}:staff`).emit('proctor_event', {
          ...payload,
          senderId: user?.id,
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Candidate camera frame relay for live video monitoring - directed strictly to invigilators/staff
    socket.on('camera_frame', (payload: { sittingId: string; studentId?: string; attemptId?: string; matricNo?: string; frame: string }) => {
      if (payload?.sittingId && payload.frame) {
        socket.to(`sitting:${payload.sittingId}:staff`).emit('candidate_camera_frame', {
          studentId: payload.studentId || user?.id,
          attemptId: payload.attemptId,
          matricNo: payload.matricNo,
          frame: payload.frame,
          timestamp: Date.now(),
        });
      }
    });

    // WebRTC peer connection signaling for real-time live video feeds
    socket.on('webrtc_signal', (payload: { sittingId: string; targetUserId?: string; targetStudentId?: string; targetSocketId?: string; signal: any; kind?: 'camera' | 'screen' | 'invigilator' }) => {
      const targetUser = payload?.targetUserId || payload?.targetStudentId;
      if (payload?.targetSocketId) {
        socket.to(payload.targetSocketId).emit('webrtc_signal', {
          senderSocketId: socket.id,
          senderUserId: user?.id,
          signal: payload.signal,
          kind: payload.kind || 'camera',
        });
      } else if (targetUser) {
        socket.to(`user:${targetUser}`).emit('webrtc_signal', {
          senderSocketId: socket.id,
          senderUserId: user?.id,
          signal: payload.signal,
          kind: payload.kind || 'camera',
        });
      } else if (payload?.sittingId) {
        socket.to(`sitting:${payload.sittingId}`).emit('webrtc_signal', {
          senderSocketId: socket.id,
          senderUserId: user?.id,
          signal: payload.signal,
          kind: payload.kind || 'camera',
        });
      }
    });

    // Request candidate live stream (initiated by invigilator/admin only)
    socket.on('request_live_feed', (payload: { sittingId: string; studentId?: string; targetStudentId?: string }) => {
      const isStaff = user?.roles?.some((r: string) => r === 'ADMIN' || r === 'LECTURER');
      if (!isStaff) {
        console.warn(`[Socket] Unauthorized request_live_feed attempt from socket ${socket.id}`);
        return;
      }
      const targetStudent = payload?.studentId || payload?.targetStudentId;
      if (targetStudent) {
        io.to(`user:${targetStudent}`).emit('request_live_feed', {
          invigilatorSocketId: socket.id,
          sittingId: payload.sittingId,
        });
      }
    });

    socket.on('disconnect', (reason) => {
      console.log(`[Socket] Client disconnected: ${socket.id} (reason: ${reason})`);
    });
  });

  // Redis Subscriber for cross-process events
  const redisSub = new Redis(options.redisUrl, {
    maxRetriesPerRequest: null,
  });

  redisSub.on('error', (err) => {
    console.warn(`[Realtime Redis] Connection warning: ${err.message}`);
  });

  redisSub.subscribe('cbt:events', (err, count) => {
    if (err) {
      console.error('[Realtime Redis] Subscription failed:', err.message);
    } else {
      console.log(`[Realtime Redis] Subscribed to cbt:events (${count} channel)`);
    }
  });

  redisSub.on('message', (_channel, rawMessage) => {
    try {
      const msg: any = JSON.parse(rawMessage);
      const event = msg.event;
      const target = msg.target;
      const data = msg.data || msg.payload || {};

      if (!event) return;

      const eventEnvelope = { type: event, ...data };

      if (target?.userIds?.length) {
        for (const uid of target.userIds) {
          io.to(`user:${uid}`).emit(event, data);
          io.to(`user:${uid}`).emit('event', eventEnvelope);
        }
      }

      if (target?.roles?.length) {
        for (const role of target.roles) {
          io.to(`role:${role}`).emit(event, data);
          io.to(`role:${role}`).emit('event', eventEnvelope);
        }
      }

      if (target?.rooms?.length) {
        for (const room of target.rooms) {
          io.to(room).emit(event, data);
          io.to(room).emit('event', eventEnvelope);
        }
      }

      // If no targets were specified, broadcast globally
      if (!target?.userIds?.length && !target?.roles?.length && !target?.rooms?.length) {
        io.emit(event, data);
        io.emit('event', eventEnvelope);
      }
    } catch (err: any) {
      console.warn('[Realtime Redis] Failed to parse event payload:', err.message);
    }
  });

  return io;
}
