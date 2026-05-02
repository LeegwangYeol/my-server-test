let appPromise: Promise<any> | null = null;

const getApp = () => {
  if (!appPromise) {
    appPromise = (async () => {
      const { createApp } = await import("../src/app");
      return createApp(true);
    })().catch((err) => {
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
};

export default async function handler(request: Request): Promise<Response> {
  try {
    const app = await getApp();
    return await app.handle(request);
  } catch (error: any) {
    console.error("Serverless handler error:", error);
    return new Response(
      JSON.stringify({
        error: "Internal Server Error",
        message: error?.message ?? String(error),
        stack: error?.stack,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
