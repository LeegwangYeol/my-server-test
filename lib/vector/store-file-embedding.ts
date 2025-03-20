import { voyage } from "@/lib/ai/voyage";
import {
  chunkText,
  chunkPdf,
  chunkCsv,
  chunkDocx,
  chunkPptx,
} from "@/src/utils/chunk-readable";
import { supabaseClient } from "../supabase/client";

const SUPPORTED_FILE_EXTENSIONS = ["txt", "pdf", "csv", "docx", "pptx"];

export const storeFileEmbedding = async (
  url: string,
  fileName: string,
  widgetId: string,
): Promise<void> => {
  const extname = fileName.split(".").pop();
  if (!extname || !SUPPORTED_FILE_EXTENSIONS.includes(extname)) {
    throw new Error(
      "올바르지 않은 파일 타입입니다. 현재 지원되는 타입은 다음과 같습니다: " +
        SUPPORTED_FILE_EXTENSIONS.join(", "),
    );
  }

  const blob = await fetch(url).then((res) => res.blob());

  const chunks = await (async () => {
    switch (extname) {
      case "pdf":
        return await chunkPdf(blob);
      case "csv":
        return await chunkCsv(blob, ",");
      case "docx":
        return await chunkDocx(blob);
      case "pptx":
        return await chunkPptx(blob);
      default:
        return await chunkText(await blob.text());
    }
  })();

  if (chunks.length === 0) {
    return;
  }

  const embedding = await voyage.embeddings({
    model: "voyage-3-lite",
    texts: chunks.map(({ chunk }) => chunk),
  });

  if (embedding.object === "error") {
    return;
  }

  const { data: fileData } = await supabaseClient
    .from("llami_vector_file_description")
    .insert({
      widget_id: widgetId,
      storage_url: url,
      file_name: fileName,
      file_type: extname,
      is_deleted: false,
      size: blob.size,
    })
    .select("*")
    .single();

  if (!fileData) {
    return;
  }

  await supabaseClient.from("llami_vector_file_embedding").insert(
    embedding.data.map((embedding, index) => ({
      file_id: fileData.id,
      model: "voyage-3-lite",
      embedding: JSON.stringify(embedding.embedding),
      text: chunks[index].chunk,
    })),
  );
};
