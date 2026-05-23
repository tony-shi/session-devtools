import { VisibilityService, type VisibilityDeps } from "./service.ts";
import { VisibilityWorker } from "./worker.ts";
import { realVisibilityDeps } from "./deps.ts";

export type { Visibility, VisibilityQuery, VisibilityDeps, SessionMeta } from "./service.ts";
export { VisibilityService } from "./service.ts";
export { VisibilityWorker } from "./worker.ts";
export { isVisibilityEnabled } from "./config.ts";

// 工厂：把 service 和 worker 串起来，外部只拿到一个 service 句柄。
export function createVisibilityService(deps: VisibilityDeps): VisibilityService {
  const service = new VisibilityService(deps);
  const worker = new VisibilityWorker(service);
  service.setEnqueueFn((id) => worker.enqueue(id));
  return service;
}

// 进程级单例。第一次访问时创建；测试可以用 setVisibilityService 注入。
let _singleton: VisibilityService | null = null;

export function getVisibilityService(): VisibilityService {
  if (!_singleton) _singleton = createVisibilityService(realVisibilityDeps());
  return _singleton;
}

export function setVisibilityService(s: VisibilityService | null): void {
  _singleton = s;
}
