export const SERVER_HTTP =
  process.env.NEXT_PUBLIC_SERVER_HTTP || "http://localhost:8080";
export const SERVER_WS =
  process.env.NEXT_PUBLIC_SERVER_WS || "ws://localhost:8080";
/** Single source for the GitHub repo — download links and clone snippets
 *  derive from this so a rename/transfer is a one-line change. */
export const GITHUB_REPO = "https://github.com/vikramarun/openchess";
