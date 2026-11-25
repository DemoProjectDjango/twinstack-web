// Imported first by every test: dummy settings (config.js needs them; nothing here is real) and one
// local mock of the three providers, which the server's modules are pointed at before they load.
import http from "node:http";

/** Per test: { claude, deepseek, openai } handlers `(body, req, res)`, and every request each got. */
export const mock = { handlers: {}, calls: { claude: [], deepseek: [], openai: [] } };

export function resetMock() {
  mock.handlers = {};
  for (const list of Object.values(mock.calls)) list.length = 0;
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  const body = text ? JSON.parse(text) : null;
  const provider = req.url.startsWith("/anthropic") ? "claude" : req.url.startsWith("/deepseek") ? "deepseek" : "openai";
  if (req.url.includes("/count_tokens")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ input_tokens: 10 }));
  }
  mock.calls[provider].push({ body, headers: req.headers });
  const handler = mock.handlers[provider];
  if (!handler) {
    res.writeHead(500, { "content-type": "application/json" });
    return res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `no ${provider} handler` } }));
  }
  await handler(body, req, res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
const base = `http://127.0.0.1:${server.address().port}`;

Object.assign(process.env, {
  GITHUB_CLIENT_ID: "test",
  GITHUB_CLIENT_SECRET: "test",
  JWT_SECRET: "test-secret",
  MONGODB_URI: "mongodb://127.0.0.1:1/twinstack-test",
  DATA_ENCRYPTION_KEY: "0".repeat(64),
  PLATFORM_ANTHROPIC_KEY: "test-claude-key",
  DEEPSEEK_API_KEY: "test-deepseek-key",
  OPENAI_API_KEY: "test-openai-key",
  ADMIN_EMAILS: "",
  ANTHROPIC_BASE_URL: `${base}/anthropic`,
  DEEPSEEK_BASE_URL: `${base}/deepseek`,
  OPENAI_BASE_URL: `${base}/openai`,
});
delete process.env.FAST_PAGE_MODEL;
delete process.env.ASSISTANT_MODEL;

/* ------------------------------------------------------------ replies */

export function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export const anthropicError = (type, message) => ({ type: "error", error: { type, message } });

/** A whole streamed Claude-format reply saying `text`, from `model`. */
export function streamReply(res, model, text = "Hello") {
  const sse = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(sse({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } }));
  res.write(sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  res.write(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
  res.write(sse({ type: "content_block_stop", index: 0 }));
  res.write(sse({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }));
  res.end(sse({ type: "message_stop" }));
}

/** A finished OpenAI Responses reply saying `text`. */
export function openAIReply(res, model, text = "Hello") {
  json(res, 200, {
    id: "resp_1",
    model,
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 12, output_tokens: 3 },
  });
}
