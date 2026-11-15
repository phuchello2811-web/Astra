// Máy chủ trung gian cho trang GLM: giữ API key Z.ai để mọi người dùng chung mà không thấy key.
//
// An toàn:
// - Key nằm trong biến bí mật ZAI_API_KEY (và NVIDIA_API_KEY nếu có) của Cloudflare, không có trong code.
// - Chỉ cho dùng mô hình miễn phí, nên kể cả bị lạm dụng cũng không mất tiền.
// - Chỉ trình duyệt mở từ các trang trong ALLOWED_ORIGINS mới gọi được (chặn trang web khác dùng ké).
// - Giới hạn số lượt hỏi mỗi phút cho mỗi địa chỉ IP.
//
// Các đường dẫn:
// - POST /        chat với GLM (Z.ai).
// - POST /image   tạo ảnh bằng Cloudflare Workers AI (cần binding AI, xem README).
// - POST /sync    đồng bộ lịch sử chat giữa các máy (cần binding D1 tên DB, xem README).
// - POST /status  kiểm tra mô hình NVIDIA nào đang trả lời được (để menu chọn mô hình hiện trạng thái).

const UPSTREAM = "https://api.z.ai/api/paas/v4/chat/completions";
const FREE_MODELS = ["glm-4.7-flash", "glm-4.5-flash", "glm-4.6v-flash"];
const VISION_MODEL = "glm-4.6v-flash"; // mô hình miễn phí duy nhất của Z.ai đọc được ảnh
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
  "deepseek-v4.1-flash": { id: "deepseek-ai/deepseek-v4.1-flash", title: "DeepSeek V4.1 Flash", think: "kwargs", vision: true },
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
