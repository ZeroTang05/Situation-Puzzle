import { adminWorkerRequest } from '../worker';

/** 读取待审核题目。 */
export function GET(request: Request) {
  return adminWorkerRequest(request, 'soups');
}
