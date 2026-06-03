// Remotion CLI 配置(仅 studio/render 时被 CLI 读取,不进 Vite app bundle)。
// 故意保持最小;未来要接 Tailwind / 自定义 webpack 在这里加 overrideWebpackConfig。
import { Config } from "@remotion/cli/config";
import path from "node:path";

Config.setVideoImageFormat("jpeg");
Config.setEntryPoint("./src/studio/index.ts");

// 让 Remotion 的 webpack 认识 app 的 "@" → src 别名(Vite 知道、webpack 不知道)。
// 复用真实产品组件(它们 import "@/components/ui/*")出片时必须有这条。
Config.overrideWebpackConfig((cfg) => ({
  ...cfg,
  resolve: {
    ...cfg.resolve,
    alias: { ...(cfg.resolve?.alias ?? {}), "@": path.resolve(process.cwd(), "src") },
  },
}));
