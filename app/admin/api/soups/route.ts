import { adminWorkerRequest } from '../worker';

/** 读取待复核或其他状态的玩家题目。 */
export function GET(request: Request) {
  return adminWorkerRequest(request, 'soups');
}
