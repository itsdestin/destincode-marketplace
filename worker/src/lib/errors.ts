import { HTTPException } from "hono/http-exception";

export const badRequest = (msg: string) => new HTTPException(400, { message: msg });
export const unauthorized = (msg = "not authenticated") => new HTTPException(401, { message: msg });
export const forbidden = (msg = "forbidden") => new HTTPException(403, { message: msg });
export const notFound = (msg = "not found") => new HTTPException(404, { message: msg });
export const conflict = (msg: string) => new HTTPException(409, { message: msg });
export const tooMany = (msg = "too many requests") => new HTTPException(429, { message: msg });
