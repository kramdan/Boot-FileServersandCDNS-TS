import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { json } from "node:stream/consumers";
import path from "node:path";
import { randomBytes } from "node:crypto";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const videoThumbnails: Map<string, Thumbnail> = new Map();

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail.data, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
}

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();
  const image = formData.get("thumbnail");
  if (!(image instanceof File)) {
    throw new BadRequestError("Not a file");
  }

  const MAX_UPLOAD_SIZE = 10 << 20;
  const mediaType = image.type;
  let extension = "";
  if (mediaType == "image/jpeg") {
    extension = mediaType.replace("image/", ".");
  } else if (mediaType == "image/png") {
    extension = mediaType.replace("image/", ".");
  } else {
    throw new BadRequestError("Incorrect file type");
  }
  
  const imageBuffer: ArrayBuffer = await image.arrayBuffer();
  const filename = `${randomBytes(32).toString("base64url")}${extension}`;
  console.log(filename);
  const mediaPath = path.join(cfg.assetsRoot, filename);
  await Bun.write(mediaPath, imageBuffer);
  const metaData = await getVideo(cfg.db, videoId);

  if (userID != metaData?.userID) {
    throw new UserForbiddenError("You may not upload a video that is not yours");
  }

  const thumbnail = `http://localhost:${cfg.port}/assets/${filename}`;
  const newVideo = {
    title: metaData.title,
    description: metaData.description,
    thumbnailURL: thumbnail,
    videoURL: metaData.videoURL,
    userID: metaData.userID,
    id: metaData.id,
    createdAt: metaData.createdAt,
    updatedAt: metaData.updatedAt,
  };
  await updateVideo(cfg.db, newVideo);
  const newMeta = await getVideo(cfg.db, newVideo.id);

  return respondWithJSON(200, newMeta);
}
