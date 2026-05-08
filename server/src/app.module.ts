import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { LegacyController } from "./legacy.controller.ts";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [LegacyController],
})
export class AppModule {}
