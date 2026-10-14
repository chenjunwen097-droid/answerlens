"use strict";

const { callChat, errorDetails, parseJsonContent } = require("./_lib/model");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  try {
    const { imageData, mimeType, role, note } = req.body || {};
    if (
      typeof imageData !== "string" ||
      imageData.length > 7 * 1024 * 1024 ||
      !/^image\/(?:png|jpeg)$/.test(String(mimeType || "")) ||
      !["brand", "competitor", "reference"].includes(role)
    ) {
      res.status(400).json({ error: "invalid_image_input" });
      return;
    }

    const completion = await callChat({
      provider: "glm",
      role: "vision",
      maxTokens: 900,
      messages: [
        {
          role: "system",
          content:
            "你只提取图片中的可见信息。用户已明确标注素材归属，绝不根据图片内容推断归属。只返回 JSON。"
        },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${imageData}` }
            },
            {
              type: "text",
              text: `素材用途：${role}。补充说明：${String(note || "").slice(0, 300)}。返回 {"text":"","brand":"","productLine":"","summary":"","competitors":[]}`
            }
          ]
        }
      ],
      responseFormat: { type: "json_object" }
    });

    const extracted = parseJsonContent(completion.message.content);
    res.status(200).json({
      ok: true,
      role,
      extracted: {
        text: String(extracted.text || "").slice(0, 3000),
        brand: String(extracted.brand || "").slice(0, 100),
        productLine: String(extracted.productLine || "").slice(0, 300),
        summary: String(extracted.summary || "").slice(0, 1000),
        competitors: Array.isArray(extracted.competitors)
          ? extracted.competitors.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 3)
          : []
      }
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "image_extraction_failed",
        ...errorDetails(error)
      })
    );
    const configured = error.code !== "model_not_configured";
    res.status(configured ? 502 : 503).json({
      ok: false,
      error: configured ? "image_extraction_failed" : "model_not_configured",
      message: configured ? "图片识别暂时不可用。" : "多模态模型服务尚未配置。"
    });
  }
};
