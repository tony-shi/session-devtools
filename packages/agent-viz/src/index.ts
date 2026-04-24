// Public API of @session-dashboard/agent-viz.
//
// Two layers:
//   1. IR — our OTel gen_ai semconv-superset AgentSpan + adapters.
//   2. Prism — re-exported agent-prism UI components (TraceViewer etc).
//
// CSS is shipped separately at `@session-dashboard/agent-viz/prism.css`.

export * from "./ir";
export * from "./prism";
