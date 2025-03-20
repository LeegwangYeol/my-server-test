import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WidgetOverview = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/overview",
    async ({ body, cookie }) => {
      const { workspaceId, threadLimit = 1000 } = body;
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // 사용자가 멤버로 있는 워크스페이스 멤버 조회
      const workspaceMembersResponse = await supabaseClient
        .from("llami_workspace_member")
        .select("*")
        .eq("is_deleted", false)
        .eq("user_id", user.id);

      const workspaceMembers = workspaceMembersResponse.data ?? [];
      const memberWorkspaceIds = workspaceMembers.map(
        (member) => member.workspace_id,
      );

      // 사용자가 소유자이거나 멤버인 모든 워크스페이스 조회
      const workspacesResponse = await supabaseClient
        .from("llami_workspace")
        .select("*")
        .eq("is_deleted", false)
        .or(`id.in.(${memberWorkspaceIds.join(",")}),owner.eq.${user.id}`);

      const workspaceResults = workspacesResponse.data ?? [];

      // 유효한 워크스페이스 ID 결정
      let effectiveWorkspaceId = workspaceId;
      if (!effectiveWorkspaceId) {
        // 사용자의 defaultWorkspace 조회
        const { data: defaultWorkspace } = await supabaseClient
          .from("llami_default_workspace")
          .select("workspace_id")
          .eq("user_id", user.id)
          .maybeSingle();

        // defaultWorkspace가 없거나 null인 경우 첫 번째 워크스페이스로 설정
        if (!defaultWorkspace?.workspace_id && workspaceResults.length > 0) {
          effectiveWorkspaceId = workspaceResults[0].id;

          // defaultWorkspace 자동 설정
          await supabaseClient.from("llami_default_workspace").upsert({
            user_id: user.id,
            workspace_id: effectiveWorkspaceId,
            updated_at: new Date().toISOString(),
          });
        } else if (defaultWorkspace?.workspace_id) {
          effectiveWorkspaceId = defaultWorkspace.workspace_id;
        }

        if (!effectiveWorkspaceId) {
          return {
            success: false,
            message: "사용 가능한 워크스페이스가 없습니다.",
          };
        }
      }

      // 유효한 워크스페이스와 관련된 데이터 조회
      const [
        workspaceResponse,
        widgetsResponse,
        threadsResponse,
        paymentResponse,
        usageResponse,
        preMemberInvitesResponse,
        membersResponse,
        threadCountResponse,
      ] = await Promise.all([
        supabaseClient
          .from("llami_workspace")
          .select("*")
          .eq("id", effectiveWorkspaceId)
          .maybeSingle(),
        supabaseClient
          .from("llami_widget")
          .select("*, file_list:llami_vector_file_description!left(*)")
          .eq("workspace_id", effectiveWorkspaceId)
          .eq("is_deleted", false)
          .eq("file_list.is_deleted", false),
        supabaseClient
          .from("llami_widget_thread")
          .select(
            `
            *,
            widget:llami_widget!inner(is_deleted)
          `,
          )
          .eq("workspace_id", effectiveWorkspaceId)
          .eq("is_deleted", false)
          .eq("widget.is_deleted", false)
          .order("updated_at", { ascending: false })
          .limit(threadLimit),
        supabaseClient
          .from("llami_widget_payment_log")
          .select("*")
          .eq("payer_id", user.id)
          .eq("is_deleted", false)
          .order("payment_at", { ascending: false })
          .limit(99),
        supabaseClient
          .from("llami_workspace_usage_limit")
          .select("*")
          .eq("workspace_id", effectiveWorkspaceId),
        supabaseClient
          .from("llami_workspace_member_invite")
          .select("*")
          .eq("workspace_id", effectiveWorkspaceId)
          .eq("is_pending", true)
          .eq("is_rejected", false)
          .eq("is_deleted", false),
        supabaseClient
          .from("llami_workspace_member")
          .select(`* ,user:user_id(*)`)
          .eq("workspace_id", effectiveWorkspaceId)
          .eq("is_deleted", false),
        supabaseClient
          .from("llami_widget_thread")
          .select(
            `
            id,
            widget:llami_widget!inner(is_deleted)
          `,
            { count: "exact", head: true },
          )
          .eq("workspace_id", effectiveWorkspaceId)
          .eq("is_deleted", false)
          .eq("widget.is_deleted", false),
      ]);

      const widgets = widgetsResponse.data ?? [];
      const threads = threadsResponse.data ?? [];
      const payment = paymentResponse.data ?? [];
      const usage = usageResponse.data ?? [];
      const preMemberInvites = preMemberInvitesResponse.data ?? [];
      const members = membersResponse.data ?? [];

      // 초대가 진행 중인 멤버 조회
      const preMembers = await Promise.all(
        preMemberInvitesResponse.data!.map(async (invite) => {
          const { data: invitedUser } = await supabaseClient
            .from("user")
            .select("*")
            .eq("id", invite.invited_user_id!)
            .eq("is_deleted", false)
            .limit(1)
            .maybeSingle();

          if (!invitedUser) {
            throw new Error("존재하지 않는 유저입니다.");
          }

          return {
            ...invitedUser,
            ...invite,
            id: invitedUser.id,
            is_deleted: invite.is_deleted,
            user_id: invitedUser.id,
          };
        }),
      );

      // 워크스페이스 객체에 멤버와 초대된 멤버 포함
      const workspace = {
        ...workspaceResponse.data,
        members: membersResponse.data,
        pre_members: preMembers,
      };

      // 모든 워크스페이스의 멤버를 조회하여 멤버 수 계산
      const allWorkspaceIds = workspaceResults.map((w) => w.id);
      const allMembersResponse = await supabaseClient
        .from("llami_workspace_member")
        .select("workspace_id")
        .eq("is_deleted", false)
        .in("workspace_id", allWorkspaceIds);

      const allMembers = allMembersResponse.data ?? [];

      // 각 워크스페이스의 멤버 수 계산
      const memberCounts: Record<string, number> = {};
      allMembers.forEach((member) => {
        memberCounts[member.workspace_id] =
          (memberCounts[member.workspace_id] || 0) + 1;
      });

      // 각 워크스페이스에 멤버 수 추가
      const workspaces = workspaceResults.map((workspace) => {
        return {
          ...workspace,
          member_count: memberCounts[workspace.id] || 0,
        };
      });

      // 스레드 ID 목록 추출
      const threadIds = threads.map((thread) => thread.id);

      // 메시지 정보 조회
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

      // 메시지 개수와 마지막 메시지 처리
      const messageCountsMap: Record<string, number> = {};
      const lastMessagesMap: Record<string, string | null> = {};

      messages.forEach((message) => {
        const threadId = message.thread_id!;
        if (!messageCountsMap[threadId]) {
          messageCountsMap[threadId] = 0;
        }
        messageCountsMap[threadId]++;

        // 마지막 메시지 업데이트
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

      // 스레드에 메시지 정보 추가
      const threadsWithMessages = threads.map((thread) => ({
        ...thread,
        message_count: messageCountsMap[thread.id] || 0,
        last_message: lastMessagesMap[thread.id] ?? "",
      }));

      // 스레드별 연락처 존재 여부 확인
      const { data: contactCounts, error: contactsError } = await supabaseClient
        .from("llami_widget_thread_contact")
        .select("thread_id")
        .in("thread_id", threadIds);

      if (contactsError) {
        console.error("연락처 정보 조회 중 오류:", contactsError);
        return {
          success: false,
          message: "연락처 정보를 조회하는 중 오류가 발생했어요",
        };
      }

      // 연락처가 있는 스레드 ID 집합
      const hasContactThreadIds = new Set(
        contactCounts?.map((c) => c.thread_id),
      );

      // 스레드 정보에 연락처 존재 여부 추가
      const threadsWithContacts = threadsWithMessages.map((thread) => ({
        ...thread,
        has_contact: hasContactThreadIds.has(thread.id),
      }));

      const overview = {
        workspace,
        workspaces,
        widgets,
        threads: threadsWithContacts,
        payment,
        usage,
        user,
        threadTotalCount: threadCountResponse.count ?? threads.length,
      };

      return {
        success: true,
        message: "성공적으로 조회되었습니다.",
        overview,
      };
    },
    {
      detail: {
        tags: ["Widget"],
        description: "Widget Service Overview",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
        workspaceId: t.Optional(
          t.String({
            description: "Workspace ID",
            error: "Workspace ID is required",
          }),
        ),
        threadLimit: t.Optional(
          t.Number({
            description: "Thread Limit",
            error: "Thread Limit must be a number",
            default: 1000,
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
        overview: t.Optional(
          t.Object({
            workspace: t.Any(),
            workspaces: t.Any(),
            widgets: t.Any(),
            threads: t.Any(),
            payment: t.Any(),
            usage: t.Any(),
            user: t.Any(),
            threadTotalCount: t.Number({
              description: "Thread total Count",
            }),
          }),
        ),
      }),
    },
  );
};
