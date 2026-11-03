import { Injectable, NestMiddleware } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";

@Injectable()
export class DevFailureMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    if (
      process.env.NODE_ENV === "production" ||
      process.env.FAILURE_INJECTION_ENABLED !== "true" ||
      request.method !== "POST" ||
      request.path !== "/api/v1/reports"
    ) {
      next();
      return;
    }

    const scenario = request.header("x-dev-failure");
    if (scenario === "after-commit-drop") {
      next();
      return;
    }
    if (scenario === "latency") {
      const requested = Number(
        process.env.FAILURE_INJECTION_LATENCY_MS ?? 3000
      );
      const delay = Number.isFinite(requested)
        ? Math.min(Math.max(requested, 0), 30000)
        : 3000;
      setTimeout(next, delay);
      return;
    }
    if (scenario === "refuse") {
      response.status(503).json({ message: "Development upload refusal." });
      return;
    }
    if (scenario === "drop") {
      response.socket?.destroy();
      return;
    }
    if (scenario === "hang") {
      response.once("close", () => undefined);
      return;
    }
    next();
  }
}
