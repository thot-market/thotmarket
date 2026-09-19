// A capture is uploaded one exchange at a time. These are bounds on a single
// exchange, not a cumulative conversation/context limit.
export const CAPTURE_REQUEST_BYTES = 32 * 1024 * 1024;
export const CAPTURE_RESPONSE_BYTES = 8 * 1024 * 1024;
export const CAPTURE_PART_JSON_BYTES = 60 * 1024 * 1024;
export const CAPTURE_RELAY_JSON_BYTES = 60 * 1024 * 1024;
export const CAPTURE_MAX_EXCHANGES = 4096;
export const CAPTURE_STORAGE_BYTES = 1024 * 1024 * 1024;
