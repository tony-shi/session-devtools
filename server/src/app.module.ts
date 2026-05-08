import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ProxyTrafficController } from "./proxy-traffic.controller.ts";
import { ProxyV2Controller } from "./proxy-v2.controller.ts";
import { SessionsController } from "./sessions.controller.ts";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [SessionsController, ProxyTrafficController, ProxyV2Controller],
})
export class AppModule {}
