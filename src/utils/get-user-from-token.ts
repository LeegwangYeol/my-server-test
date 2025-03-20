import { Cookie } from "elysia";
import { supabaseClient } from "../../lib/supabase/client";
import { JwtPayload, verify } from "jsonwebtoken";

export const parseToken = ({ body, cookie }: { body?: any; cookie?: any }) => {
  const { accessToken: accessTokenFromBody } = body;
  const accessTokenFromCookie = cookie.accessToken as
    | Cookie<string>
    | undefined;

  const accessToken =
    accessTokenFromCookie?.cookie.value ?? accessTokenFromBody;

  if (typeof accessToken !== "string")
    throw new Error("Access token must be a string");

  return verify(accessToken, process.env.JWT_SECRET_KEY!) as JwtPayload;
};

const getUser = async ({ body, cookie }: { body: any; cookie: any }) => {
  const { userId } = parseToken({ body, cookie });
  const { data } = await supabaseClient
    .from("user")
    .select("*")
    .eq("id", userId)
    .limit(1)
    .maybeSingle();
  return data;
};

const getUserV2 = async (request: {
  cookie: { accessToken: Cookie<string> };
}) => {
  const accessToken = request.cookie.accessToken.value;
  const { userId } = verify(
    accessToken,
    process.env.JWT_SECRET_KEY!,
  ) as JwtPayload;

  const { data } = await supabaseClient
    .from("user")
    .select("*")
    .eq("id", userId)
    .limit(1)
    .maybeSingle();
  return data;
};

export { getUser, getUserV2 };
