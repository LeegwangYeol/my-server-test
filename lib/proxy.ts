import { fetchRetry } from "./fetch-retry";

export const getProxyString = ({
  proxyMode,
  countryCode,
}: {
  proxyMode: "RESIDENTIAL" | "DATACENTER" | "GOOGLE_SERP";
  countryCode?: string;
}) => {
  let username = "auto";

  if (proxyMode == "RESIDENTIAL") {
    username = `groups-RESIDENTIAL${
      countryCode ? `,country-${countryCode}` : ""
    }`;
  } else if (proxyMode == "GOOGLE_SERP") {
    username = `groups-GOOGLE_SERP${
      countryCode ? `,country-${countryCode}` : ""
    }`;
  }

  return `http://${username}:${process.env.APIFY_PASSWORD}@proxy.apify.com:8000`;
};

export const googleSerp = async ({
  query,
  proxyMode,
  countryCode,
}: {
  query: string;
  proxyMode: "RESIDENTIAL" | "DATACENTER" | "GOOGLE_SERP";
  countryCode?: string;
}) => {
  const proxy = getProxyString({ proxyMode, countryCode });

  const url = "http://www.google.com/search";
  const params = { q: query };

  const queryString = new URLSearchParams(params).toString();
  const response = await fetchRetry(`${url}?${queryString}`, {
    // @ts-expect-error
    proxy,
    signal: AbortSignal.timeout(10000),
    retries: 5,
    retryDelay: 2000,
    headers: { "Accept-Encoding": "identity" },
  });
  return await response.text();
};
