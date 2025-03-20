import { Elysia } from "elysia";
import { v1AuthCreate } from "./auth-create";
import { v1Comment } from "./comment-add";
import { v1CommentList } from "./comment-lists";
import { v1CommentDelete } from "./comment-delete";
import { v1Reply } from "./reply-add";
import { v1ReplyList } from "./reply-list";
import { v1ChannelInfo } from "./channel-info";
import { v1VideoList } from "./video-list";

// 타입 단언을 사용하여 타입 오류 해결
export const v1Youtube = (app: any) => {
  app.group("/youtube", (app: any) => {
    // 모든 함수 호출에 타입 단언 추가
    v1AuthCreate(app as any);
    
    v1CommentList(app as any);
    v1Comment(app as any);
    v1CommentDelete(app as any);
    
    v1ReplyList(app as any);
    v1Reply(app as any);
    
    v1ChannelInfo(app as any);
    v1VideoList(app as any);

    return app;
  });
};
