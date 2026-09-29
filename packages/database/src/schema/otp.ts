/** 验证码发送预占记录：待发送、已接受和结果未知的请求均占用额度。 */
import { pgTable, uuid, text, inet, timestamp, index } from 'drizzle-orm/pg-core';

export const otpSendReservations = pgTable('otp_send_reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  ip: inet('ip').notNull(),
  reservedAt: timestamp('reserved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  index('otp_send_email_time_idx').on(table.email, table.reservedAt),
  index('otp_send_ip_time_idx').on(table.ip, table.reservedAt),
  index('otp_send_time_idx').on(table.reservedAt),
]);
