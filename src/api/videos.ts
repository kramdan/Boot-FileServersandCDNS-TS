import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { handlerGetThumbnail } from "./thumbnails";
import { handlerVideoGet } from "./video-meta";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { json } from "node:stream/consumers";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const maxUpload = 1 << 30 ;
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) { 
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading video", videoId, "by user", userID);
  const videoMeta = await getVideo(cfg.db, videoId);
  if (!videoMeta) {
    throw new NotFoundError("Video not found in database");
  }
  if (userID != videoMeta.userID){
    throw new UserForbiddenError("User cannot upload a video not their own");
  }
  const formData = await req.formData();
  const video = formData.get("video");
  if (!(video instanceof File)) {
    throw new BadRequestError("Not a file");
  }

  if (maxUpload < video.size) {
    throw new BadRequestError("File is too big");
  }
  if (video.type != "video/mp4") {
    throw new BadRequestError("File is not the proper type");
  }

  await Bun.write("/tmp/tempupload", video);
  const tempRatio = await getVideoAspectRatio("/tmp/tempupload");
  const fileKey = `${tempRatio}/${videoId}.mp4`;
  const processedFileKey = await processVideoForFastStart("/tmp/tempupload");
  const ref = cfg.s3Client.file(fileKey);
  await ref.write(Bun.file(processedFileKey), { type: "video/mp4"});
  await Bun.file("/tmp/tempupload").delete();
  await Bun.file("/tmp/tempupload.processed").delete();

  const newURL = `${cfg.s3CfDistribution}${fileKey}`;
  const Video: Video = {
    title: videoMeta.title,
    description: videoMeta.description,
    thumbnailURL: videoMeta.thumbnailURL,
    videoURL: newURL,
    userID: videoMeta.userID,
    id: videoMeta.id,
    updatedAt: videoMeta.updatedAt,
    createdAt: videoMeta.createdAt,
  }
  await updateVideo(cfg.db, Video);

  return respondWithJSON(200, await getVideo(cfg.db, Video.id));
}

export async function getVideoAspectRatio(filePath: string): Promise<string> {
  const getDim = Bun.spawn(["ffprobe",
                            "-v",
                            "error",
                            "-select_streams",
                            "v:0", "-show_entries",
                            "stream=width,height",
                            "-of",
                            "json",
                            filePath
                          ]);
  const stdoutText = await new Response(getDim.stdout).text();
  const stderrText = await new Response(getDim.stderr).text();
  if (await getDim.exited != 0) {
    throw new BadRequestError("Issue getting dimensions");
  }
  const jsonText = JSON.parse(stdoutText);
  if ((!jsonText.streams) || (!jsonText.streams[0])) {
    throw new BadRequestError("json does not have dimensions");
  }
  const width = jsonText.streams[0].width;
  const height = jsonText.streams[0].height;
  const horRatio = (16/9).toFixed(2);
  const verRatio = (9/16).toFixed(2);
  const videoRatio = (width/height).toFixed(2);
  let finalRatio = "";
  if (videoRatio == horRatio) {
    finalRatio = "landscape";
  } else if (videoRatio == verRatio) {
    finalRatio = "portrait";
  } else {
    finalRatio = "other";
  }
  return finalRatio;
}

export async function processVideoForFastStart(inputFilePath: string): Promise<string> {
  const newFilePath = `${inputFilePath}.processed`;
  const getData = Bun.spawn(["ffmpeg",
                            "-i",
                            inputFilePath,
                            "-movflags", "faststart",
                            "-map_metadata",
                            "0",
                            "-codec",
                            "copy",
                            "-f",
                            "mp4",
                            newFilePath
                          ]);
  const stdoutText = await new Response(getData.stdout).text();
  const stderrText = await new Response(getData.stderr).text();
  if (await getData.exited != 0) {
    throw new BadRequestError("Issue getting data");
  }
  return newFilePath;
}