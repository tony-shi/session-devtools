// cache 满此大小后 proxy rename 成中间态，rotation-worker 压缩为 cold .gz
export const TRAFFIC_ROTATE_BYTES = 64 * 1024 * 1024;
export const SYNC_TICK_MS = 200;
export const FILESYSTEM_DIFF_INTERVAL_MS = 60_000;
export const ROTATION_WORKER_INTERVAL_MS = 5_000;
export const COLD_INDEXER_IDLE_MS = 30_000;
export const SYNC_BATCH_RECORDS = 500;
