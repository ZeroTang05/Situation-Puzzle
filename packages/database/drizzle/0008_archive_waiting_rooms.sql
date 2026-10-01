-- v2 数据迁移：存量 waiting 房（建了未开局）释放免费预留并归档，等效从未存在。
-- 顺序：先流水（幂等唯一约束）→ 账户扣减 → 授权转 released → 最后改房间状态（后续语句依赖 status='waiting'）。
INSERT INTO room_credit_ledger (room_id, user_id, action, amount)
SELECT e.room_id, e.creator_user_id, 'release', 1
FROM room_entitlements e
JOIN rooms r ON r.id = e.room_id
WHERE r.status = 'waiting' AND e.source = 'free' AND e.status = 'reserved'
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE free_room_accounts f
SET reserved = reserved - 1, updated_at = now()
FROM room_entitlements e
JOIN rooms r ON r.id = e.room_id
WHERE f.user_id = e.creator_user_id
  AND r.status = 'waiting' AND e.source = 'free' AND e.status = 'reserved'
  AND f.reserved > 0;--> statement-breakpoint
UPDATE room_entitlements e
SET status = 'released'
FROM rooms r
WHERE r.id = e.room_id AND r.status = 'waiting' AND e.source = 'free' AND e.status = 'reserved';--> statement-breakpoint
UPDATE rooms
SET status = 'closed', closed_at = now(), close_reason = 'never_started'
WHERE status = 'waiting';
