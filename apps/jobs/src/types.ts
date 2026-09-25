/** 任务 payload 类型：API 与 jobs 通过 pg-boss 传递的结构。 */
export interface DispatchPayload {
  roomId: string;
}

export interface TurnPayload {
  turnId: string;
  roomId: string;
}

export interface ReviewPayload {
  versionId: string;
}
