import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express 4 does not catch rejected promises from async route handlers.
 * Wrap them so every failure reaches the central JSON error handler instead
 * of becoming an unhandled rejection that can take the process down.
 */
export function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}
