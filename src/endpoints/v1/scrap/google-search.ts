import { Elysia, t } from "elysia";
import { voyage } from "@/lib/ai/voyage";
import { supabaseClient } from "@/lib/supabase/client";
import { ProcessTorchResult } from "@/lib/search-common";
import GPTTorch from "@llami/gpt-torch";
import { checkPrimaryApiKey } from "../../../../lib/api-key";
import { googleSerp } from "../../../../lib/proxy";
import { fetchRetry } from "../../../../lib/fetch-retry";

export const v1ScrapGoogleSearch = async (app: Elysia<"/v1/scrap">) => {
  app.post(
    "/google/search",
    async ({ body: { apiKey, query, useProxy, countryCode } }) => {
      if (!(await checkPrimaryApiKey(apiKey))) {
        throw new Error("Invalid API key");
      }

      console.log(`Embedding google search query: "${query}"`);

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
          text_source: "google",
        },
      );

      const embeddingSearchResults = querried.data
        ?.filter(({ url, title }) => !!url && !!title)
        .map(({ url, text, title }) => ({
          href: url!,
          title: title!,
          summary: text!,
        }));

      let data = embeddingSearchResults || [];

      if (data.length < 10) {
        console.log(`Scraping Google search results for query: "${query}"`);

        const { summaryJSON } = await fetchGoogleSearch(
          query,
          useProxy,
          countryCode,
        );
        const { links, elements } = summaryJSON;
        const elementsFlat = elements.flatMap(
          (element: any) => element.children,
        );

        const scrapedData = processGoogleTorchResult({
          links,
          elements,
          elementsFlat,
        });
        console.log(`Google search results length: ${scrapedData.length}`);

        if (scrapedData.length > 0) {
          const embeddings = await voyage.embeddings({
            model: "voyage-3-lite",
            texts: scrapedData.map(({ summary }) => summary),
          });

          if (embeddings.object === "error") {
            console.error(`Voyage API error: ${embeddings.detail}`);
          } else {
            await supabaseClient.from("llami_search_embeddings").insert(
              embeddings.data.map(({ embedding }, index) => ({
                embedding: JSON.stringify(embedding),
                model: "voyage-3-lite",
                source: "google",
                text: scrapedData[index].summary,
                url: scrapedData[index].href,
                title: scrapedData[index].title,
              })),
            );
          }

          data = data.concat(scrapedData);
        }
      }

      return { links: data };
    },
    {
      detail: {
        tags: ["Scraping"],
        description: "Scrapes Google search results",
      },
      body: t.Object({
        apiKey: t.String({
          description: "LLAMI SaaS API key",
          error: "API key is required",
          minLength: 1,
          maxLength: 100,
        }),
        query: t.String({
          description: "The query to search on Google",
          example: "What is the capital of France?",
          error: "Query is required",
          minLength: 1,
          maxLength: 1024,
        }),
        countryCode: t.String({
          description:
            "The country code to search on Google, list of country codes: https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2",
          example: "KR",
          error: "Country code is required",
          pattern: `^[A-Z]{2}$`,
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
                "Paris is the capital and most populous city of France...",
            }),
          }),
        ),
      }),
    },
  );
};

export const fetchGoogleSearch = async (
  query: string,
  useProxy: boolean,
  countryCode: string,
) => {
  try {
    const rawHtml = useProxy
      ? await googleSerp({ query, proxyMode: "RESIDENTIAL", countryCode })
      : await fetchRetry(
          `https://google.com/search?q=${encodeURIComponent(query)}`,
          {
            headers: { "Accept-Encoding": "identity" },
            signal: AbortSignal.timeout(10000),
            retries: 5,
            retryDelay: 2000,
          },
        ).then((response) => response.text());

    return await GPTTorch(rawHtml);
  } catch (error) {
    console.error(`데이터 가져오기 실패:`, error);
    throw new Error("Google 검색에 실패하였습니다. 다시 시도해 주세요.");
  }
};

export const processGoogleTorchResult: ProcessTorchResult = ({
  links,
  elementsFlat,
}) =>
  links
    .filter(({ href }: { href: string }) => href.startsWith("/url?q=http"))
    .filter(
      ({ href }: { href: string }) =>
        !href.startsWith("/url?q=http://maps.google.com/maps") &&
        !href.startsWith("/url?q=https://maps.google.com/maps") &&
        !href.startsWith("/url?q=http://support.google.com/") &&
        !href.startsWith("/url?q=https://support.google.com/") &&
        !href.startsWith("/url?q=http://accounts.google.com/ServiceLogin") &&
        !href.startsWith("/url?q=https://accounts.google.com/ServiceLogin"),
    )
    .map((link: { href: string; title: string }) => {
      let { href, title } = link;

      // * 현재 href 엘레먼트 인덱스 찾기
      const elementIndex = elementsFlat.findIndex(
        (element: any) => element?.href === href,
      );
      // * 설명을 포함하고 있는 엘레먼트 찾기 (최대 20개 탐색)
      let summary = "";
      for (let i = 1; i <= 20; i++) {
        const nextElement = elementsFlat[elementIndex + i];
        // * 다음 링크가 나타나면 탐색 중단
        if (nextElement?.href?.startsWith("/url?q=http")) {
          break;
        }
        if (nextElement?.tag === "div" && nextElement?.text) {
          summary = nextElement.text;
          break;
        }
      }

      // * Remove /url?q= from the front
      href = href.replace("/url?q=", "");

      // * Decode href
      href = decodeURIComponent(href);

      // * Remove &sa= at the end
      href = href.split("&sa=")[0];

      return {
        href,
        title,
        summary,
      };
    })
    // * summary 가 null 이거나, summary 가 1글자 이하인 경우 제외
    .filter(
      ({ summary }: { summary: string }) => summary && summary.length > 1,
    );
