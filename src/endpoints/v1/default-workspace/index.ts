import Elysia from "elysia";
import { v1DefaultWorkspaceDelete } from "./delete";
import { v1DefaultWorkspaceView } from "./view";
import { v1DefaultWorkspaceAssign } from "./assign";

export const v1DefaultWorkspace = async (app: Elysia<"/v1">) => {
  app.group("/default-workspace", (app) => {
    v1DefaultWorkspaceAssign(app);
    v1DefaultWorkspaceDelete(app);
    v1DefaultWorkspaceView(app);

    return app;
  });
};
