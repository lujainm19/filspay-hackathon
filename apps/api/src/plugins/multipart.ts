import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Config } from "../config.js";

export interface MultipartPluginOptions {
  config: Pick<Config, "kycMaxFileSizeBytes">;
}

/** Registers @fastify/multipart size-limited to `config.kycMaxFileSizeBytes`
 *  — oversized uploads are rejected by the plugin before any handler runs,
 *  never buffered in full. */
// S17 fix: only the size of each file was limited, not how many files or
// fields a request could carry. The KYC route reads every file part into
// memory, so one request with hundreds of 8 MB parts could exhaust the 512 MB
// container. One file and a handful of small fields is all KYC upload needs.
export const multipartPlugin = fp<MultipartPluginOptions>(async (app: FastifyInstance, opts): Promise<void> => {
  await app.register(multipart, {
    limits: { fileSize: opts.config.kycMaxFileSizeBytes, files: 1, fields: 10, fieldSize: 1024 },
  });
});
