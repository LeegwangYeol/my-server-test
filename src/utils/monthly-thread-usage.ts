import { t } from "elysia";
import { supabaseClient } from "../../lib/supabase/client";
import { parseToken } from "@/lib/jwt/token";
export const getCurrentMonthWidgetUsage = async ({
  body,
  cookie,
}: {
  body: any;
  cookie: any;
}) => {
  let totalChats = 0;
  try {
    const { userId } = parseToken({ body, cookie });
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const endOfMonth = new Date(startOfMonth);
    endOfMonth.setMonth(endOfMonth.getMonth() + 1);
    const { count, error } = await supabaseClient
      .from("llami_widget_thread")
      .select("*", { count: "exact", head: true })
      .gte("created_at", startOfMonth.toISOString())
      .lt("created_at", endOfMonth.toISOString());
    console.log("Total chats:", count);
    return {
      success: true,
      total_chats: count,
    };
  } catch (error) {
    console.error("Error fetching usage:", error);
    return null;
  }

  return {
    total_chats: totalChats,
  };
};
