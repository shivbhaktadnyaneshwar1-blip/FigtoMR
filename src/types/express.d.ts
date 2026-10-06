declare module 'express' {
  import type { IncomingMessage, ServerResponse, Server } from 'node:http';

  export interface Request extends IncomingMessage {
    body: unknown;
    path: string;
    params: Record<string, string>;
    query: Record<string, unknown>;
  }

  export interface Response extends ServerResponse {
    status(code: number): Response;
    json(body: unknown): Response;
    sendStatus(code: number): Response;
    type(type: string): Response;
    send(body: string): Response;
    sendFile(path: string, callback?: (err?: Error) => void): void;
    setHeader(name: string, value: string | number | readonly string[]): this;
    flushHeaders?: () => void;
  }

  export type NextFunction = (err?: unknown) => void;
  export type RequestHandler = (req: Request, res: Response, next: NextFunction) => void;

  export interface Express {
    use(...handlers: Array<RequestHandler | string>): Express;
    get(path: string, ...handlers: RequestHandler[]): Express;
    post(path: string, ...handlers: RequestHandler[]): Express;
    listen(
      port: number,
      host: string,
      callback?: () => void,
    ): Server;
    listen(port: number, callback?: () => void): Server;
  }

  interface ExpressStatic {
    (root: string): RequestHandler;
    json(options?: { limit?: string }): RequestHandler;
  }

  interface ExpressCallable {
    (): Express;
    static: ExpressStatic;
    json(options?: { limit?: string }): RequestHandler;
  }

  const express: ExpressCallable;
  export default express;
}
