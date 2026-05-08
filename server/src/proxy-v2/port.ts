// devtools proxy v2 固定端口。
// 选 47823 的原因：避开 Linux ephemeral 区间 (32768-60999)，避开常见开发端口
// (3000/5000/5051/8000/8080/8888/9090)，避开 Charles/Proxyman 等同类工具默认值。
// 与旧 proxy 默认 38421 区分，便于诊断"settings 究竟指向哪一代"。
export const FIXED_PORT = 47823;
