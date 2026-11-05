import { AsyncLocalStorage } from "node:async_hooks";

// Per-request context: carries the signed-in user's GitHub token into the tool handlers.
export const als = new AsyncLocalStorage();
export const currentToken = () => als.getStore()?.token;
