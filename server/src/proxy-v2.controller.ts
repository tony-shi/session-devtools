import { Controller, Get, Post } from "@nestjs/common";
import { proxyV2Controller } from "./proxy-v2/controller.ts";

@Controller("api/proxy-v2")
export class ProxyV2Controller {
  @Get("status")
  status() {
    return proxyV2Controller.getSnapshot();
  }

  @Post("start")
  async start() {
    return proxyV2Controller.setTarget("RUNNING");
  }

  @Post("stop")
  async stop() {
    return proxyV2Controller.setTarget("STOPPED");
  }
}
