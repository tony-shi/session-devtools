// Remotion CLI 配置(仅 studio/render 时被 CLI 读取,不进 Vite app bundle)。
// 故意保持最小;未来要接 Tailwind / 自定义 webpack 在这里加 overrideWebpackConfig。
import { Config } from "@remotion/cli/config";
import path from "node:path";

Config.setVideoImageFormat("jpeg");
Config.setEntryPoint("./src/studio/index.ts");

// 渲染器钉到本机 stable Chrome:Remotion 自带的 chrome-headless-shell 是 Chrome for
// Testing 149(dev 分支),CSS zoom + offsetWidth 语义与 stable 不一致 —— 实测会让
// FisheyeStrip 按 1/zoom² 缩水。studio 预览跑在用户的 stable Chrome 里,出片也用同
// 一个内核,所见即所得。
Config.setBrowserExecutable("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");

// 让 Remotion 的 webpack 认识 app 的 "@" → src 别名(Vite 知道、webpack 不知道)。
// 复用真实产品组件(它们 import "@/components/ui/*")出片时必须有这条。
Config.overrideWebpackConfig((cfg) => ({
  ...cfg,
  resolve: {
    ...cfg.resolve,
    alias: { ...(cfg.resolve?.alias ?? {}), "@": path.resolve(process.cwd(), "src") },
  },
}));
