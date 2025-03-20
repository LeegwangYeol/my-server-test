import { Elysia, t } from "elysia";
import GPTTorch from "@llami/gpt-torch";
import { voyage } from "@/lib/ai/voyage";
import { checkPrimaryApiKey } from "@/lib/api-key";
import { getProxyString } from "@/lib/proxy";
import { fetchRetry } from "@/lib/fetch-retry";
import { cosineSimilarity } from "@/lib/vector-operation";
import { chunkText } from "@/src/utils/chunk-readable";
import { supabaseClient } from "@/lib/supabase/client";

export const v1PageRank = async (app: Elysia<"/v1/crawl">) => {
  app.post(
    "/page/rank",
    async ({ body: { apiKey, url, useProxy, disableTorch, query } }) => {
      if (!checkPrimaryApiKey(apiKey)) {
        throw new Error("Invalid API key");
      }

      console.log(`Crawling page rank for URL: "${url}"`);

      if (disableTorch) {
        const rawHtml = await fetchData(url, useProxy);

        console.log("Torch disabled, html length:", rawHtml.length);
        return rawHtml;
      } else if (!query) {
        const rawHtml = await fetchData(url, useProxy);
        const torchResult = await GPTTorch(rawHtml);

        return torchResult.summaryJSON.stringify ?? "No data found";
      }

      const queryEmbedding = await voyage.embeddings({
        model: "voyage-3-lite",
        texts: [query],
      });

      {
        if (queryEmbedding.object === "error") {
          console.error(`Voyage API error: ${queryEmbedding.detail}`);
          return "No data found"; // TODO: fallback?
        }

        const querried = await supabaseClient
          .rpc("llami_search_embeddings_match", {
            query_embedding: JSON.stringify(queryEmbedding.data[0].embedding),
            query_model: "voyage-3-lite",
            match_threshold: 0.5,
            match_count: 20,
            text_source: "page-rank",
          })
          .eq("url", url);

        const embeddingSearchResults = querried.data?.map(({ text }) => ({
          summary: text,
        }));

        if (embeddingSearchResults && embeddingSearchResults.length > 0) {
          const topChunks = embeddingSearchResults
            .map(({ summary }) => `"${summary}"`)
            .join(", ");

          return `[Summarized Search Text]\n${topChunks}`;
        }
      }

      console.log("No embedding search results, trying search url");

      const rawHtml = await fetchData(url, useProxy);
      const { summaryJSON } = await GPTTorch(rawHtml);

      const text = summaryJSON.elements
        .flatMap((element) => element.children)
        .filter((element) => element && element.text)
        .map((element: any) => element.text) // TODO: need to entry export `ReadableElement` on gpt-torch
        .join("");

      const textChunks = await chunkText(text, {
        chunkSize: 75,
        overlap: 15,
      }).then((chunks) => chunks.map((chunk) => chunk.chunk));

      if (textChunks.length === 0) {
        return "No data found";
      }

      const chunksEmbeddings = await voyage.embeddings({
        model: "voyage-3-lite",
        texts: textChunks,
      });

      if (chunksEmbeddings.object === "error") {
        console.error(`Voyage API error: ${chunksEmbeddings.detail}`);
        return "No data found";
      }

      await supabaseClient.from("llami_search_embeddings").insert(
        chunksEmbeddings.data.map(({ embedding }, index) => ({
          embedding: JSON.stringify(embedding),
          model: "voyage-3-lite",
          source: "page-rank",
          url,
          text: textChunks[index],
        })),
      );

      const similarities = chunksEmbeddings.data.map((chunk, index) => ({
        text: textChunks[index],
        similarity: cosineSimilarity(
          queryEmbedding.data[0].embedding,
          chunk.embedding,
        ),
      }));

      const topChunks = similarities
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 20)
        .map((chunk) => `"${chunk.text}"`)
        .join(", ");

      return `[Summarized Search Text]\n${topChunks}`;
    },
    {
      detail: {
        tags: ["Crawling"],
        description: "Crawls page rank",
      },
      body: t.Object({
        apiKey: t.String({
          description: "LLAMI SaaS API key",
          error: "API key is required",
          minLength: 1,
          maxLength: 100,
        }),
        url: t.String({
          description: "The URL to crawl page rank",
          example: "https://www.google.com",
          error: "URL is required",
          pattern: `^https?://`,
          minLength: 1,
          maxLength: 1024,
        }),
        useProxy: t.Boolean({
          description: "Use proxy to scrape",
          example: true,
        }),
        disableTorch: t.Optional(
          t.Boolean({
            description: "Disable torch, ignored if query is provided",
            example: false,
          }),
        ),
        query: t.Optional(
          t.String({
            description: "Query to extract",
            example: "What is the main content of the page?",
          }),
        ),
      }),
      response: t.String({
        description: "Page summary markdown",
      }),
    },
  );
};

const fetchData = async (url: string, useProxy: boolean) => {
  const proxy = useProxy
    ? getProxyString({
        proxyMode: "RESIDENTIAL",
      })
    : undefined;

  const rawHtml = await fetchRetry(url, {
    // @ts-expect-error
    proxy,
    signal: AbortSignal.timeout(5000),
    retries: 3,
    retryDelay: 1000,
    headers: {
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "max-age=0",
      priority: "u=0, i",
      "sec-ch-ua": '"Whale";v="3", "Not-A.Brand";v="8", "Chromium";v="124"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1",
    },
    referrerPolicy: "strict-origin-when-cross-origin",
    body: null,
    method: "GET",
    mode: "cors",
    credentials: "include",
  }).then((response) => response.text());

  return rawHtml;
};
