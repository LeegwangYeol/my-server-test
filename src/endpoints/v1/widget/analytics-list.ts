import { Elysia, t } from "elysia";
import { getWeeklyWidgetUsage } from "@/src/utils/weekly-thread-usage";

export const v1WidgetAnalyticsList = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/get/analytics",
    async ({ body }) => {
      const { workspaceId } = body;
      const weeklyData = await getWeeklyWidgetUsage({ workspaceId });
      return {
        success: true,
        message: "통계목록을 성공적으로 불러왔습니다.",
        weeklyUsage: weeklyData?.weekley_data,
      };
    },
    {
      detail: {
        tags: ["Widget Thread"],
        description: "Get analytics List",
      },
      body: t.Object({
        accessToken: t.String(),
        workspaceId: t.String({
          description: "Workspace ID",
          error: "Workspace ID is required",
          minLength: 1,
          maxLength: 100,
        }),
      }),
      response: t.Object({
        success: t.Boolean({
          description: "Success",
          error: "Success is required",
        }),
        message: t.Optional(
          t.String({
            description: "Message",
            error: "Message is required",
            minLength: 1,
            maxLength: 1000,
          }),
        ),
        weeklyUsage: t.Optional(
          t.Array(
            t.Object({
              date: t.String({
                description: "Week",
              }),
              daily_chats: t.Number({
                description: "Count",
              }),
            }),
          ),
        ),
      }),
    },
  );
};
