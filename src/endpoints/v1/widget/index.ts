import Elysia, { AnyElysia } from "elysia";
import { v1WidgetUpdate } from "./update";
import { v1WidgetList } from "./list";
import { v1WidgetDelete } from "./delete";
import { v1WidgetTransfer } from "./transfer";
import { v1WidgetThreadList } from "./thread-list";
import { v1WidgetThreadDelete } from "./thread-delete";
import { v1WidgetThreadNew } from "./thread-new";
import { v1WidgetThreadView } from "./thread-view";
import { v1WidgetThreadAppend } from "./thread-append";
import { v1WidgetThreadContext } from "./thread-context";
import { v1WidgetOverview } from "./overview";
import { v1WidgetProfileUpload } from "./profile-upload";
import { v1WidgetFileUpload } from "./file-upload";
import { v1WidgetThreadMessageList } from "./thread-message-list";
import { v1WidgetReferenceImageList } from "./reference-image-list";
import { v1WidgetReferenceImageUpload } from "./reference-image-upload";
import { v1WidgetAnalyticsList } from "./analytics-list";
import { v1WidgetReferenceFileList } from "./reference-file-list";
import { v1WidgetReferenceFileUpload } from "./reference-file-upload";
import { v1WidgetCustomIconUpload } from "./custom-icon-upload";
import { v1WidgetThreadContact } from "./thread-contact";
import { v1PaymentWorkspace } from "./payment";
import { v1WidgetThreadContactList } from "./thread-contact-list";
import { v1WidgetMessageCount } from "./message-count";
import { v1WidgetCustomLogoUpload } from "./custom-logo-upload";

export const v1Widget = async (app: Elysia<"/v1">) => {
  app.group("/widget", (app: AnyElysia) => {
    v1WidgetOverview(app);

    v1WidgetList(app);
    v1WidgetUpdate(app);
    v1WidgetDelete(app);
    v1WidgetTransfer(app);

    v1WidgetThreadList(app);
    v1WidgetThreadDelete(app);
    v1WidgetThreadNew(app);
    v1WidgetThreadView(app);
    v1WidgetThreadAppend(app);
    v1WidgetThreadMessageList(app);
    v1WidgetThreadContext(app);
    v1WidgetThreadContact(app);
    v1WidgetThreadContactList(app);
    v1WidgetMessageCount(app);

    v1WidgetProfileUpload(app);
    v1WidgetFileUpload(app);

    v1WidgetReferenceFileList(app);
    v1WidgetReferenceFileUpload(app);

    v1WidgetReferenceImageList(app);
    v1WidgetReferenceImageUpload(app);

    v1WidgetAnalyticsList(app);

    v1WidgetCustomIconUpload(app);
    v1WidgetCustomLogoUpload(app);
    v1WidgetThreadContact(app);

    v1PaymentWorkspace(app);

    return app;
  });
};
