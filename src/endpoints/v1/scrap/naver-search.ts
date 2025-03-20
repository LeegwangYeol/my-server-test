import { Elysia, t } from "elysia";
import { checkPrimaryApiKey } from "../../../../lib/api-key";
import { supabaseClient } from "@/lib/supabase/client";
import { voyage } from "@/lib/ai/voyage";
import { fetchGoogleSearch, processGoogleTorchResult } from "./google-search";

export const v1ScrapNaverSearch = async (app: Elysia<"/v1/scrap">) => {
  app.post(
    "/naver/search",
    async ({ body: { apiKey, query, useProxy } }) => {
      if (!(await checkPrimaryApiKey(apiKey))) {
        throw new Error("Invalid API key");
      }

      console.log(`Embedding naver search query: "${query}"`);

      const queryEmbedding = await voyage.embeddings({
        model: "voyage-3-lite",
        texts: [query],
      });

      if (queryEmbedding.object === "error") {
        console.error(`Voyage API error: ${queryEmbedding.detail}`);
        return { links: [] };
      }

      await supabaseClient.from("llami_search_embeddings").insert({
        embedding: JSON.stringify(queryEmbedding.data[0].embedding),
        model: "voyage-3-lite",
        source: "query",
        text: query,
      });

      const querried = await supabaseClient.rpc(
        "llami_search_embeddings_match",
        {
          query_embedding: JSON.stringify(queryEmbedding.data[0].embedding),
          query_model: "voyage-3-lite",
          match_threshold: 0.5,
          match_count: 20,
          text_source: "naver",
        },
      );

      let embeddingSearchResults = querried.data
        ?.filter(({ url, title }) => !!url && !!title)
        .map(({ url, text, title }) => ({
          href: url!,
          title: title!,
          summary: text!,
        }));

      // embeddingSearchResults가 없을 경우 빈 배열로 초기화
      if (!embeddingSearchResults) {
        embeddingSearchResults = [];
      }

      // 결과가 10개 이상이면 바로 반환
      if (embeddingSearchResults.length >= 10) {
        return {
          links: embeddingSearchResults,
        };
      }

      console.log(`Scraping NAVER search results for query: "${query}"`);

      const { summaryJSON } = await fetchGoogleSearch(
        `${query} site:naver.com`,
        useProxy,
        "KR",
      );

      const { links, elements } = summaryJSON;
      const elementsFlat = elements.flatMap((element: any) => element.children);

      const data = processGoogleTorchResult({ links, elements, elementsFlat });
      console.log(`NAVER search results length: ${data.length}`);

      // 새로운 검색 결과가 없을 경우 기존 결과 반환
      if (data.length === 0) {
        return { links: embeddingSearchResults };
      }

      const embeddings = await voyage.embeddings({
        model: "voyage-3-lite",
        texts: data.map(({ summary }) => summary),
      });

      if (embeddings.object === "error") {
        console.error(`Voyage API error: ${embeddings.detail}`);
        return { links: embeddingSearchResults.concat(data) };
      }

      await supabaseClient.from("llami_search_embeddings").insert(
        embeddings.data.map(({ embedding }, index) => ({
          embedding: JSON.stringify(embedding),
          model: "voyage-3-lite",
          source: "naver",
          text: data[index].summary,
          url: data[index].href,
          title: data[index].title,
        })),
      );

      // 기존 결과와 새로운 결과를 합침
      const combinedResults = embeddingSearchResults.concat(data);

      return { links: combinedResults };
    },
    {
      detail: {
        tags: ["Scraping"],
        description: "Scrapes NAVER search results",
      },
      body: t.Object({
        apiKey: t.String({
          description: "LLAMI SaaS API key",
          error: "API key is required",
          minLength: 1,
          maxLength: 100,
        }),
        query: t.String({
          description: "The query to search on NAVER",
          example: "초코파이",
          error: "Query is required",
          minLength: 1,
          maxLength: 1024,
        }),
        useProxy: t.Boolean({
          description: "Use proxy to scrape Google search results",
          example: true,
        }),
      }),
      response: t.Object({
        links: t.Array(
          t.Object({
            href: t.String({
              description: "The URL of the search result",
              example: "https://en.wikipedia.org/wiki/Paris",
            }),
            title: t.String({
              description: "The title of the search result",
              example: "Paris - Wikipedia",
            }),
            summary: t.String({
              description: "The summary of the search result",
              example:
                "Paris is the capital and most populous city of France, with an estimated population of 2,175,601 residents as of 2018, in an area of more than 105 square kilometres (41 square miles).",
            }),
          }),
        ),
      }),
    },
  );
};
