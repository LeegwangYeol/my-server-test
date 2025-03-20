export const checkPrimaryApiKey = async (apiKey: string) =>
  process.env.PAI_PRIMARY_API_KEY === apiKey;

export const OPEN_AI_API_KEY = process.env.OPEN_AI_API_KEY!;
