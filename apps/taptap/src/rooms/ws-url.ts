/** 实时连接与 API 使用同一来源；本项目网关固定挂在 /ws。 */
export function wsUrl(): string { return `${__API_BASE__.replace('https://', 'wss://')}/ws`; }
