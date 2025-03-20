import Elysia from "elysia";
import { v1WorkspaceList } from "./list";
import { v1WorkspaceUpdate } from "./update";
import { v1WorkspaceView } from "./view";
import { v1WorkspaceMemberList } from "./member-list";
import { v1WorkspaceMemberInvite } from "./member-invite";
import { v1WorkspaceMemberInviteAccept } from "./member-invite-accept";
import { v1WorkspaceMemberDelete } from "./member-delete";
import { v1WorkspaceDelete } from "./delete";
import { v1WorkspaceMemberLeave } from "./member-leave";
import { v1WorkspaceSuccession } from "./succession";
import { v1WorkspaceMemberInviteView } from "./member-invite-view";
import { v1WorkspaceLimitPrecheck } from "./limit-precheck";
import { v1WorkspaceLimitView } from "./limit-view";
import { v1WorkspaceLimitUse } from "./limit-use";

export const v1Workspace = async (app: Elysia<"/v1">) => {
  app.group("/workspace", (app) => {
    v1WorkspaceList(app);
    v1WorkspaceView(app);
    v1WorkspaceUpdate(app);
    v1WorkspaceDelete(app);
    v1WorkspaceSuccession(app);

    v1WorkspaceMemberList(app);
    v1WorkspaceMemberInvite(app);
    v1WorkspaceMemberInviteAccept(app);
    v1WorkspaceMemberInviteView(app);
    v1WorkspaceMemberDelete(app);
    v1WorkspaceMemberLeave(app);

    v1WorkspaceLimitPrecheck(app);
    v1WorkspaceLimitView(app);
    v1WorkspaceLimitUse(app);
    return app;
  });
};
