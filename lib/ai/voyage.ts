interface VoyageEmbeddingResponseSuccess {
  object: "list";
  data: {
    object: "embedding";
    embedding: number[];
    index: number;
  }[];
  model: string;
  usage: {
    total_tokens: number;
  };
}

interface VoyageResponseError {
  object: "error";
  detail: string;
  [key: string]: any;
}

type VoyageEmbeddingResponse =
  | VoyageEmbeddingResponseSuccess
  | VoyageResponseError;

export const voyage = {
  baseUrl: "https://api.voyageai.com/v1",

  embeddings: async ({
    model,
    texts,
  }: {
    model: string;
    texts: string[];
  }): Promise<VoyageEmbeddingResponse> => {
    const url = `${voyage.baseUrl}/embeddings`;
    const batchSize = 128;

    // 텍스트 배열을 batchSize 크기로 나누기
    const batches = Array.from(
      { length: Math.ceil(texts.length / batchSize) },
      (_, i) => texts.slice(i * batchSize, (i + 1) * batchSize),
    );

    try {
      // 각 배치별로 API 호출
      const responses = await Promise.all(
        batches.map(async (batch) => {
          const response = await fetch(url, {
            method: "POST",
            body: JSON.stringify({
              model,
              input: batch,
            }),
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
            },
          });

          if (!response.ok) {
            throw await response.json();
          }
          return (await response.json()) as VoyageEmbeddingResponseSuccess;
        }),
      );

      // 모든 응답 결과 합치기
      const combinedResponse: VoyageEmbeddingResponseSuccess = {
        object: "list",
        data: responses.flatMap((r) => r.data),
        model: responses[0].model,
        usage: {
          total_tokens: responses.reduce(
            (sum, r) => sum + r.usage.total_tokens,
            0,
          ),
        },
      };

      return combinedResponse;
    } catch (error) {
      return {
        object: "error",
        detail: "Voyage API error occurred",
        originalError: error,
      };
    }
  },
};
