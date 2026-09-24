import { adminWorkerRequest } from '../../worker';

type Context = { params: Promise<{ id: string }> };

/** 发布或驳回题目。 */
export async function PATCH(request: Request, { params }: Context) {
  const { id } = await params;
  return adminWorkerRequest(request, `soups/${encodeURIComponent(id)}`);
}

/** 删除题目。 */
export async function DELETE(request: Request, { params }: Context) {
  const { id } = await params;
  return adminWorkerRequest(request, `soups/${encodeURIComponent(id)}`);
}
