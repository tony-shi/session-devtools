import { All, Controller, Req, Res } from "@nestjs/common";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { handleRequest } from "./routes.ts";

@Controller()
export class LegacyController {
  @All("*")
  async handle(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const url = `http://localhost${req.url}`;
    const headers = new Headers(req.headers as Record<string, string>);
    const body =
      req.method !== "GET" && req.method !== "HEAD"
        ? JSON.stringify(req.body)
        : undefined;
    const webReq = new Request(url, { method: req.method, headers, body });

    const response = await handleRequest(webReq);
    if (!response) {
      reply.status(404).send("Not Found");
      return;
    }

    reply.status(response.status);
    response.headers.forEach((val, key) => reply.header(key, val));

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream") && response.body) {
      // SSE: pipe Web ReadableStream → Node Readable → Fastify
      const nodeStream = Readable.fromWeb(
        response.body as import("stream/web").ReadableStream<Uint8Array>,
      );
      reply.send(nodeStream);
    } else {
      reply.send(await response.text());
    }
  }
}
