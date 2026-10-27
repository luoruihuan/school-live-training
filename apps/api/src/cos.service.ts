import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import COS from "cos-nodejs-sdk-v5";

@Injectable()
export class CosService {
  private client(): COS {
    const secretId = process.env.COS_SECRET_ID;
    const secretKey = process.env.COS_SECRET_KEY;
    if (!secretId || !secretKey) throw new ServiceUnavailableException("COS 访问密钥未配置");
    return new COS({ SecretId: secretId, SecretKey: secretKey });
  }

  async signedReadUrl(objectKey: string, expiresInSeconds = 7200): Promise<string> {
    const bucket = process.env.COS_BUCKET;
    const region = process.env.COS_REGION;
    if (!bucket || !region) throw new ServiceUnavailableException("COS 存储桶未配置");
    return new Promise((resolve, reject) => {
      this.client().getObjectUrl({
        Bucket: bucket, Region: region, Key: objectKey,
        Sign: true, Protocol: "https:", Expires: expiresInSeconds
      }, (error, data) => {
        if (error) reject(error);
        else if (data?.Url) resolve(data.Url);
        else reject(new Error("COS 未返回访问地址"));
      });
    });
  }

  async uploadImage(buffer: Buffer, mimeType: "image/jpeg" | "image/png" | "image/webp"): Promise<string> {
    const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/png" ? "png" : "webp";
    const key = `product-images/${randomBytes(16).toString("hex")}.${extension}`;
    const bucket = process.env.COS_BUCKET;
    const region = process.env.COS_REGION;
    if (!bucket || !region) throw new ServiceUnavailableException("COS 存储桶未配置");
    await new Promise<void>((resolve, reject) => {
      this.client().putObject({
        Bucket: bucket, Region: region, Key: key, Body: buffer,
        ContentType: mimeType
      }, (error) => error ? reject(error) : resolve());
    });
    return key;
  }
}
