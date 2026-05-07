// template 模块入口：re-export 类型、模板常量和选择器
export * from "./types";
export { CLAUDE_CODE_MAIN_SESSION_TEMPLATE } from "./templates/main-session";
export { CLAUDE_CODE_SIDE_QUERY_TEMPLATE } from "./templates/side-query";
export { selectTemplate } from "./selector";
export type { QueryKind, TemplateSelection } from "./selector";
