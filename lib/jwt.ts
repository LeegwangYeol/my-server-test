import jwt, { JwtPayload } from "jsonwebtoken";

interface Payload {
  userId: string;
}
const secretKey = process.env.JWT_SECRET_KEY!;

const generateToken = (payload: Payload) => {
  const token = jwt.sign(payload, secretKey, { expiresIn: "365d" });
  return token;
};

// const refreshToken = (token: string) => {
//   try {
//     const decoded = jwt.verify(token, secretKey) as JwtPayload;
//     const payload = { userId: decoded.userId };
//     return generateToken(payload);
//   } catch (error) {
//     console.error("Error refreshing token:", error);
//     return null;
//   }
// };

export const createJwt = (payload: Payload) => generateToken(payload);
