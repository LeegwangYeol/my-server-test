import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WidgetThreadList = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/thread/list",
    async ({ body, cookie }) => {
      const { workspaceId, page = 1, limit = 1000 } = body;

      // Validate page and pageSize
      if (page < 1) {
        return {
          success: false,
          message: "페이지 번호는 1 이상이어야 합니다.",
        };
      }

      if (limit < 1) {
        return {
          success: false,
          message: "페이지 크기가 유효하지 않습니다.",
        };
      }

      const offset = (page - 1) * limit;

      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // * 워크스페이스 정보 확인
      const { data: workspace } = await supabaseClient
        .from("llami_workspace")
        .select("*")
        .eq("id", workspaceId)
        .limit(1)
        .maybeSingle();

      // * 워크스페이스 예외처리
      {
        if (!workspace) {
          return {
            success: false,
            message: "존재하지 않는 조직입니다.",
          };
        }
        if (workspace.is_deleted) {
          return {
            success: false,
            message: "이미 삭제된 조직입니다.",
          };
        }
      }

      // * 사용자가 멤버로 있는 워크스페이스 멤버 조회
      const workspaceMembersResponse = await supabaseClient
        .from("llami_workspace_member")
        .select("*")
        .eq("is_deleted", false)
        .eq("user_id", user.id);

      const workspaceMembers = workspaceMembersResponse.data ?? [];
      const memberWorkspaceIds = workspaceMembers.map(
        (member) => member.workspace_id,
      );

      // * 사용자가 소유자이거나 멤버인지 확인
      const isOwnerOrMember =
        workspace.owner === user.id || memberWorkspaceIds.includes(workspaceId);
      if (!isOwnerOrMember) {
        return {
          success: false,
          message: "해당 조직에 속한 사용자가 아닙니다.",
        };
      }

      // * 스레드 목록 조회
      const [
        { data: threads, error: threadError },
        { count, error: threadSizeError },
      ] = await Promise.all([
        supabaseClient
          .from("llami_widget_thread")
          .select(
            `
            *,
            widget:llami_widget!inner(is_deleted)
          `,
          )
          .eq("workspace_id", workspaceId)
          .eq("is_deleted", false)
          .eq("widget.is_deleted", false)
          .order("created_at", { ascending: true })
          .range(offset, offset + limit - 1),
        supabaseClient
          .from("llami_widget_thread")
          .select(
            `
            id,
            widget:llami_widget!inner(is_deleted)
          `,
            { count: "exact", head: true },
          )
          .eq("workspace_id", workspaceId)
          .eq("is_deleted", false)
          .eq("widget.is_deleted", false),
      ]);

      if (threadError) {
        console.error(threadError);
        return {
          success: false,
          message:
            "네트워크 오류가 발생했습니다. 잠시 후 다시 시도해주세요. 문제가 지속될 경우 관리자에게 문의해주세요.",
        };
      }

      if (threadSizeError) {
        console.error(threadSizeError);
        return {
          success: false,
          message:
            "스레드 목록을 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
        };
      }

      const threadIds = threads.map((thread) => thread.id);

      // * 스레드별 연락처 존재 여부 확인
      const { data: contactCounts, error: contactsError } = await supabaseClient
        .from("llami_widget_thread_contact")
        .select("thread_id")
        .in("thread_id", threadIds);

      if (contactsError) {
        console.error("연락처 정보 조회 중 오류:", contactsError);
        return {
          success: false,
          message:
            "연락처 정보를 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
        };
      }

      // * 연락처가 있는 스레드 ID 집합
      const hasContactThreadIds = new Set(
        contactCounts?.map((c) => c.thread_id),
      );

      // * 메시지 정보 조회
      const { data: messages, error: messagesError } = await supabaseClient
        .from("llami_widget_thread_message")
        .select("thread_id, content, created_at")
        .in("thread_id", threadIds);

      if (messagesError) {
        console.error(messagesError);
        return {
          success: false,
          message:
            "메시지 정보를 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
        };
      }

      // * 메시지 개수와 마지막 메시지 처리
      const messageCountsMap: Record<string, number> = {};
      const lastMessagesMap: Record<string, string | null> = {};

      messages.forEach((message) => {
        const threadId = message.thread_id!;
        if (!messageCountsMap[threadId]) {
          messageCountsMap[threadId] = 0;
        }
        messageCountsMap[threadId]++;

        if (
          !lastMessagesMap[threadId] ||
          new Date(message.created_at) >
            new Date(
              messages.find(
                (m) =>
                  m.thread_id === threadId &&
                  m.content === lastMessagesMap[threadId],
              )?.created_at || 0,
            )
        ) {
          lastMessagesMap[threadId] = message.content;
        }
      });

      // * 스레드에 메시지 정보 추가
      // TODO: 쓰레드의 마지막 메시지와 메시지 개수를, 메시지를 등록할 때 마다 동기화 하는 방식으로 변방(superbase event call 등록)
      const threadsWithMessages = threads.map((thread) => ({
        ...thread,
        message_count: messageCountsMap[thread.id] || 0,
        last_message: lastMessagesMap[thread.id] ?? "",
        has_contact: hasContactThreadIds.has(thread.id),
      }));

      const totalCount = count ?? 0;
      return {
        success: true,
        message: "스레드 목록을 성공적으로 불러왔습니다.",
        threads: threadsWithMessages,
        pagination: {
          total: totalCount,
          page,
          totalPages: Math.ceil(totalCount / limit),
        },
      };
    },
    {
      detail: {
        tags: ["Widget Thread"],
        description: "Get Thread List",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
        workspaceId: t.String({
          description: "Workspace ID",
          error: "Workspace ID is required",
          minLength: 1,
          maxLength: 1000,
        }),
        page: t.Optional(
          t.Integer({
            description: "Page number (1-based)",
            error: "Page must be a positive number",
            default: 1,
          }),
        ),
        limit: t.Optional(
          t.Integer({
            description: "Number of items per page",
            error: "Page size must be a positive number",
            default: 20,
          }),
        ),
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
        threads: t.Optional(
          t.Array(
            t.Object({
              id: t.String({
                description: "Thread ID",
              }),
              widget_id: t.String({
                description: "Widget ID",
              }),
              created_at: t.String({
                description: "Created At",
              }),
              updated_at: t.Nullable(
                t.String({
                  description: "Updated At",
                }),
              ),
              is_deleted: t.Nullable(
                t.Boolean({
                  description: "Is Deleted",
                }),
              ),
              last_message: t.String({
                description: "Last Message",
              }),
              message_count: t.Number({
                description: "Message Count",
              }),
              has_contact: t.Boolean({
                description: "Has Contact",
              }),
            }),
          ),
        ),
        pagination: t.Optional(
          t.Object({
            total: t.Number({
              description: "Total number of items",
            }),
            page: t.Number({
              description: "Current page number",
            }),
            totalPages: t.Number({
              description: "Total number of pages",
            }),
          }),
        ),
      }),
    },
  );
};
