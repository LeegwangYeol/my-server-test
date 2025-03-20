import { Elysia, t } from "elysia";
import { checkPrimaryApiKey } from "../../../../lib/api-key";
import { supabaseClient } from "@/lib/supabase/client";
import { voyage } from "@/lib/ai/voyage";
import { fetchGoogleSearch, processGoogleTorchResult } from "./google-search";

const bodySchema = t.Object({
  apiKey: t.String({
    description: "LLAMI SaaS API key",
    error: "API key is required",
    minLength: 1,
    maxLength: 100,
  }),
  query: t.String({
    description: "The query to search on Coupang",
    example: "초코파이",
    error: "Query is required",
    minLength: 1,
    maxLength: 1024,
  }),
  useProxy: t.Boolean({
    description: "Use proxy to scrape Coupang search results",
    example: true,
  }),
  sortBy: t.String({
    description: "Sort by",
    example: "best",
    enum: ["lowPrice", "highPrice", "best"],
    default: "best",
  }),
  priceRange: t.String({
    description: "Price range, Set as `min-max`, e.g. `10000-20000`",
    pattern: `^\\d+-\\d+$`,
  }),
  page: t.Integer({
    description: "The page number of the search results",
    example: 1,
    default: 1,
  }),
});

bodySchema.required = ["apiKey", "query", "useProxy"];

export const v1ScrapCoupangSearch = async (app: Elysia<"/v1/scrap">) => {
  app.post(
    "/coupang/search",
    async ({ body: { apiKey, query, useProxy, sortBy, priceRange, page } }) => {
      if (!(await checkPrimaryApiKey(apiKey))) {
        throw new Error("Invalid API key");
      }

      console.log(`Embedding coupang search query: "${query}"`);

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
          text_source: "coupang",
        },
      );

      let embeddingSearchResults = querried.data
        ?.filter(({ url, title }) => !!url && !!title)
        .map(({ url, title }) => ({
          href: url!,
          title: title!,
        }));

      // embeddingSearchResults가 10개 미만이면 추가 검색 수행
      if (!embeddingSearchResults || embeddingSearchResults.length < 10) {
        console.log(
          `Scraping Coupang search results for query: ${JSON.stringify({
            query,
            sortBy,
            priceRange,
            page,
          })}`,
        );

        const { summaryJSON } = await fetchGoogleSearch(
          `${query} site:coupang.com`,
          useProxy,
          "KR",
        );

        const { links, elements } = summaryJSON;
        const elementsFlat = elements.flatMap(
          (element: any) => element.children,
        );

        const data = processGoogleTorchResult({
          links,
          elements,
          elementsFlat,
        });
        console.log(`Coupang search results length: ${data.length}`);

        if (data.length > 0) {
          const embeddings = await voyage.embeddings({
            model: "voyage-3-lite",
            texts: data.map(({ title }) => title),
          });

          if (embeddings.object === "error") {
            console.error(`Voyage API error: ${embeddings.detail}`);
            return { links: embeddingSearchResults || [] };
          }

          await supabaseClient.from("llami_search_embeddings").insert(
            embeddings.data.map(({ embedding }, index) => ({
              embedding: JSON.stringify(embedding),
              model: "voyage-3-lite",
              source: "coupang",
              text: data[index].title,
            })),
          );

          // 기존 결과와 새로운 데이터를 병합
          embeddingSearchResults = [...(embeddingSearchResults || []), ...data];
        }
      }

      return { links: embeddingSearchResults || [] };
    },
    {
      detail: {
        tags: ["Scraping"],
        description: "Scrapes Coupang search results",
      },
      body: bodySchema,

      response: t.Object({
        links: t.Array(
          t.Object({
            href: t.String({
              description: "The URL of the search result",
              example: "https://www.coupang.com/vp/products/1836993526",
            }),
            title: t.String({
              description: "The title of the search result",
              example:
                "로얄캐닌 캣 파우치 인도어 습식사료 습식사료/주식캔/주식파우치, 인도어, 85g, 24개",
            }),
          }),
        ),
      }),
    },
  );
};
