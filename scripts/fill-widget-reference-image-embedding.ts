import dotenv from "dotenv";
import { printLLAMIASCII } from "@/lib/ascii";

import { voyage } from "@/lib/ai/voyage";
import { supabaseClient } from "@/lib/supabase/client";

printLLAMIASCII("🚀 Running LLAMI API Server Script...");

dotenv.config();

(async () => {
  const { data: images, error } = await supabaseClient
    .from("llami_widget_reference_image")
    .select("*")
    .eq("is_deleted", false)
    .neq("description", "");

  if (error) {
    console.error("Error load widget images", error);
    return;
  }

  const embeddings = await voyage.embeddings({
    model: "voyage-3-lite",
    texts: images.map((image) => image.description),
  });

  if (embeddings.object === "error") {
    console.error("Error embeddings", embeddings.detail);
    return;
  }

  await Promise.all(
    images.map(async (image, index) => {
      const embedding = embeddings.data[index].embedding;
      const { data, error } = await supabaseClient
        .from("llami_widget_reference_image")
        .update({
          embedding: JSON.stringify(embedding),
          model: "voyage-3-lite",
        })
        .eq("id", image.id);

      if (error) {
        console.error("Error update widget image", error);
        return;
      }
    }),
  );

  console.log("Done");
})();
