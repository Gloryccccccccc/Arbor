import { ArborError } from "../errors.js";

export function modelEndpoint(baseUrl: string, resource: "chat/completions" | "responses"): string {
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { throw new ArborError("configuration", "Specify a valid model API base URL."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new ArborError("configuration", "The model endpoint must use HTTPS (HTTP is allowed on loopback only), without credentials or query parameters.");
  }
  const base = url.toString().replace(/\/+$/, "");
  return base.endsWith("/" + resource) ? base : base + "/" + resource;
}
