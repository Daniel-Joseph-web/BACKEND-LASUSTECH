import { redisConnection } from './queue';

export const CBT_REALTIME_CHANNEL = 'cbt:events';

export interface RealtimeEventPayload {
  event: string;
  target?: {
    userIds?: string[];
    roles?: string[];
    rooms?: string[];
  };
  data: Record<string, unknown>;
}

/**
 * Publishes an event to Redis pub/sub for the Realtime WebSocket server
 * to broadcast to connected clients in real time.
 */
export async function publishRealtimeEvent(payload: RealtimeEventPayload): Promise<void> {
  try {
    await redisConnection.publish(CBT_REALTIME_CHANNEL, JSON.stringify(payload));
  } catch (err: any) {
    console.warn(`[Realtime PubSub] Warning: Could not publish event ${payload.event}: ${err.message}`);
  }
}
