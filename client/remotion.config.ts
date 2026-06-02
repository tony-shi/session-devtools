// Remotion CLI 配置(仅 studio/render 时被 CLI 读取,不进 Vite app bundle)。
// 故意保持最小;未来要接 Tailwind / 自定义 webpack 在这里加 overrideWebpackConfig。
import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setEntryPoint("./src/studio/index.ts");
