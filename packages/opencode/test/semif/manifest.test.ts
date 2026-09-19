import { describe, expect, test } from "bun:test"
import {
  CHOICES,
  MODEL,
  MODELS,
  find,
  profile,
  resolveUrl,
} from "../../src/semif/manifest"

describe("semif manifest", () => {
  test("defaults to LFM2-1.2B Q4_K_M", () => {
    expect(MODEL.id).toBe("LiquidAI/LFM2-1.2B-GGUF")
    expect(MODEL.filename).toBe("LFM2-1.2B-Q4_K_M.gguf")
    expect(MODEL.quant).toBe("Q4_K_M")
    expect(MODEL.bytes).toBe(730_893_248)
    expect(find()).toEqual(MODEL)
    expect(find("   ")).toEqual(MODEL)
  })

  test("popover choices are the default plus the two 1.5B models", () => {
    expect(CHOICES.map((entry) => entry.id)).toEqual([
      "LiquidAI/LFM2-1.2B-GGUF",
      "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
      "Qwen/Qwen2.5-1.5B",
    ])
    expect(MODELS.some((entry) => entry.id === "LiquidAI/LFM2-350M-GGUF")).toBe(true)
  })

  test("resolves aliases without silently substituting an unknown model", () => {
    expect(find("LFM2-1.2B-Q4_K_M")?.id).toBe("LiquidAI/LFM2-1.2B-GGUF")
    expect(find("LiquidAI/LFM2-350M-GGUF")?.filename).toBe("LFM2-350M-Q4_K_M.gguf")
    expect(find("deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B")?.family).toBe("deepseek_r1")
    expect(find("Qwen/Qwen2.5-1.5B")?.family).toBe("qwen")
    expect(find("Qwen/Qwen2.5-1.5B-Instruct-GGUF")?.id).toBe("Qwen/Qwen2.5-1.5B")
    expect(find("not-a-model")).toBeUndefined()
  })

  test("LFM2 profiles disable prompt cache and Qwen-family profiles enable it", () => {
    expect(profile(MODEL)).toEqual({
      family: "lfm2",
      source: "LiquidAI/LFM2-1.2B",
      revision: "Q4_K_M",
      cachePrompt: false,
    })
    expect(profile(find("Qwen/Qwen2.5-1.5B")!).cachePrompt).toBe(true)
    expect(profile(find("deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B")!).cachePrompt).toBe(true)
  })

  test("resolveUrl uses the entry URL unless a mirror is set", () => {
    expect(resolveUrl(MODEL, {})).toBe(MODEL.url)
    expect(resolveUrl(MODEL, { NEXTCODE_SEMIF_MODEL_MIRROR: "https://mirror.example/model.gguf" })).toBe(
      "https://mirror.example/model.gguf",
    )
  })
})
