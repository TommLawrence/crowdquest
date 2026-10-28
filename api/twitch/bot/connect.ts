import type { ServerResponse } from "node:http";
import type { ApiRequest } from "../../_lib/http.js";
import { startOAuth } from "../../_lib/oauth.js";

export default async function handler(request: ApiRequest, response: ServerResponse): Promise<void> {
  await startOAuth(request, response, "chatReader");
}
