// Máy chủ trung gian cho trang GLM: giữ API key Z.ai để mọi người dùng chung mà không thấy key.
//
// An toàn:
// - Key nằm trong biến bí mật ZAI_API_KEY, NVIDIA_API_KEY, GROQ_API_KEY, GEMINI_API_KEY (nếu có) của Cloudflare, không có trong code.
// - Chỉ cho dùng mô hình miễn phí / có key riêng, nên kể cả bị lạm dụng cũng không mất tiền ngoài hạn mức key.
// - Chỉ trình duyệt mở từ các trang trong ALLOWED_ORIGINS mới gọi được (chặn trang web khác dùng ké).
// - Giới hạn số lượt hỏi mỗi phút cho mỗi địa chỉ IP.
//
// Các đường dẫn:
// - POST /        chat với GLM (Z.ai), NVIDIA, Groq (Forge X) hoặc Google AI Studio (Atlas 6 Medium/High/Omega).
// - POST /image   tạo ảnh bằng Cloudflare Workers AI (cần binding AI, xem README).
// - POST /sync    đồng bộ lịch sử chat giữa các máy (cần binding D1 tên DB, xem README).
// - POST /status  kiểm tra mô hình mạnh nào đang trả lời được (để menu chọn mô hình hiện trạng thái).

const UPSTREAM = "https://api.z.ai/api/paas/v4/chat/completions";
const FREE_MODELS = ["glm-4.7-flash", "glm-4.5-flash", "glm-4.6v-flash"];
const VISION_MODEL = "glm-4.6v-flash"; // mô hình miễn phí duy nhất của Z.ai đọc được ảnh
// Mô hình ở nhà cung cấp riêng (API kiểu OpenAI), mỗi cái cần một biến bí mật riêng. Thiếu key, quá tải hay lỗi
// thì máy chủ tự trả lời bằng GLM của Z.ai (Nova 4.7) và ghi lý do vào X-GLM-Note, nên trang không bao giờ bị lỗi.
// - Forge X = gpt-oss-120b trên Groq (GROQ_API_KEY, https://console.groq.com/keys).
// - Gemini 4 Hydrogen trên Google AI Studio (GEMINI_API_KEY, https://aistudio.google.com/apikey).
//   Trang tách thành 3 mô hình: Atlas 6 Medium / High / Omega = gemini-4-hydrogen với mức suy nghĩ medium / high / xhigh.
//   Thứ tự thử: biến GEMINI_MODEL (nếu có) → gemini-4-hydrogen → gemini-3.8-flash (chỉ khi id trước báo 404).
//   Id chạy được thì nhớ lại để lần sau gọi thẳng.
// Cấu hình chung của các mô hình Atlas 6 (gemini-4-hydrogen trên Google AI Studio); chỉ khác nhau ở mức suy nghĩ.
function atlas6(title, thinkingLevel) {
  return {
    title, key: "GEMINI_API_KEY", url: GEMINI_URL, maxTokens: 65536, vision: true, thinkingLevel,
    models: (env) => [...new Set([env.GEMINI_MODEL, "gemini-4-hydrogen", "gemini-3.8-flash"].filter(Boolean))],
    // Mặc định gọi API gốc của Google (streamGenerateContent), đúng như tài liệu gemini-4-hydrogen và như Google AI Studio.
    // Muốn thử lớp tương thích OpenAI thì đặt biến GEMINI_ENDPOINT=openai.
    native: (env) => env.GEMINI_ENDPOINT !== "openai",
    // Google yêu cầu BỎ temperature, top_p, top_k với gemini-4-hydrogen.
    noSampling: true,
    // Có thể suy nghĩ rất lâu: chờ chữ đầu tiên tối đa 30 phút, đang viết mà đứng yên 30 phút mới ngắt. longStream: trả lời trình duyệt
    // ngay và giữ kết nối trong lúc chờ (xem streamExternal). Quá hạn thì tạm bỏ qua 60 giây; quá tải 503 thì KHÔNG khoá.
    // Có thể đặt thêm GEMINI_API_KEY_2, GEMINI_API_KEY_3: key đang dùng hết lượt hay lỗi thì tự chuyển sang key kế tiếp.
    wait: 1_800_000, stall: 1_800_000, longStream: true, coolTimeout: 60_000, cool503: 0,
    // Gói miễn phí có hạn mức rất thấp: /status KHÔNG gọi thử (mỗi lần gọi thử tốn 1 lượt), trạng thái lấy từ câu hỏi thật gần nhất.
    passiveStatus: true,
    // gemini-4-hydrogen nhận low/medium/high/xhigh (không nhận minimal).
    nativeExtra: () => ({ thinkingLevel, includeThoughts: true }),
    // Id dự phòng (gemini-3.8-flash) không nhận mức đó thì để Google tự chọn mức mặc định.
    nativeRetry: () => ({ includeThoughts: true }),
    // Lớp tương thích OpenAI (chỉ khi GEMINI_ENDPOINT=openai): không được dùng reasoning_effort cùng thinking_config.
    extra: () => ({ extra_body: { google: { thinking_config: { thinking_level: thinkingLevel, include_thoughts: true } } } }),
    retry: () => ({ reasoning_effort: thinkingLevel === "medium" ? "medium" : "high" }),
    thoughtTags: true, // lớp OpenAI: suy nghĩ nằm trong <thought>…</thought> của content
  };
}
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"; // lớp tương thích OpenAI (chỉ dùng khi GEMINI_ENDPOINT=openai)
const GEMINI_NATIVE = "https://generativelanguage.googleapis.com/v1beta/models"; // API gốc: /{model}:streamGenerateContent?alt=sse (giống Google AI Studio)
const EXTERNAL_MODELS = {
  "gpt-oss-120b": {
    title: "gpt-oss-120b", key: "GROQ_API_KEY", url: GROQ_URL, maxTokens: 32768,
    models: () => ["openai/gpt-oss-120b"],
    // gpt-oss trên Groq: mức suy nghĩ low/medium/high; phần suy nghĩ trả về ở trường reasoning (trang đã đọc được).
    extra: (on, max) => ({ reasoning_effort: on ? (max ? "high" : "medium") : "low" }),
  },
  // Atlas 6 = gemini-4-hydrogen, tách 3 mô hình theo mức suy nghĩ CỐ ĐỊNH (không phụ thuộc chế độ Nhanh/Cân bằng/... trên trang):
  // Atlas 6 Medium → medium, Atlas 6 High → high, Atlas 6 Omega → xhigh. Cả 3 dùng chung key và hạn mức của Google.
  "gemini-4-hydrogen-medium": atlas6("Gemini 4 Hydrogen Medium", "medium"),
  "gemini-4-hydrogen-high": atlas6("Gemini 4 Hydrogen High", "high"),
  "gemini-4-hydrogen": atlas6("Gemini 4 Hydrogen", "xhigh"),
};
// Các mô hình miễn phí trên NVIDIA (build.nvidia.com, khoảng 40 lượt mỗi phút cho cả tài khoản), cần biến bí mật NVIDIA_API_KEY.
// Bản miễn phí của NVIDIA hay quá tải (xếp hàng nhiều phút, hoặc trả 200 mà không gửi gì): chỉ chờ chữ đầu tiên tối đa
// NVIDIA_WAIT, không được thì dùng GLM của Z.ai và tạm bỏ qua mô hình đó một lúc để các câu sau khỏi phải chờ lại.
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
// think: cách bật suy nghĩ của từng loại mô hình ("effort" = reasoning_effort, "kwargs" = chat_template_kwargs).
// trial: chỉ để kiểm tra xem có dùng được không (POST /status với {"all": true}), trang chưa hiện trong menu.
const NVIDIA_MODELS = {
  "glm-5.3-flash": { id: "z-ai/glm-5.3-flash", title: "GLM-5.3 Flash", vision: true, think: "effort" },
  "nemotron-3-ultra": { id: "nvidia/nemotron-3-ultra-550b-a55b", title: "Nemotron 3 Ultra", think: "kwargs" },
  "nemotron-3.5-super-vl": { id: "nvidia/nemotron-3.5-super-vl-120b-a12b", title: "Nemotron 3.5 Super VL", vision: true, think: "kwargs" },
  "nemotron-3.5-lightning": { id: "nvidia/nemotron-3.5-lightning-30b-a3b", title: "Nemotron 3.5 Lightning", think: "kwargs" },
  "mistral-large-4": { id: "mistralai/mistral-large-4-1t-a52b", title: "Mistral Large 4" },
  "minimax-m3.1-flash": { id: "minimaxai/minimax-m3.1-flash", title: "MiniMax M3.1 Flash" },
  "step-5": { id: "stepfun-ai/step-5-preview", title: "Step 5" },
  "nemotron-3-super": { id: "nvidia/nemotron-3-super-120b-a12b", title: "Nemotron 3 Super", think: "kwargs", trial: true },
  "nemotron-nano-3": { id: "nvidia/nemotron-nano-3-30b-a3b", title: "Nemotron Nano 3", think: "kwargs", trial: true },
  "llama-nemotron-ultra": { id: "nvidia/llama-3.1-nemotron-ultra-253b-v1", title: "Llama Nemotron Ultra", trial: true },
  "llama-3.2-90b-vision": { id: "meta/llama-3.2-90b-vision-instruct", title: "Llama 3.2 90B Vision", vision: true, trial: true },
  "kimi-k2.6": { id: "moonshotai/kimi-k2.6", title: "Kimi K2.6", trial: true },
  "gemma-4-31b": { id: "google/gemma-4-31b-it", title: "Gemma 4 31B", trial: true },
  "gemma-3-12b": { id: "google/gemma-3-12b-it", title: "Gemma 3 12B", trial: true },
  "palmyra-creative": { id: "writer/palmyra-creative-122b", title: "Palmyra Creative", trial: true },
  "laguna-xs": { id: "poolside/laguna-xs-2.1", title: "Laguna XS" },
};
const NVIDIA_WAIT = 25_000; // chờ chữ đầu tiên tối đa 25 giây
const HEADER_WAIT = 15_000; // nhà cung cấp riêng: mỗi lần gọi chờ phản hồi đầu (mã trạng thái) tối đa 15 giây
const STALL = 90_000; // đang trả lời mà đứng yên quá 90 giây thì ngắt, để trang tự nối lại
const nvidiaDown = new Map(); // mô hình -> { until, note }: tạm bỏ qua sau khi lỗi
const lastOutcome = new Map(); // mô hình -> kết quả câu hỏi thật gần nhất { ok, note, at } (dùng cho trạng thái không gọi thử)
const workingModel = new Map(); // mô hình ở nhà cung cấp riêng -> id thật đã chạy được (để lần sau gọi thẳng)
let statusCache = null; // kết quả kiểm tra các mô hình mạnh gần nhất
const MAX_IMAGES = 8;
const DEFAULT_ORIGINS = [
  "https://phuchello2811-web.github.io",
  "http://127.0.0.1:5500", // Live Server trong VS Code
  "http://localhost:5500",
];
const PER_MINUTE = 40; // số lượt gọi tối đa mỗi phút cho mỗi IP (một câu Nghĩ kỹ dùng nhiều lượt: 3 mô hình, mỗi lần chạy công cụ là một lượt)
const LIMITS = { chat: PER_MINUTE, image: 6, sync: 40, status: 10 }; // giới hạn mỗi phút theo từng loại yêu cầu
// Tạo ảnh: FLUX.2 [klein] 4B (đẹp, nhanh, sửa được ảnh có sẵn; khoảng 100 neuron mỗi ảnh 1024x1024,
// gói miễn phí 10.000 neuron mỗi ngày). Lỗi thì dùng FLUX.1 [schnell] (chỉ ảnh vuông, không sửa ảnh).
const IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const IMAGE_FALLBACK = "@cf/black-forest-labs/flux-1-schnell";
const MAX_REFS = 4; // số ảnh mẫu tối đa khi sửa ảnh (mỗi ảnh phải nhỏ hơn 512x512, trang tự thu nhỏ)
const SYNC_ROW_MAX = 1_900_000; // D1 giới hạn mỗi dòng khoảng 2MB
const MAX_BODY = 8 * 1024 * 1024; // đoạn chat (kể cả ảnh) nặng quá 8MB thì từ chối
// Độ dài trả lời tối đa: trang xin mức cao nhất, máy chủ hạ xuống mức mỗi mô hình cho phép (Z.ai báo đúng các mức này).
// Câu trả lời vẫn chạm giới hạn thì trang tự yêu cầu viết tiếp.
const MAX_TOKENS = 131072;
const MODEL_MAX_TOKENS = { "glm-4.7-flash": 131072, "glm-4.5-flash": 98304, "glm-4.6v-flash": 32768 };
const NVIDIA_MAX_TOKENS = 32768; // NVIDIA chê lớn quá thì thử lại với 16384
const BUSY = [429, 502, 503, 504, 524]; // mã lỗi khi Z.ai quá tải hoặc treo

// Đếm lượt trong bộ nhớ: mỗi máy chủ Cloudflare đếm riêng nên chỉ là chặn tương đối.
// Nếu có gắn binding Rate Limiting tên LIMITER (xem README) thì dùng cái đó, chính xác hơn.
const hits = new Map();
function overLimit(key, max) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > max;
}

export default {
  async fetch(request, env, ctx) {
    const origins = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()) : DEFAULT_ORIGINS;
    const origin = request.headers.get("Origin") || "";
    const allowed = origins.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : origins[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Access-Control-Expose-Headers": "X-GLM-Model, X-GLM-Note",
      Vary: "Origin",
    };
    const fail = (status, message) =>
      new Response(JSON.stringify({ error: { message } }), {
        status,
        headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
      });

    if (request.method === "OPTIONS") return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (request.method === "GET") return fail(200, "Máy chủ GLM đang chạy. Hãy dùng từ trang chat.");
    if (request.method !== "POST") return fail(405, "Chỉ nhận POST.");
    if (!allowed) return fail(403, "Trang này không được phép dùng máy chủ chung.");
    const route = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    const kind = { "/image": "image", "/sync": "sync", "/status": "status" }[route] || "chat";
    if (kind === "chat" && route !== "/") return fail(404, "Không có đường dẫn này.");
    if (kind === "chat" && !env.ZAI_API_KEY) return fail(500, "Máy chủ chưa được cài API key (biến bí mật ZAI_API_KEY).");

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const limited = env.LIMITER && kind === "chat" ? !(await env.LIMITER.limit({ key: ip })).success : overLimit(`${kind}:${ip}`, LIMITS[kind]);
    if (limited) return fail(429, kind === "chat"
      ? `Bạn hỏi quá ${PER_MINUTE} lần mỗi phút trên máy chủ chung. Đợi một lúc rồi thử lại.`
      : "Bạn gửi quá nhiều yêu cầu trong một phút. Đợi một lúc rồi thử lại.");

    const raw = await request.text();
    if (raw.length > MAX_BODY) return fail(413, "Dữ liệu gửi lên quá lớn.");
    let body;
    try { body = JSON.parse(raw); } catch { return fail(400, "Dữ liệu gửi lên không hợp lệ."); }
    const json = (data) => new Response(JSON.stringify(data), { headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

    if (kind === "image") return makeImage(body, env, json, fail);
    if (kind === "sync") return sync(body, env, json, fail);
    if (kind === "status") return json(await nvidiaStatus(env, body.all === true));

    if (!Array.isArray(body.messages) || !body.messages.length) return fail(400, "Thiếu tin nhắn.");

    // Chỉ chuyển tiếp các trường cần thiết, và ép về mô hình miễn phí.
    // Tin nhắn của người dùng có thể kèm ảnh (chỉ nhận ảnh dạng data:image/...;base64, không nhận đường dẫn tới web khác).
    const part = (p) =>
      p?.type === "text" && typeof p.text === "string" ? { type: "text", text: p.text }
      : p?.type === "image_url" && /^data:image\/(png|jpeg|webp|gif);base64,/.test(p.image_url?.url || "") ? { type: "image_url", image_url: { url: p.image_url.url } }
      : null;
    const messages = body.messages
      .filter((m) => m && ["system", "user", "assistant"].includes(m.role) && (typeof m.content === "string" || (m.role === "user" && Array.isArray(m.content))))
      .map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : m.content.map(part).filter(Boolean) }));
    const images = messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url").length : 0), 0);
    if (images > MAX_IMAGES) return fail(413, `Đoạn chat có quá ${MAX_IMAGES} ảnh. Hãy mở đoạn chat mới.`);
    const model = images ? VISION_MODEL : FREE_MODELS.includes(body.model) ? body.model : FREE_MODELS[0];
    const clean = {
      messages,
      stream: body.stream !== false,
      temperature: clamp(body.temperature, 0, 1, 0.6),
      top_p: clamp(body.top_p, 0.01, 1, 0.95),
      max_tokens: Math.round(clamp(body.max_tokens, 1, MAX_TOKENS, 16384)),
      thinking: { type: body.thinking?.type === "disabled" ? "disabled" : "enabled" },
      effort: body.effort === "max" ? "max" : body.effort === "medium" ? "medium" : "high", // Kỹ/Tối đa/Ultra: max; Cân bằng: medium; còn lại: high (Z.ai không nhận trường này, đã bỏ ở bước gửi)
      // Chế độ người dùng chọn trên trang (Nhanh, Cân bằng, Kỹ, Tối đa, Ultra): chỉ dùng nội bộ, không gửi sang nhà cung cấp.
      level: ["fast", "normal", "careful", "max", "ultra"].includes(body.level) ? body.level : undefined,
    };

    // Gemini 4 Hydrogen (Google) và Forge X (Groq) gọi nhà cung cấp riêng; các mô hình NVIDIA thử NVIDIA trước.
    // Câu hỏi có ảnh mà mô hình không đọc được ảnh thì dùng GLM-5.3 Flash.
    // Không dùng được thì trả lời bằng GLM của Z.ai và ghi lý do vào X-GLM-Note để trang hiện cho người dùng.
    let upstream, used, note = "", stream = null;
    const ext = EXTERNAL_MODELS[body.model];
    if (ext && (!images || ext.vision)) {
      const id = body.model, title = ext.title, down = nvidiaDown.get(id);
      // Mô hình suy nghĩ rất lâu: trả lời ngay bằng luồng có giữ kết nối, tự chuyển sang Z.ai trong luồng nếu lỗi.
      if (ext.longStream && clean.stream && keysOf(ext, env).length && !(down && down.until > Date.now()))
        return streamExternal(id, ext, clean, images, model, env, cors, ctx);
      if (!keysOf(ext, env).length) note = `${title} chưa được bật trên máy chủ (thiếu ${ext.key})`;
      else if (!clean.stream) note = `${title} chỉ dùng khi trả lời dạng luồng`;
      else if (down && down.until > Date.now()) note = `${title} ${down.note}; máy chủ sẽ thử lại sau ${Math.ceil((down.until - Date.now()) / 60_000)} phút`;
      else {
        const r = await callExternal(id, clean, env, ext.wait || NVIDIA_WAIT);
        if (r.body) { nvidiaDown.delete(id); lastOutcome.set(id, { ok: true, at: Date.now() }); used = id; stream = r.body; if (r.fallback) note = "bản dự phòng cùng hãng, vì bản chính đang quá tải"; else if (r.key > 1) note = `key ${r.key}, vì key 1 hết lượt hoặc đang lỗi`; }
        else { nvidiaDown.set(id, { until: Date.now() + r.cool, note: r.note }); lastOutcome.set(id, { ok: false, note: r.note, at: Date.now() }); note = `${title} ${r.note}`; }
      }
    }
    let nv = !used && NVIDIA_MODELS[body.model] ? body.model : !used && ext && images && !ext.vision ? "glm-5.3-flash" : null;
    if (nv && images && !NVIDIA_MODELS[nv].vision) nv = "glm-5.3-flash";
    if (nv) {
      const title = NVIDIA_MODELS[nv].title, down = nvidiaDown.get(nv);
      if (!env.NVIDIA_API_KEY) note = `${title} chưa được bật trên máy chủ (thiếu NVIDIA_API_KEY)`;
      else if (!clean.stream) note = `${title} chỉ dùng khi trả lời dạng luồng`;
      else if (down && down.until > Date.now()) note = `${title} ${down.note}; máy chủ sẽ thử lại sau ${Math.ceil((down.until - Date.now()) / 60_000)} phút`;
      else {
        const r = await callNvidia(nv, clean, env, NVIDIA_WAIT);
        if (r.body) { nvidiaDown.delete(nv); used = nv; stream = r.body; }
        else { nvidiaDown.set(nv, { until: Date.now() + r.cool, note: r.note }); note = `${title} ${r.note}`; }
      }
    }

    // Bản miễn phí hay bị quá tải (429) hoặc treo (502/503/504/524): thử lần lượt các mô hình miễn phí còn lại.
    // Z.ai từ chối ngẫu nhiên khoảng một nửa số lần khi đông (429, lỗi 1305) và trả lời lỗi rất nhanh, nên mô hình đầu tiên
    // được thử lại 2 lần (sau 1 rồi 2 giây) trước khi đổi sang mô hình khác. Lỗi treo (502/504/524) thì đổi mô hình ngay.
    if (!used) ({ res: upstream, used } = await callZai(clean, images, model, env));
    if (!stream && BUSY.includes(upstream.status)) return fail(429, "Máy chủ GLM miễn phí đang quá tải. Đợi một lúc rồi thử lại.");
    // Không trả nguyên lỗi xác thực của Z.ai về trình duyệt để khỏi lộ chi tiết về key.
    if (!stream && (upstream.status === 401 || upstream.status === 403)) return fail(502, "API key trên máy chủ chung bị sai hoặc đã bị thu hồi.");
    const headers = new Headers(cors);
    headers.set("Content-Type", stream ? "text/event-stream" : upstream.headers.get("Content-Type") || "application/json");
    headers.set("Cache-Control", "no-store");
    headers.set("X-GLM-Model", used); // mô hình thật đã trả lời, để trang ghi chú khi máy chủ tự đổi mô hình
    if (note) headers.set("X-GLM-Note", encodeURIComponent(note)); // header chỉ nhận chữ không dấu nên phải mã hoá
    return new Response(stream || upstream.body, { status: stream ? 200 : upstream.status, headers });
  },
};

// Gọi một mô hình trên NVIDIA. Thành công: { body } là luồng trả lời; thất bại: { note, cool } (lý do, thời gian tạm bỏ qua).
async function callNvidia(name, clean, env, wait) {
  const spec = NVIDIA_MODELS[name];
  const { thinking, effort, level, ...rest } = clean;
  const on = thinking.type !== "disabled";
  const think = spec.think === "effort" ? { reasoning_effort: on ? effort : "low" }
    : spec.think === "kwargs" ? { chat_template_kwargs: { enable_thinking: on, thinking: on } } : {};
  const timer = new AbortController(), t = setTimeout(() => timer.abort(), wait);
  const timeout = new Promise((_, no) => timer.signal.addEventListener("abort", () => no(new Error("timeout"))));
  timeout.catch(() => {});
  let reader;
  try {
    const send = (max_tokens) => Promise.race([fetch(NVIDIA_URL, {
      method: "POST",
      signal: timer.signal,
      // Thiếu Accept: text/event-stream thì NVIDIA giữ lại cả câu trả lời tới khi viết xong mới gửi (giống mã mẫu của NVIDIA).
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${env.NVIDIA_API_KEY}` },
      body: JSON.stringify({ ...rest, stream: true, model: spec.id, ...think, max_tokens }),
    }), timeout]);
    let res = await send(Math.min(rest.max_tokens, NVIDIA_MAX_TOKENS));
    // Một số mô hình có ngữ cảnh ngắn hơn: chê max_tokens quá lớn thì thử lại một lần với mức nhỏ hơn.
    if (res.status === 400) {
      const text = await res.text().catch(() => "");
      res = /max_tokens|context|too large|maximum/i.test(text) ? await send(16384) : new Response(text, { status: 400 });
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).replace(/nvapi-[\w-]+/g, "nvapi-…").replace(/\s+/g, " ").slice(0, 160);
      clearTimeout(t);
      if (res.status === 401 || res.status === 403) return { note: `bị từ chối (${res.status}): kiểm tra lại NVIDIA_API_KEY`, cool: 600_000 };
      if (res.status === 429) return { note: "hết lượt miễn phí trong phút này (429)", cool: 60_000 };
      if (res.status === 404 || res.status === 410) return { note: `không còn trên NVIDIA (${res.status})`, cool: 3_600_000, gone: true };
      return { note: `báo lỗi ${res.status}: ${detail}`, cool: 300_000 };
    }
    // NVIDIA đôi khi trả 200 rồi không gửi gì: đọc tới khi có dòng dữ liệu đầu tiên.
    reader = res.body.getReader();
    const chunks = [], dec = new TextDecoder();
    let text = "";
    while (!/data:\s*\{/.test(text)) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      chunks.push(value); text += dec.decode(value, { stream: true });
    }
    clearTimeout(t);
    if (!/data:\s*\{/.test(text)) return { note: "không trả về nội dung", cool: 300_000 };
    const body = new ReadableStream({
      start(c) { for (const ch of chunks) c.enqueue(ch); },
      async pull(c) {
        let stall;
        const r = await Promise.race([reader.read(), new Promise((ok) => { stall = setTimeout(() => ok(null), STALL); })]);
        clearTimeout(stall);
        if (!r) { reader.cancel().catch(() => {}); c.error(new Error("NVIDIA ngừng gửi dữ liệu")); }
        else if (r.done) c.close();
        else c.enqueue(r.value);
      },
      cancel() { reader.cancel().catch(() => {}); },
    });
    return { body };
  } catch {
    clearTimeout(t);
    reader?.cancel().catch(() => {});
    return timer.signal.aborted
      ? { note: `không trả lời sau ${wait / 1000} giây (đang quá đông)`, cool: 300_000 }
      : { note: "không kết nối được", cool: 120_000 };
  }
}

// Các key của một nhà cung cấp riêng: key chính rồi key dự phòng _2, _3 (chỉ những biến đã được đặt).
const keysOf = (spec, env) => [spec.key, `${spec.key}_2`, `${spec.key}_3`].filter((k) => env[k]);
// Key tạm hết lượt / bị từ chối: tên biến -> { until, why }. Hết lượt theo ngày thì nghỉ tới lúc Google đặt lại hạn mức (nửa đêm giờ Thái Bình Dương).
const keyDown = new Map();
const nextPacificMidnight = () => { const d = new Date(); d.setUTCHours(8, 0, 0, 0); if (d <= new Date()) d.setUTCDate(d.getUTCDate() + 1); return d.getTime(); };

// Gọi mô hình ở nhà cung cấp riêng (Groq, Google). Thành công: { body } là luồng trả lời; thất bại: { note, cool }.
// Thứ tự thử: từng id mô hình (bản chính rồi bản dự phòng) × từng key còn lượt. Key hết lượt (429), sai (401/403) hay đang quá tải (503)
// thì chuyển sang key kế tiếp; id không có (404) thì chuyển sang id kế tiếp. Chỉ chờ chữ đầu tiên tối đa `wait`.
// outer: tín hiệu huỷ từ bên ngoài (người dùng đóng trang) để khỏi chờ vô ích.
async function callExternal(id, clean, env, wait, outer) {
  const spec = EXTERNAL_MODELS[id];
  const { thinking, effort, level, ...rest } = clean;
  // Atlas 6: Gemini chỉ nhận đúng hội thoại, không kèm prompt hệ thống hay lời dặn sẵn.
  if (String(id).startsWith("gemini-4-hydrogen")) rest.messages = atlasRawMessages(rest.messages);
  const on = thinking?.type !== "disabled", max = effort === "max";
  const timer = new AbortController(), t = setTimeout(() => timer.abort(), wait);
  outer?.addEventListener("abort", () => timer.abort(), { once: true });
  const timeout = new Promise((_, no) => timer.signal.addEventListener("abort", () => no(new Error("timeout"))));
  timeout.catch(() => {});
  const tries = []; // nhật ký từng lần gọi, ghi vào lý do để dễ tìm lỗi
  let reader;
  try {
    const all = spec.models(env), good = workingModel.get(id);
    const candidates = good && all.includes(good) ? [good, ...all.filter((m) => m !== good)] : all;
    const keys = keysOf(spec, env);
    if (!keys.length) { clearTimeout(t); return { note: `chưa được bật trên máy chủ (thiếu ${spec.key})`, cool: 0 }; }
    const free = keys.filter((k) => !(keyDown.get(k)?.until > Date.now()));
    const keyOrder = free.length ? free : keys; // mọi key đều đang nghỉ thì vẫn thử lại (có thể đã hồi)
    const native = !!spec.native?.(env);
    const ex = native ? spec.nativeExtra : spec.extra, rx = native ? spec.nativeRetry : spec.retry;
    const { temperature, top_p, ...unsampled } = rest;
    const base = spec.noSampling ? unsampled : rest;
    let model = candidates[0], key = keyOrder[0];
    // Mỗi lần gọi chỉ chờ PHẢN HỒI ĐẦU (mã trạng thái) tối đa HEADER_WAIT: bình thường nhà cung cấp trả 200 ngay cả khi model còn
    // đang suy nghĩ, nên im lặng lâu nghĩa là kết nối bị kẹt; bỏ lần đó (coi như 504) để còn thời gian thử key, bản khác.
    const send = async (max_tokens, extra) => {
      const one = new AbortController(), stop = () => one.abort();
      timer.signal.addEventListener("abort", stop, { once: true });
      let hung = false;
      const h = setTimeout(() => { hung = true; one.abort(); }, HEADER_WAIT);
      try {
        return await (native
          ? fetch(`${GEMINI_NATIVE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
            method: "POST",
            signal: one.signal,
            headers: { "Content-Type": "application/json", Accept: "text/event-stream", "x-goog-api-key": env[key] },
            body: JSON.stringify(geminiBody(rest.messages, Math.min(max_tokens, spec.maxTokens), extra)),
          })
          : fetch(spec.url, {
            method: "POST",
            signal: one.signal,
            headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${env[key]}` },
            body: JSON.stringify({ ...base, stream: true, model, max_tokens: Math.min(max_tokens, spec.maxTokens), ...extra }),
          }));
      } catch (e) {
        if (hung && !timer.signal.aborted) return new Response("", { status: 504 });
        throw e;
      } finally {
        clearTimeout(h);
        timer.signal.removeEventListener("abort", stop);
      }
    };
    let res, onlyMissing = true, lastBody = "";
    const started = Date.now();
    const label = () => (model === candidates[0] ? "bản chính" : "bản dự phòng") + (keys.length > 1 ? ` key ${keys.indexOf(key) + 1}` : "");
    search: for (const m of candidates) {
      model = m;
      for (const k of keyOrder) {
        key = k;
        // Chỉ có một key: quá tải 503 thì chờ 1 giây thử lại một lần (nhiều key thì đổi key luôn, nhanh hơn).
        for (let attempt = 0; ; attempt++) {
          tries.push(`${label()}: đang chờ`);
          res = await send(rest.max_tokens, ex(on, max, level));
          tries[tries.length - 1] = `${label()}: ${res.status === 504 ? "không phản hồi" : res.status} sau ${Math.round((Date.now() - started) / 1000)} giây`;
          if (res.status !== 503 || keyOrder.length > 1 || attempt >= 1) break;
          await res.body?.cancel();
          await Promise.race([new Promise((ok) => setTimeout(ok, 1000)), timeout]);
        }
        if (res.ok || ![401, 403, 404, 429, 503, 504].includes(res.status)) break search;
        lastBody = await res.text().catch(() => "");
        if (res.status === 404) break; // id không có: key khác cũng vậy, sang id kế tiếp
        onlyMissing = false;
        if (res.status === 429) keyDown.set(k, { until: /per ?day|daily|PerDay/i.test(lastBody) ? nextPacificMidnight() : Date.now() + 65_000, why: "hết lượt" });
        if (res.status === 401 || res.status === 403) keyDown.set(k, { until: Date.now() + 3_600_000, why: "bị từ chối" });
      }
    }
    if (res.status === 400) {
      const text = await res.text().catch(() => "");
      res = /max_?tokens|maxOutputTokens|context|too large|maximum/i.test(text) ? await send(16384, ex(on, max, level))
        : rx && /thinking|reasoning|extra_body|unknown|invalid/i.test(text) ? await send(rest.max_tokens, rx(on, max, level))
        : new Response(text, { status: 400 });
    }
    if (!res.ok) {
      const detail = ((res.bodyUsed ? lastBody : await res.text().catch(() => "")) || lastBody).replace(/(gsk_|AIza)[\w-]+/g, "$1…").replace(/\s+/g, " ").slice(0, 160);
      clearTimeout(t);
      const log = ` (${tries.join("; ")})`;
      if (res.status === 401 || res.status === 403) return { note: `bị từ chối (${res.status}): kiểm tra lại ${keys.length > 1 ? "các key " + spec.key : spec.key}${log}`, cool: 600_000 };
      if (res.status === 429) return { note: `hết lượt miễn phí trên ${keys.length > 1 ? `cả ${keys.length} key` : "key"} (429)${log}`, cool: 60_000 };
      if (res.status === 503 || res.status === 504) return { note: `máy chủ gốc đang quá tải${log}`, cool: spec.cool503 ?? 30_000 };
      if (res.status === 404) return { note: `không tìm thấy mô hình trên máy chủ gốc (404, đã thử ${candidates.join(", ")})`, cool: 3_600_000 };
      return { note: `báo lỗi ${res.status}: ${detail}${log}`, cool: 300_000 };
    }
    keyDown.delete(key);
    reader = res.body.getReader();
    const chunks = [], dec = new TextDecoder();
    let text = "";
    while (!/data:\s*\{/.test(text)) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      chunks.push(value); text += dec.decode(value, { stream: true });
    }
    clearTimeout(t);
    if (!/data:\s*\{/.test(text)) return { note: `không trả về nội dung (${tries.join("; ")})`, cool: spec.coolTimeout || 300_000 };
    // Chỉ nhớ id dự phòng khi các id trước KHÔNG tồn tại (404); quá tải tạm thời thì lần sau vẫn thử id chính trước.
    if (onlyMissing) workingModel.set(id, model);
    const fallback = model !== candidates[0] && !onlyMissing;
    const body = new ReadableStream({
      start(c) { for (const ch of chunks) c.enqueue(ch); },
      async pull(c) {
        let stall;
        const r = await Promise.race([reader.read(), new Promise((ok) => { stall = setTimeout(() => ok(null), spec.stall || STALL); })]);
        clearTimeout(stall);
        if (!r) { reader.cancel().catch(() => {}); c.error(new Error(`${spec.title} ngừng gửi dữ liệu`)); }
        else if (r.done) c.close();
        else c.enqueue(r.value);
      },
      cancel() { reader.cancel().catch(() => {}); },
    });
    return { body: native ? body.pipeThrough(geminiToOpenAI()) : spec.thoughtTags ? body.pipeThrough(thoughtSplitter()) : body, fallback, key: keys.indexOf(key) + 1, keys: keys.length };
  } catch {
    clearTimeout(t);
    reader?.cancel().catch(() => {});
    const log = tries.length ? ` (${tries.join("; ")})` : "";
    if (outer?.aborted) return { note: "người dùng đã đóng trang", cool: 0 };
    return timer.signal.aborted
      ? { note: `chưa ra chữ đầu tiên sau ${Math.round(wait / 60_000) >= 2 ? Math.round(wait / 60_000) + " phút" : wait / 1000 + " giây"}${log}`, cool: spec.coolTimeout || 300_000 }
      : { note: `không kết nối được${log}`, cool: 120_000 };
  }
}

// Mô hình suy nghĩ rất lâu (Atlas 6 Omega, tới 30 phút): trả lời trình duyệt NGAY với một luồng, 15 giây gửi một dòng giữ kết nối
// (": keepalive <số giây>", trang bỏ qua nhưng biết máy chủ vẫn đang chờ), để kết nối không bị cắt vì im lặng quá lâu.
// Mô hình lỗi thì chuyển sang GLM của Z.ai ngay trong luồng đó, báo cho trang bằng một dòng data: {"astra_meta": {...}}.
function streamExternal(id, ext, clean, images, zaiModel, env, cors, ctx) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter(), enc = new TextEncoder(), dec = new TextDecoder(), started = Date.now();
  const gone = new AbortController();
  const put = (s) => gone.signal.aborted ? Promise.resolve()
    : w.write(typeof s === "string" ? enc.encode(s) : s).catch(() => gone.abort());
  const meta = (o) => put(`data: ${JSON.stringify({ astra_meta: o })}\n\n`);
  const ping = setInterval(() => put(`: keepalive ${Math.round((Date.now() - started) / 1000)}\n\n`), 15_000);
  // Chép luồng nguồn sang, chỉ cắt ở cuối dòng để dòng giữ kết nối không chen vào giữa một dòng dữ liệu.
  const pipe = async (src) => {
    const rd = src.getReader();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await rd.read();
        if (done) break;
        if (gone.signal.aborted) { rd.cancel().catch(() => {}); return; }
        buf += dec.decode(value, { stream: true });
        const cut = buf.lastIndexOf("\n") + 1;
        if (cut) { await put(buf.slice(0, cut)); buf = buf.slice(cut); }
      }
      if (buf) await put(buf + "\n");
    } finally { rd.releaseLock?.(); }
  };
  const run = (async () => {
    try {
      const r = await callExternal(id, clean, env, ext.wait || NVIDIA_WAIT, gone.signal);
      if (gone.signal.aborted) return;
      if (r.body) {
        nvidiaDown.delete(id); lastOutcome.set(id, { ok: true, at: Date.now() });
        if (r.fallback) await meta({ note: "bản dự phòng cùng hãng, vì bản chính đang quá tải" });
        else if (r.key > 1) await meta({ note: `key ${r.key}, vì key 1 hết lượt hoặc đang lỗi` });
        try { await pipe(r.body); }
        catch (e) { await meta({ error: `${ext.title} bị ngắt giữa chừng: ${String(e?.message || e).slice(0, 120)}` }); }
        return;
      }
      if (r.cool) nvidiaDown.set(id, { until: Date.now() + r.cool, note: r.note });
      lastOutcome.set(id, { ok: false, note: r.note, at: Date.now() });
      const z = await callZai(clean, images, zaiModel, env);
      await meta({ model: z.used, note: `${ext.title} ${r.note}` });
      if (z.res.ok && z.res.body) await pipe(z.res.body);
      else { await z.res.body?.cancel(); await meta({ error: BUSY.includes(z.res.status) ? "Máy chủ dự phòng cũng đang quá tải. Đợi một lúc rồi thử lại." : `Máy chủ dự phòng báo lỗi ${z.res.status}.` }); }
    } catch (e) {
      await meta({ error: "Máy chủ gặp lỗi: " + String(e?.message || e).slice(0, 160) });
    } finally {
      clearInterval(ping);
      if (!gone.signal.aborted) w.close().catch(() => {});
    }
  })();
  ctx?.waitUntil?.(run);
  const headers = new Headers(cors);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-store");
  headers.set("X-GLM-Model", id);
  headers.set("X-Astra-Stream", "1");
  return new Response(readable, { status: 200, headers });
}

// GLM của Z.ai, dùng khi mô hình khác không trả lời được. Bản miễn phí hay bị quá tải (429) hoặc treo (502/503/504/524):
// thử lần lượt các mô hình miễn phí; mô hình đầu tiên được thử lại 2 lần (sau 1 rồi 2 giây). Trả về { res, used }.
async function callZai(clean, images, model, env) {
  const order = images ? [model] : [model, ...FREE_MODELS.filter((x) => x !== model)];
  let res, used;
  for (const m of order) {
    for (let attempt = 0; attempt < (m === order[0] ? 3 : 1); attempt++) {
      if (res) await res.body?.cancel();
      if (attempt) await new Promise((ok) => setTimeout(ok, 1000 * attempt));
      used = m;
      res = await fetch(UPSTREAM, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.ZAI_API_KEY}` },
        body: JSON.stringify({ ...clean, effort: undefined, level: undefined, model: m, max_tokens: Math.min(clean.max_tokens, MODEL_MAX_TOKENS[m] || 32768) }),
      });
      if (res.status !== 429 && res.status !== 503) break;
    }
    if (!BUSY.includes(res.status)) break;
  }
  return { res, used };
}

// Atlas 6: không gửi systemInstruction hay lời dặn sẵn. Gemini chỉ nhận đúng hội thoại (user/assistant).
function atlasRawMessages(messages) {
  const strip = (s) => (typeof s === "string" ? s.replace(/\n\n\(Yêu cầu thêm:[\s\S]*\)$/, "") : s);
  const out = [];
  for (const m of messages || []) {
    if (!m || m.role === "system") continue;
    if (m.role === "user" && typeof m.content === "string") out.push({ ...m, content: strip(m.content) });
    else if (m.role === "user" && Array.isArray(m.content)) {
      out.push({
        ...m,
        content: m.content.map((part, i) => (i === 0 && part?.type === "text" && typeof part.text === "string" ? { ...part, text: strip(part.text) } : part)),
      });
    } else out.push(m);
  }
  return out.length ? out : [{ role: "user", content: "" }];
}

// Đổi tin nhắn kiểu OpenAI sang yêu cầu streamGenerateContent của Google: system → systemInstruction, assistant → model,
// ảnh data URL → inlineData; tin nhắn liền nhau cùng vai được gộp lại.
function geminiBody(messages, maxOutputTokens, thinkingConfig) {
  const system = [], contents = [];
  for (const m of messages) {
    const parts = typeof m.content === "string" ? (m.content ? [{ text: m.content }] : [])
      : m.content.map((p) => {
        if (p.type === "text") return p.text ? { text: p.text } : null;
        const [head, data] = p.image_url.url.split(",");
        return { inlineData: { mimeType: head.slice(5, head.indexOf(";")), data } };
      }).filter(Boolean);
    if (m.role === "system") { for (const p of parts) if (p.text) system.push(p.text); continue; }
    if (!parts.length) continue;
    const role = m.role === "assistant" ? "model" : "user";
    if (contents.at(-1)?.role === role) contents.at(-1).parts.push(...parts);
    else contents.push({ role, parts });
  }
  if (!contents.length || contents[0].role !== "user") contents.unshift({ role: "user", parts: [{ text: "(bắt đầu)" }] });
  return {
    contents,
    ...(system.length ? { systemInstruction: { parts: [{ text: system.join("\n\n") }] } } : {}),
    generationConfig: { maxOutputTokens, thinkingConfig },
  };
}

// Đổi luồng SSE của streamGenerateContent sang định dạng chat/completions mà trang đang đọc:
// phần có thought: true → delta.reasoning_content, còn lại → delta.content; MAX_TOKENS → finish_reason "length" (trang tự viết tiếp).
function geminiToOpenAI() {
  const enc = new TextEncoder(), dec = new TextDecoder();
  let pending = "";
  const conv = (raw) => {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("data:")) return "";
    let j;
    try { j = JSON.parse(line.slice(5)); } catch { return ""; }
    if (j.error) return `data: ${JSON.stringify({ error: j.error })}\n\n`;
    const c = j.candidates?.[0];
    let content = "", reasoning = "";
    for (const p of c?.content?.parts || []) if (typeof p.text === "string") { if (p.thought) reasoning += p.text; else content += p.text; }
    const fr = c?.finishReason;
    const finish = !fr || fr === "FINISH_REASON_UNSPECIFIED" ? null : fr === "MAX_TOKENS" ? "length" : "stop";
    if (!content && !reasoning && !finish) return "";
    const delta = {};
    if (reasoning) delta.reasoning_content = reasoning;
    if (content) delta.content = content;
    return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  };
  return new TransformStream({
    transform(chunk, c) {
      pending += dec.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop();
      const out = lines.map(conv).join("");
      if (out) c.enqueue(enc.encode(out));
    },
    flush(c) {
      const out = (pending ? conv(pending) : "") + "data: [DONE]\n\n";
      c.enqueue(enc.encode(out));
    },
  });
}

function thoughtSplitter() {
  const enc = new TextEncoder(), dec = new TextDecoder();
  let inThought = false, carry = "", pending = "";
  const fix = (line) => {
    if (!line.startsWith("data:")) return line;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return line;
    let j;
    try { j = JSON.parse(data); } catch { return line; }
    const d = j.choices?.[0]?.delta;
    if (!d || typeof d.content !== "string") return line;
    if (d.extra_content?.google?.thought === true) {
      d.reasoning_content = (d.reasoning_content || "") + d.content; d.content = "";
      return "data: " + JSON.stringify(j);
    }
    let text = carry + d.content, out = "", think = "";
    carry = "";
    while (text) {
      const tag = inThought ? "</thought>" : "<thought>", at = text.indexOf(tag);
      if (at >= 0) {
        if (inThought) think += text.slice(0, at); else out += text.slice(0, at);
        text = text.slice(at + tag.length); inThought = !inThought;
        continue;
      }
      // Giữ lại đoạn cuối có thể là nửa đầu của thẻ, ghép với gói sau.
      let keep = 0;
      for (let k = Math.min(tag.length - 1, text.length); k > 0; k--) if (tag.startsWith(text.slice(-k))) { keep = k; break; }
      const part = text.slice(0, text.length - keep);
      if (inThought) think += part; else out += part;
      carry = text.slice(text.length - keep); text = "";
    }
    d.content = out;
    if (think) d.reasoning_content = (d.reasoning_content || "") + think;
    return "data: " + JSON.stringify(j);
  };
  return new TransformStream({
    transform(chunk, c) {
      pending += dec.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop();
      if (lines.length) c.enqueue(enc.encode(lines.map(fix).join("\n") + "\n"));
    },
    flush(c) {
      if (pending) c.enqueue(enc.encode(fix(pending) + "\n"));
      if (carry) c.enqueue(enc.encode("data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: carry } }] }) + "\n\n"));
    },
  });
}

// Kiểm tra nhanh từng mô hình mạnh (lưu kết quả 2 phút). Mô hình ở nhà cung cấp riêng (Groq, Google) kiểm tra riêng; NVIDIA như cũ.
// Mô hình đang bị tạm bỏ qua thì báo luôn, không gọi lại. all = kiểm tra cả các mô hình thử (trial).
async function nvidiaStatus(env, all) {
  const cache = statusCache?.[all ? "all" : "menu"];
  if (cache && Date.now() - cache.at < 120_000) return cache.data;
  const probe = { messages: [{ role: "user", content: "Hi" }], stream: true, temperature: 0.6, top_p: 0.95, max_tokens: 16, thinking: { type: "enabled" }, effort: "high" };
  const models = {};
  // Groq (Forge X) và Google (Gemini 4 Hydrogen): chạy song song với NVIDIA.
  const external = Object.keys(EXTERNAL_MODELS).map(async (id) => {
    const spec = EXTERNAL_MODELS[id];
    const keys = keysOf(spec, env);
    if (!keys.length) { models[id] = { ok: false, note: `chưa gắn ${spec.key}` }; return; }
    const usable = keys.filter((k) => !(keyDown.get(k)?.until > Date.now())).length;
    const down = nvidiaDown.get(id);
    if (down && down.until > Date.now()) { models[id] = { ok: false, note: down.note }; return; }
    if (spec.passiveStatus) {
      // Theo kết quả câu hỏi thật gần nhất (trong 5 phút); chưa có thông tin thì coi như sẵn sàng.
      const last = lastOutcome.get(id);
      models[id] = last && !last.ok && Date.now() - last.at < 300_000 ? { ok: false, note: last.note }
        : !usable ? { ok: false, note: `hết lượt miễn phí trên ${keys.length > 1 ? `cả ${keys.length} key` : "key"} (429)` }
        : { ok: true, passive: true, ...(keys.length > 1 ? { note: `${usable}/${keys.length} key còn lượt` } : {}) };
      return;
    }
    const start = Date.now();
    const r = await callExternal(id, { ...probe, thinking: { type: "disabled" } }, env, spec.wait ? 45_000 : 20_000);
    if (r.body) { r.body.cancel().catch(() => {}); nvidiaDown.delete(id); models[id] = { ok: true, ms: Date.now() - start }; }
    else { nvidiaDown.set(id, { until: Date.now() + r.cool, note: r.note }); models[id] = { ok: false, note: r.note }; }
  });
  // NVIDIA
  if (env.NVIDIA_API_KEY) {
    await Promise.all(Object.keys(NVIDIA_MODELS).filter((n) => all || !NVIDIA_MODELS[n].trial).map(async (name) => {
      const down = nvidiaDown.get(name);
      if (down && down.until > Date.now()) { models[name] = { ok: false, note: down.note, gone: down.gone }; return; }
      const start = Date.now();
      const r = await callNvidia(name, probe, env, 20_000);
      if (r.body) { r.body.cancel().catch(() => {}); nvidiaDown.delete(name); models[name] = { ok: true, ms: Date.now() - start }; }
      else { nvidiaDown.set(name, { until: Date.now() + r.cool, note: r.note, gone: r.gone }); models[name] = { ok: false, note: r.note, gone: r.gone }; }
    }));
  }
  await Promise.all(external);
  const enabled = !!(env.NVIDIA_API_KEY || Object.values(EXTERNAL_MODELS).some((s) => keysOf(s, env).length));
  statusCache = { ...statusCache, [all ? "all" : "menu"]: { at: Date.now(), data: { enabled, models } } };
  return statusCache[all ? "all" : "menu"].data;
}

// Tạo ảnh hoặc sửa ảnh. Trang gửi: prompt, width/height (256–1920), seed, refs (ảnh mẫu dạng data:image/...;base64).
async function makeImage(body, env, json, fail) {
  if (!env.AI) return fail(501, "Máy chủ chưa bật tạo ảnh (binding AI).");
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 2000) : "";
  if (!prompt) return fail(400, "Thiếu mô tả ảnh.");
  // Kích thước làm tròn tới bội số của 16 cho mô hình dễ xử lý.
  const side = (v) => Math.round(clamp(v, 256, 1920, 1024) / 16) * 16;
  const width = side(body.width), height = side(body.height);
  const seed = Number.isInteger(body.seed) && body.seed >= 0 ? body.seed : Math.floor(Math.random() * 2 ** 31);
  const refs = (Array.isArray(body.refs) ? body.refs : [])
    .filter((u) => typeof u === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(u) && u.length < 1_500_000)
    .slice(0, MAX_REFS);
  const done = (out, model) => {
    const b64 = out?.image;
    if (!b64) return null;
    // FLUX trả PNG hoặc JPEG tuỳ mô hình: nhận dạng theo mấy byte đầu.
    const mime = b64.startsWith("/9j/") ? "image/jpeg" : b64.startsWith("UklG") ? "image/webp" : "image/png";
    return json({ image: `data:${mime};base64,${b64}`, model, width, height, seed });
  };
  let err;
  try {
    // Mô hình FLUX.2 nhận dữ liệu dạng multipart, kể cả khi chỉ có prompt.
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("width", String(width));
    form.append("height", String(height));
    form.append("seed", String(seed));
    refs.forEach((u, i) => {
      const [head, data] = u.split(",");
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      form.append(`input_image_${i}`, new Blob([bytes], { type: head.slice(5, head.indexOf(";")) }), `image${i}`);
    });
    const packed = new Response(form);
    const out = await env.AI.run(IMAGE_MODEL, { multipart: { body: packed.body, contentType: packed.headers.get("content-type") } });
    const res = done(out, "FLUX.2 klein");
    if (res) return res;
  } catch (e) { err = e; }
  if (refs.length) return imageFail(err, fail); // FLUX.1 không sửa được ảnh, nên không dùng làm dự phòng
  try {
    const res = done(await env.AI.run(IMAGE_FALLBACK, { prompt, steps: 8 }), "FLUX.1 schnell");
    if (res) return res;
  } catch (e) { err = e; }
  return imageFail(err, fail);
}
function imageFail(e, fail) {
  const msg = String(e?.message || e || "không có ảnh trả về");
  if (/limit|quota|neuron|exceeded|4006/i.test(msg)) return fail(429, "Hôm nay máy chủ đã hết lượt tạo ảnh miễn phí. Thử lại vào ngày mai.");
  if (/nsfw|safety|flagged|moderat/i.test(msg)) return fail(400, "Mô tả ảnh bị bộ lọc an toàn chặn. Hãy đổi mô tả khác.");
  return fail(502, "Không tạo được ảnh: " + msg.slice(0, 200));
}

// Đồng bộ: mỗi người có một mã bí mật; máy chủ chỉ lưu mã đã băm (SHA-256), không lưu mã thật.
// Mỗi mục (một đoạn chat, bộ nhớ, nhân vật…) là một dòng có thời điểm cập nhật; bản mới hơn thắng.
// Máy gửi lên các mục đã đổi kèm mốc lần đồng bộ trước, máy chủ trả về các mục đã đổi kể từ mốc đó.
async function sync(body, env, json, fail) {
  if (!env.DB) return fail(501, "Máy chủ chưa bật đồng bộ (binding D1 tên DB).");
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!/^[A-Za-z0-9-]{16,64}$/.test(code)) return fail(400, "Mã đồng bộ không hợp lệ.");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("glm-sync:" + code));
  const user = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS items (user TEXT NOT NULL, id TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT, seen INTEGER NOT NULL, PRIMARY KEY (user, id))").run();

  const now = Date.now();
  const changes = Array.isArray(body.changes) ? body.changes.slice(0, 200) : [];
  const writes = [];
  for (const c of changes) {
    if (typeof c?.id !== "string" || c.id.length > 100 || !Number.isFinite(c.updated)) continue;
    const data = c.data === null ? null : JSON.stringify(c.data);
    if (data && data.length > SYNC_ROW_MAX) continue;
    // Chỉ ghi đè khi bản gửi lên mới hơn bản đang lưu. "seen" là lúc máy chủ nhận, dùng để biết máy khác cần tải gì.
    writes.push(env.DB.prepare(
      "INSERT INTO items (user, id, updated, data, seen) VALUES (?1, ?2, ?3, ?4, ?5) " +
      "ON CONFLICT (user, id) DO UPDATE SET updated = excluded.updated, data = excluded.data, seen = excluded.seen WHERE excluded.updated > items.updated",
    ).bind(user, c.id, Math.round(c.updated), data, now));
  }
  if (writes.length) await env.DB.batch(writes);
  const since = Number.isFinite(body.since) ? body.since : 0;
  const { results } = await env.DB.prepare("SELECT id, updated, data FROM items WHERE user = ?1 AND seen > ?2").bind(user, since).all();
  return json({ now, items: results.map((r) => ({ id: r.id, updated: r.updated, data: r.data === null ? null : JSON.parse(r.data) })) });
}

function clamp(v, lo, hi, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}
