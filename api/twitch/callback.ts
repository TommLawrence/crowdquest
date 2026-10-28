import type { ServerResponse } from "node:http";
import type { ApiRequest } from "../_lib/http.js";
import { finishOAuth } from "../_lib/oauth.js";

export default async function handler(request: ApiRequest, response: ServerResponse): Promise<void> {
  await finishOAuth(request, response, "broadcaster");
}
