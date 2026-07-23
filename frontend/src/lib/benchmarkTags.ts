/**
 * HuggingFace dataset tags arrive as machine strings like
 * `task_categories:image-classification`. This module turns them into short
 * Chinese labels suitable for customer-facing pills.
 */

/** Prefixes worth showing, in priority order. */
const PRIORITY_PREFIXES = [
  "task_categories",
  "task_ids",
  "license",
  "language",
  "size_categories",
  "modality",
  "format",
] as const;

/** Noise prefixes we never surface in the UI. */
const HIDDEN_PREFIXES = new Set([
  "annotations_creators",
  "language_creators",
  "multilinguality",
  "source_datasets",
  "pretty_name",
  "arxiv",
  "doi",
  "region",
  "library_name",
  "library",
  "config",
  "configs",
]);

const PREFIX_LABELS: Record<string, string> = {
  task_categories: "任务",
  task_ids: "任务",
  license: "许可",
  language: "语言",
  size_categories: "规模",
  modality: "模态",
  format: "格式",
};

/** Common HF tag values → Chinese. */
const VALUE_LABELS: Record<string, string> = {
  // task categories / ids
  "image-classification": "图像分类",
  "multi-class-image-classification": "多类图像分类",
  "multi-label-image-classification": "多标签图像分类",
  "object-detection": "目标检测",
  "image-segmentation": "图像分割",
  "semantic-segmentation": "语义分割",
  "instance-segmentation": "实例分割",
  "image-to-text": "图像描述",
  "text-to-image": "文生图",
  "image-to-image": "图像转换",
  "text-classification": "文本分类",
  "token-classification": "序列标注",
  "question-answering": "问答",
  "summarization": "摘要",
  "translation": "机器翻译",
  "text-generation": "文本生成",
  "fill-mask": "填空",
  "sentence-similarity": "句向量",
  "conversational": "对话",
  "feature-extraction": "特征提取",
  "zero-shot-classification": "零样本分类",
  "zero-shot-image-classification": "零样本图像分类",
  "audio-classification": "音频分类",
  "automatic-speech-recognition": "语音识别",
  "text-to-speech": "语音合成",
  "speech-to-text": "语音转文字",
  "video-classification": "视频分类",
  "tabular-classification": "表格分类",
  "tabular-regression": "表格回归",
  "time-series-forecasting": "时序预测",
  "reinforcement-learning": "强化学习",
  "other": "其他",
  // size
  "n<1K": "<1千",
  "1K<n<10K": "1千–1万",
  "10K<n<100K": "1万–10万",
  "100K<n<1M": "10万–100万",
  "1M<n<10M": "100万–1000万",
  "10M<n<100M": "1千万–1亿",
  "n>100M": ">1亿",
  // modality / format
  image: "图像",
  text: "文本",
  audio: "音频",
  video: "视频",
  tabular: "表格",
  "time-series": "时序",
  // language (ISO + common)
  en: "英语",
  zh: "中文",
  "zh-cn": "中文",
  "zh-hans": "简体中文",
  "zh-hant": "繁体中文",
  multilingual: "多语言",
  code: "代码",
  // license short forms
  mit: "MIT",
  apache: "Apache",
  "apache-2.0": "Apache 2.0",
  "cc-by-4.0": "CC BY 4.0",
  "cc-by-sa-4.0": "CC BY-SA 4.0",
  "cc0-1.0": "CC0",
  unknown: "未知许可",
  // misc
  crowdsourced: "众包标注",
  found: "公开收集",
  expert: "专家标注",
  machine: "机器标注",
};

export type FormattedTag = {
  /** Original HF string, e.g. task_categories:image-classification */
  raw: string;
  /** Short Chinese (or humanized) label for the pill */
  label: string;
  /** Optional category hint for tooltip */
  category?: string;
};

function humanize(value: string): string {
  const key = value.trim().toLowerCase();
  if (VALUE_LABELS[key]) return VALUE_LABELS[key];
  // strip common noise suffixes and turn kebab/snake into readable text
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTag(raw: string): { prefix: string | null; value: string } {
  const idx = raw.indexOf(":");
  if (idx <= 0) return { prefix: null, value: raw.trim() };
  return {
    prefix: raw.slice(0, idx).trim().toLowerCase(),
    value: raw.slice(idx + 1).trim(),
  };
}

function scorePrefix(prefix: string | null): number {
  if (!prefix) return 50;
  if (HIDDEN_PREFIXES.has(prefix)) return -1;
  const i = (PRIORITY_PREFIXES as readonly string[]).indexOf(prefix);
  if (i >= 0) return 100 - i;
  // unknown but not hidden — keep low priority
  return 10;
}

/**
 * Convert raw HF (or manual) tags into display-ready Chinese pills.
 * Returns at most `limit` items, preferring useful categories.
 */
export function formatBenchmarkTags(tags: string[] | null | undefined, limit = 3): FormattedTag[] {
  if (!tags?.length) return [];

  const seen = new Set<string>();
  const scored: { score: number; tag: FormattedTag }[] = [];

  for (const raw of tags) {
    if (!raw || typeof raw !== "string") continue;
    const { prefix, value } = parseTag(raw);
    const score = scorePrefix(prefix);
    if (score < 0) continue;

    const label = humanize(value);
    if (!label) continue;
    // Dedupe by display label so task_categories + task_ids don't double up.
    const dedupeKey = label.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    scored.push({
      score,
      tag: {
        raw,
        label,
        category: prefix ? PREFIX_LABELS[prefix] : undefined,
      },
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.tag);
}

/** Source badge text for customers. */
export function formatBenchmarkSource(source: string | null | undefined): string {
  if (!source) return "未知来源";
  const s = source.toLowerCase();
  if (s === "hf" || s === "huggingface") return "HuggingFace";
  if (s === "manual") return "手动添加";
  if (s === "pwc" || s === "paperswithcode") return "Papers with Code";
  return source;
}
