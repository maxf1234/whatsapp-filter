import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { ZodError } from "zod";
import { env } from "./lib/env.ts";
import { HttpError } from "./lib/errors.ts";
import { redact } from "./lib/logging.ts";
import { authRoutes } from "./routes/auth.ts";
import { linkRoutes } from "./routes/link.ts";
import { ruleRoutes } from "./routes/rules.ts";
import { activityRoutes } from "./routes/activity.ts";
import type { SessionManager } from "./worker/sessionManager.ts";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildApp(opts: { manager?: SessionManager } = {}) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // Request bodies here carry emails and phone numbers, so the serialiser is
      // narrowed rather than left at Fastify's default.
      serializers: {
        req: (r) => ({ method: r.method, url: r.url }),
        err: (e) => ({
          ...(redact({ message: e.message }) as { message: string }),
          type: e.name,
          stack: e.stack ?? "",
        }),
      },
    },
    trustProxy: true,
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpError) {
      reply.code(error.status).send({ error: error.code, message: error.message });
      return;
    }
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: "bad_request",
        message: "request body failed validation",
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    if ((error as { statusCode?: number }).statusCode === 400) {
      reply.code(400).send({
        error: "bad_request",
        message: error instanceof Error ? error.message : "bad request",
      });
      return;
    }
    request.log.error({ err: error }, "unhandled error");
    reply.code(500).send({ error: "internal", message: "something went wrong" });
  });

  app.get("/healthz", async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(linkRoutes, opts);
  await app.register(ruleRoutes, opts);
  await app.register(activityRoutes);

  // The landing page and dashboard ship inside this service: one deploy, one
  // origin, and no CORS to configure for a product whose whole surface is
  // "sign up, pair, pick countries".
  const webRoot = env.webRoot || resolve(here, "../../web");
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, index: ["index.html"] });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/v1/")) {
        reply.code(404).send({ error: "not_found", message: "no such route" });
        return;
      }
      reply.sendFile("index.html");
    });
  }

  return app;
}
