export { escapeHTML } from "@quartz-community/utils"

// @quartz-community/utils decodes "&amp;" first, so "&amp;lt;" turns into "<" instead of
// "&lt;" (double unescaping). Decode it last.
export const unescapeHTML = (html: string) => {
  return html
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&amp;", "&")
}
