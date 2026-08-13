import crypto from "node:crypto";

// Minimal WeChat Official-Account message plumbing for the callback endpoint.
// Pure functions (signature / XML) so they can be unit-tested without WeChat.

/** WeChat server signature: sha1 of sorted [token, timestamp, nonce]. */
export function checkSignature(signature: string, timestamp: string, nonce: string, token: string): boolean {
  if (!token || !signature) return false;
  const s = [token, timestamp, nonce].sort().join("");
  const hash = crypto.createHash("sha1").update(s).digest("hex");
  const a = Buffer.from(hash), b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tag(xml: string, name: string): string {
  const re = new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`);
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

export interface WxMsg { from: string; to: string; type: string; event: string; content: string; }

/** Parse an inbound WeChat message XML into the fields we care about. */
export function parseXml(xml: string): WxMsg {
  return {
    from: tag(xml, "FromUserName"),
    to: tag(xml, "ToUserName"),
    type: tag(xml, "MsgType").toLowerCase(),
    event: tag(xml, "Event").toLowerCase(),
    content: tag(xml, "Content"),
  };
}

const cdata = (s: string) => `<![CDATA[${s}]]>`;

/** Build a passive text reply XML (swaps to/from). */
export function textReplyXml(toUser: string, fromUser: string, content: string): string {
  return `<xml><ToUserName>${cdata(toUser)}</ToUserName><FromUserName>${cdata(fromUser)}</FromUserName>`
    + `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType>${cdata("text")}</MsgType>`
    + `<Content>${cdata(content)}</Content></xml>`;
}

/** Does this inbound message express intent to vote? (keyword or subscribe/menu event) */
export function wantsVote(m: WxMsg): boolean {
  if (m.type === "text") return /投票|投|vote/i.test(m.content);
  if (m.type === "event") return m.event === "subscribe" || m.event === "click" || m.event === "scan";
  return false;
}
