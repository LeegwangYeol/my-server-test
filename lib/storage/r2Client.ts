import { PutObjectCommand, S3 } from "@aws-sdk/client-s3";
import { nanoid } from "nanoid";
// TODO: Fix sharp import
// import sharp from "sharp";

export const r2Client = new S3({
  region: "auto",
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

export const R2_BUCKET = { bucketName: process.env.R2_BUCKET_NAME } as const;

export const uploadImageFile = async ({
  buffer,
  folder,
  info,
  compress = true,
}: {
  buffer: ArrayBuffer;
  folder: string;
  info?: string;
  compress?: boolean;
}): Promise<string> => {
  const imageId = nanoid();
  let compressedBuffer: Buffer;
  if (compress) {
    // TODO: Fix sharp import
    // compressedBuffer = await sharp(buffer).webp().toBuffer();
    compressedBuffer = Buffer.from(buffer);
  } else {
    compressedBuffer = Buffer.from(buffer);
  }

  const command: PutObjectCommand = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET!,
    Key: `${folder}/${imageId}`,
    Body: compressedBuffer,
    ACL: "public-read",
    ContentType: compress ? "image/webp" : "image/png",
    ...(info && { Metadata: { info } }),
  });
  await r2Client.send(command);
  return `${process.env.STATIC_URL ?? ""}/${folder}/${imageId}`;
};

export const uploadFile = async ({
  buffer,
  folder,
  info,
}: {
  buffer: ArrayBuffer;
  folder: string;
  info?: string;
}) => {
  const fileId = nanoid();
  const command: PutObjectCommand = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET!,
    Key: `${folder}/${fileId}`,
    Body: Buffer.from(buffer),
    ACL: "public-read",
    ...(info && { Metadata: { info } }),
  });

  await r2Client.send(command);
  return `${process.env.STATIC_URL ?? ""}/${folder}/${fileId}`;
};
