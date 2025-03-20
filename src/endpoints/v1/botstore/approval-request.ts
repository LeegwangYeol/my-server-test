import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1BotstoreApprovalRequest = (app: Elysia<"/v1/botstore">) => {
  app.post(
    "/approval/request",
    async ({ body, cookie }) => {
      const { widgetId } = body;

      // 1. Verify access token
      const user = await getUser({ body, cookie });
      if (!user) {
        throw new Error("Invalid access token");
      }

      // 2. Get user's workspaces (both as member and owner)
      const { data: workspaces, error: workspaceError } = await supabaseClient
        .from("llami_workspace_member")
        .select("workspace_id")
        .eq("is_deleted", false)
        .eq("user_id", user.id);

      const { data: _workspaces, error: _workspaceError } = await supabaseClient
        .from("llami_workspace")
        .select("workspace_id:id")
        .eq("is_deleted", false)
        .eq("owner", user.id);

      if (_workspaceError || workspaceError) {
        console.error(_workspaceError, workspaceError);
        throw new Error("Failed to fetch user's workspaces");
      }

      const workspaceIds = [..._workspaces, ...workspaces].map(
        (e) => e.workspace_id,
      );

      // 3. Check if widget exists and belongs to user's workspace
      const { data: widget, error: widgetError } = await supabaseClient
        .from("llami_widget")
        .select("*")
        .eq("id", widgetId)
        .eq("is_deleted", false)
        .in("workspace_id", workspaceIds)
        .single();

      if (widgetError || !widget) {
        throw new Error("Widget not found or not accessible");
      }

      // 3. Check for existing approval request
      const { data: existingApproval, error: approvalError } =
        await supabaseClient
          .from("llami_widget_botstore_approval")
          .select("*")
          .eq("widget_id", widgetId)
          .single();

      if (existingApproval) {
        throw new Error("Approval request already exists for this widget");
      }

      // 4. Create new approval request
      const { data: approval, error: createError } = await supabaseClient
        .from("llami_widget_botstore_approval")
        .insert([
          {
            widget_id: widgetId,
            status: "pending",
          },
        ])
        .select()
        .single();

      if (createError) {
        throw new Error("Failed to create approval request");
      }

      return {
        success: true,
        data: approval,
      };
    },
    {
      body: t.Object({
        accessToken: t.String({
          description: "Access Token",
          error: "Access Token is required",
        }),
        widgetId: t.String({
          description: "Widget ID",
          error: "Widget ID is required",
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
      }),
    },
  );
};
