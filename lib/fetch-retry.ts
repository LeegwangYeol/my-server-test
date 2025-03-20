import FetchRetry from "fetch-retry";
export const fetchRetry = FetchRetry(global.fetch);
