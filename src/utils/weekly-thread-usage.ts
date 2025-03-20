import { parseToken } from "@/lib/jwt/token";
import { supabaseClient } from "../../lib/supabase/client";
import { t } from "elysia";

export const getWeeklyWidgetUsage = async ({
  workspaceId,
}: {
  workspaceId: string;
}) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(today.getDate() - 4);

    const { data, error } = await supabaseClient
      .from("llami_widget_thread")
      .select(
        `
        created_at,
        llami_workspace!left (
          id
        )
        `,
      )
      .eq("workspace_id", workspaceId)
      .gte("created_at", sevenDaysAgo.toISOString())
      .lt(
        "created_at",
        new Date(today.setDate(today.getDate() + 1)).toISOString(),
      );

    const dateRange: Date[] = [];
    const currentDate = new Date(sevenDaysAgo);

    while (currentDate <= today) {
      dateRange.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }

    const dailyChats = dateRange.reduce<Record<string, number>>((acc, date) => {
      const formattedDate = date.toISOString().split("T")[0];
      acc[formattedDate] = 0;
      return acc;
    }, {});

    (data || []).forEach((item) => {
      const date = new Date(item.created_at);
      const formattedDate = date.toISOString().split("T")[0];
      dailyChats[formattedDate] = (dailyChats[formattedDate] || 0) + 1;
    });

    const result = Object.entries(dailyChats)
      .map(([date, count]) => ({
        date,
        daily_chats: count,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      success: true,
      weekley_data: result,
    };
  } catch (error) {
    return {
      success: false,
      error: "Failed to fetch weekly widget usage",
    };
  }
};
