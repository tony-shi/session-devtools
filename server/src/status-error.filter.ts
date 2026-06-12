// 全局 exception filter —— 把 controller 各处 `throw Object.assign(new Error(...),
// { status: 404 })` 惯例的 status 属性映射到 HTTP 状态码。
//
// 此前没有任何 filter：所有带 status 标注的错误（session/subagent/workflow 的
// 404、runId/agentFileId 白名单的 400）全部落 500，错误码失真且排查方向被误导
// （项目级存量问题，05 文档待办 J）。
//
// 行为：
//   - NestJS HttpException → 沿用其自带状态码（保持框架默认语义）
//   - 错误对象带 4xx/5xx 的 status 数字 → 用它
//   - 其余 → 500（并保留 message —— fail fast，不吞原因）

import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply } from "fastify";

@Catch()
export class StatusErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    if (exception instanceof HttpException) {
      reply.status(exception.getStatus()).send(exception.getResponse());
      return;
    }

    const status = (exception as { status?: unknown })?.status;
    const code = typeof status === "number" && status >= 400 && status < 600 ? status : 500;
    const message = exception instanceof Error ? exception.message : "Internal server error";
    if (code >= 500) {
      // 真 5xx 保留服务端日志（4xx 是预期路径，不刷屏）
      console.error("[http] unhandled error:", exception);
    }
    reply.status(code).send({ statusCode: code, message });
  }
}
