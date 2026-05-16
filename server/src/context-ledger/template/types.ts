// 请求模板类型定义
// template = 一份"先验骨架"，描述某种 query 形态在 wire body 里应该长什么样。
// parser 用 template 的 slot 决定切分边界；attribution 通过独立的 ContextRule
// registry 绑定 slotId，不把 rule 内容塞进 template。
// 这里只放数据 / 类型，不写执行逻辑。

/** 整个请求的先验骨架 */
export interface RequestTemplate {
  id: string;
  queryKindPredicate: "main_session" | "side_query" | "any";
  version: string;
  /**
   * appliesTo：cc_version 版本谓词。缺省 = 所有版本都可选用此 template。
   * 当多个 template 同时满足 queryKindPredicate 时，按 appliesTo 二次过滤；
   * 没满足任何 appliesTo 的 template 跳过。
   *
   * 用于 section 增删 / H1 header 改名 / slot 锚点真变化的版本切换；
   * 多数版本共享同一个 template 时无需标注。
   */
  appliesTo?: import("../version").VersionPredicate;
  slots: {
    system: TemplateSlot[];
    tools: TemplateSlot[];
    messages: TemplateSlot[];
  };
}

/** slot = parser 切分边界。语义 rule 由 rules/context-rule-registry.ts 绑定 slotId。 */
export interface TemplateSlot {
  id: string;
  multiplicity: "one" | "optional" | "zero_or_more";
  /** jsonPath 级定位模式，如 "reqBody.system[*]" */
  jsonPathPattern: string;
  /** block 内再切用的字面锚；undefined = 整块不再细切 */
  anchor?: SlotAnchor;
  children?: TemplateSlot[];
}

/** anchor 只允许字面量，禁止语义 regex
 *  WHY：parser 阶段不做语义判断，只做"位置切分"。语义 regex 容易误匹配，
 *  把识别这种事推到独立的 ContextRule attribution 层里去。
 */
export type SlotAnchor =
  | { kind: "h1_header"; header: string }
  | { kind: "tag_prefix"; prefix: string }
  | { kind: "literal"; text: string };
