import { Elysia, t } from "elysia";

// https://api.llami.net/v1//script/16a46741-768b-4ab1-9b4b-2626773a859d
export const v1ChatScript = async (app: Elysia<"/v1/link">) => {
  app.get(
    "/chat/script/:id",
    ({ params: { id } }: { params: { id: string } }) => {
      const scriptContent = `function addScriptToHead(id) {
  var head = document.head;
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.type = 'text/css';
  link.href = 'https://static.llami.net/widget-v1.css';
  head.appendChild(link);

  var script = document.createElement('script');
  script.type = 'module';
  script.innerHTML = \`import { initialize, run } from 'https://static.llami.net/widget-v1.js';
  run("${id}");\`;
  head.appendChild(script);
}\naddScriptToHead("${id}");`.trim();

      return scriptContent;
    },
    {
      detail: {
        tags: ["Link"],
        description: "get llami chat script",
      },
    },
  );
};
