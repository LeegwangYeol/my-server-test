import Elysia from "elysia";
import { v1AuthCreate } from "./auth-create";
import { v1Comment } from "./comment-add";
import { v1CommentList } from "./comment-lists";
import { v1CommentDelete } from "./comment-delete";
import { v1Reply } from "./reply-add";
import { v1ReplyList } from "./reply-list";
import { v1ChannelInfo } from "./channel-info";
import { v1VideoList } from "./video-list";

export const v1Youtube = (app: Elysia<"/v1">) => {
  app.group("/youtube", (app) => {
    v1AuthCreate(app);

    v1CommentList(app);
    v1Comment(app);
    v1CommentDelete(app);

    v1ReplyList(app);
    v1Reply(app);

    v1ChannelInfo(app);
    v1VideoList(app);

    return app;
  });
};
