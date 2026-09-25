/**
 * 实时协议：WebSocket 帧与房间事件（docs/rebuild/04-ROOM-JEV.md §5）。
 *
 * 规则要点：
 *  - 房间事件有连续递增 seq；客户端按序应用、重复忽略、缺口先补齐
 *  - 金额、赞助有效期、免费余量通过个人 HTTP 接口读取，不广播给房间
 *  - 事件 payload 是公开投影：汤底、未解锁提示、私有数据不出现在事件里
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 1;

// ---------- 客户端帧 ----------

export const wsClientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), ticket: z.string() }),
  z.object({
    type: z.literal('subscribe'),
    roomId: z.string(),
    /** 最后连续应用的序号：服务端从这里补齐 */
    lastSeq: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('unsubscribe'), roomId: z.string() }),
  z.object({ type: z.literal('ping') }),
]);

export type WsClientFrame = z.infer<typeof wsClientFrameSchema>;

// ---------- 服务端帧 ----------

export const wsServerAckSchema = z.object({
  type: z.literal('ack'),
  /** auth 成功后返回用户身份 */
  userId: z.string().optional(),
  requestId: z.string().optional(),
});

export const wsServerErrorSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
});

export const wsSyncReadySchema = z.object({
  type: z.literal('sync.ready'),
  roomId: z.string(),
  /** 本次同步到达的高水位 */
  watermark: z.number().int(),
});

export const wsHeartbeatSchema = z.object({
  type: z.literal('heartbeat'),
  /** 各订阅房间的当前高水位：客户端发现领先即可补齐 */
  watermarks: z.array(z.object({ roomId: z.string(), seq: z.number().int() })),
});

// ---------- 房间事件 payload ----------

const nickname = z.string().max(50);

export const roomEventPayloadSchemas = {
  'room.member_joined': z.object({ userId: z.string(), nickname }),
  'room.member_left': z.object({ userId: z.string(), nickname }),
  'room.member_kicked': z.object({ userId: z.string(), nickname }),
  'room.member_unrestricted': z.object({ userId: z.string() }),
  'room.host_changed': z.object({ userId: z.string(), nickname }),
  'room.invite_rotated': z.object({}),
  'room.closed': z.object({ reason: z.enum(['by_host', 'idle', 'all_offline', 'moderation', 'host_left']) }),
  'round.started': z.object({
    roundId: z.string(),
    roundNo: z.number().int(),
    puzzleId: z.string(),
    title: z.string(),
    surface: z.string(),
    language: z.enum(['zh', 'en']),
    hintsTotal: z.number().int(),
  }),
  'round.ended': z.object({
    roundId: z.string(),
    status: z.enum(['solved', 'revealed', 'abandoned', 'aborted']),
    reason: z.string(),
    /** 结束原因不含汤底；汤底通过 /rounds/:id/answer 获取 */
  }),
  'turn.accepted': z.object({
    turnId: z.string(),
    userId: z.string(),
    nickname,
    kind: z.enum(['ask', 'solve']),
    text: z.string(),
  }),
  'turn.started': z.object({ turnId: z.string() }),
  'turn.completed': z.object({ turnId: z.string(), result: z.string() }),
  'turn.failed': z.object({ turnId: z.string(), reason: z.string(), retryable: z.boolean() }),
  'turn.cancelled': z.object({ turnId: z.string() }),
  'hint.revealed': z.object({ roundId: z.string(), index: z.number().int(), text: z.string() }),
  'discussion.created': z.object({ userId: z.string(), nickname, text: z.string().max(1000) }),
} as const;

export const roomEventTypeSchema = z.enum(Object.keys(roomEventPayloadSchemas) as [keyof typeof roomEventPayloadSchemas]);
export type RoomEventType = z.infer<typeof roomEventTypeSchema>;

export const roomEventSchema = z.object({
  schemaVersion: z.number().int(),
  eventId: z.string(),
  roomId: z.string(),
  roundId: z.string().nullable(),
  seq: z.number().int(),
  type: roomEventTypeSchema,
  occurredAt: z.string(),
  payload: z.unknown(),
});

export type RoomEvent<T extends RoomEventType = RoomEventType> = {
  schemaVersion: number;
  eventId: string;
  roomId: string;
  roundId: string | null;
  seq: number;
  type: T;
  occurredAt: string;
  payload: T extends keyof typeof roomEventPayloadSchemas ? z.infer<(typeof roomEventPayloadSchemas)[T]> : never;
};

/** 服务端 ws 帧全集 */
export const wsServerFrameSchema = z.union([
  wsServerAckSchema,
  wsServerErrorSchema,
  roomEventSchema,
  wsSyncReadySchema,
  wsHeartbeatSchema,
]);

export type WsServerFrame = z.infer<typeof wsServerFrameSchema>;
